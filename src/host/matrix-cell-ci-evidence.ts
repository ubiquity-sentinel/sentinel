/**
 * Cell-time CI failure evidence for a CI correction (generation 81).
 *
 * The trusted matrix cell, after every admission and reservation check and
 * before its final start-bound check, reads the failing checks of the red
 * candidate head through a read-only reader built on the cell's own scoped
 * App token (never handed to the model worker) and renders them as a fenced
 * prompt section the model port receives beside the request. Nothing is
 * persisted: the request, its digest, the reservation, the result and state
 * are unchanged.
 *
 * Collection runs only for a CI correction request (the planner's CI finding
 * first, a `checkoutBase`, no `mergeBase`) and only within the time the start
 * can spare: the window ends a full guard before the latest instant the
 * session still fits, so collecting can never turn into a `not_started`
 * refusal. Any failure (permission, rate limit, timeout, expired log, size)
 * degrades to the one-line reason, and at most one plain stderr line in fixed
 * vocabulary is printed; stdout is never written.
 */
import type { GitSha } from "../contracts/brands.ts";
import {
  type Clock,
  type GitHubCooldownGateV1,
  type ModelRunRequestV1,
  portOk,
} from "../contracts/ports.ts";
import { GitHubApiClient } from "../github/client.ts";
import type { HttpTransportV1 } from "../github/http.ts";
import type { BackupCiConsumerV1 } from "../github/backup-ci-observations.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { OPERATION_MARGIN_MS } from "../repair/loop-bounds.ts";
import {
  isCiCorrectionFinding,
  trustedCheckName,
} from "../repair/ci-rejection.ts";
import {
  newCiEvidenceNonce,
  renderCiEvidence,
  renderCiEvidenceUnavailable,
} from "../repair/ci-evidence-render.ts";
import {
  CI_EVIDENCE_START_GUARD_MS,
  type CiEvidenceReaderV1,
  type CiEvidenceReasonV1,
  type CiEvidenceV1,
  emptyCiEvidence,
  MAX_CI_EVIDENCE_COLLECTION_MS,
  MIN_CI_EVIDENCE_COLLECTION_MS,
} from "../repair/ci-evidence-types.ts";

/**
 * The matrix cell's read-only evidence reader for one target, on the cell's
 * own scoped App token and behind the same durable cooldown check as its
 * other reads. A cell writes no state, so an observed rate limit is settled
 * without a record: the reader then sees it typed and stops asking.
 */
export function cellCiEvidenceReader(input: {
  repository: RepositoryIdentityV1;
  http: HttpTransportV1;
  clock: Clock;
  token: string;
  gate: GitHubCooldownGateV1;
  /** Backup CI receipts as the evidence of a red stand-in (spec §11.7). */
  backupCi?: BackupCiConsumerV1;
}): CiEvidenceReaderV1 {
  const { gate, token } = input;
  return new GitHubApiClient({
    ...(input.backupCi === undefined ? {} : { backupCi: input.backupCi }),
    repository: input.repository,
    apiBaseUrl: "https://api.github.com",
    http: input.http,
    clock: input.clock,
    auth: {
      authorizationHeader: () => Promise.resolve(portOk(`Bearer ${token}`)),
    },
    cooldownGate: {
      beforeRequest: (scope) => gate.beforeRequest(scope),
      recordRateLimit: () => Promise.resolve(portOk(undefined)),
    },
  });
}

/** Grace past the reader's own deadline before the cell stops waiting. */
const COLLECTION_GRACE_MS = 1_000;

/** The red candidate head of a CI correction request, else null. */
export function ciCorrectionHead(request: ModelRunRequestV1): GitSha | null {
  const first = request.reviewFindings?.[0];
  if (first === undefined || !isCiCorrectionFinding(first)) return null;
  if (request.checkoutBase === undefined || request.mergeBase !== undefined) {
    return null;
  }
  return request.checkoutBase;
}

/**
 * Milliseconds the cell may spend collecting at `now` without moving its
 * start past what the final start-bound check accepts, less a full guard.
 */
export function ciEvidenceWindowMs(
  now: number,
  bounds: { runDeadline: number; modelCutoff: number },
  sessionBound: RepositoryConfigV1["sessionBound"],
  capMs = MAX_CI_EVIDENCE_COLLECTION_MS,
): number {
  if (sessionBound === null) return 0;
  const slack = Math.min(
    bounds.runDeadline - now - sessionBound.maxDurationMs -
      OPERATION_MARGIN_MS,
    bounds.modelCutoff - now,
  ) - CI_EVIDENCE_START_GUARD_MS;
  if (!Number.isFinite(slack)) return 0;
  return Math.max(0, Math.min(capMs, slack));
}

function diagnosticLine(
  reason: CiEvidenceReasonV1,
  repository: RepositoryIdentityV1,
): string {
  const slug = `${repository.owner}/${repository.name}`;
  return `sentinel ci-evidence: ${reason} ${slug}${
    reason === "forbidden_actions_read"
      ? " (grant actions:read to the matrix_cell App token)"
      : ""
  }`;
}

export interface CellCiEvidenceInputV1 {
  reader: CiEvidenceReaderV1 | undefined;
  request: ModelRunRequestV1;
  /** The cell's trusted repository identity (from the grant). */
  repository: RepositoryIdentityV1;
  now: number;
  bounds: { runDeadline: number; modelCutoff: number };
  sessionBound: RepositoryConfigV1["sessionBound"];
  /** Collection cap; defaults to `MAX_CI_EVIDENCE_COLLECTION_MS`. */
  collectionCapMs?: number;
  /** The one plain diagnostic line; defaults to stderr. */
  diagnostic?: (line: string) => void;
}

/**
 * The rendered evidence section for a CI correction, or undefined for any
 * other request (or when no reader is composed). Never throws.
 */
export async function prepareCellCiEvidence(
  input: CellCiEvidenceInputV1,
): Promise<string | undefined> {
  const head = ciCorrectionHead(input.request);
  if (head === null || input.reader === undefined) return undefined;
  const report = (reason: CiEvidenceReasonV1) => {
    try {
      (input.diagnostic ?? ((line: string) => console.error(line)))(
        diagnosticLine(reason, input.repository),
      );
    } catch {
      // A diagnostic sink failure never affects the cell.
    }
  };
  const cap = input.collectionCapMs ?? MAX_CI_EVIDENCE_COLLECTION_MS;
  const windowMs = ciEvidenceWindowMs(
    input.now,
    input.bounds,
    input.sessionBound,
    cap,
  );
  if (windowMs < Math.min(MIN_CI_EVIDENCE_COLLECTION_MS, cap)) {
    report("no_time");
    return renderCiEvidenceUnavailable("no_time");
  }
  const finding = input.request.reviewFindings?.[0]?.message ?? "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let evidence: CiEvidenceV1;
  try {
    const read = Promise.resolve().then(() =>
      input.reader!.readCiFailureEvidence({
        head,
        base: input.request.base,
        deadlineMs: windowMs,
        prefer: (name) => finding.includes(`${trustedCheckName(name)} (`),
      })
    );
    read.catch(() => {});
    const stop = new Promise<CiEvidenceV1>((resolve) => {
      timer = setTimeout(
        () => resolve(emptyCiEvidence(head, input.request.base, "timeout")),
        windowMs + COLLECTION_GRACE_MS,
      );
    });
    evidence = await Promise.race([read, stop]);
  } catch {
    evidence = emptyCiEvidence(head, input.request.base, "unavailable");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const reason = evidence.unavailable ??
    evidence.checks.find((check) => check.unavailable !== null)?.unavailable ??
    null;
  if (reason !== null) report(reason);
  try {
    return renderCiEvidence(evidence, newCiEvidenceNonce());
  } catch {
    return renderCiEvidenceUnavailable("malformed");
  }
}
