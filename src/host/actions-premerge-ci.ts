/**
 * Pre-merge CI dispatch for a target whose CI never runs on a Sentinel pull
 * request by itself. `ubiquity/ai.ubq.fi` (2026-10-21 Actions-quota decision)
 * runs `Gateway CI` only on a closed pull request or a manual
 * `workflow_dispatch`; its dispatch inputs opt a Sentinel App pull request
 * into the complete pre-merge check set. Sentinel refuses to review or merge
 * without current-head CI, so this trusted host step asks the target's own
 * workflow to test the exact published head once per pass.
 *
 * Invariants:
 * - A dispatch is a REQUEST for evidence, never evidence: nothing here reads
 *   or writes repair state records, counters, waits or receipts. The ordinary
 *   delivery gate keeps reading the check runs of the exact head.
 * - Exact binding before the one POST: the live pull request must be open,
 *   authored by the trusted App login, on the target's own repository, with
 *   the recorded head SHA, head ref and configured base branch.
 * - One dispatch per target per pass, and never a duplicate: any run of the
 *   workflow already bound to the exact head (any event, any status) skips
 *   the pull request; a dispatch refusal ends the pass.
 * - Token-to-repository binding: the mint grant of the dispatching token must
 *   name the target repository and carry `actions: write`.
 * - `workflow_dispatch` takes a ref, not a SHA, so the head verified here can
 *   move before GitHub resolves the ref. A run on another SHA is harmless to
 *   correctness (evidence is keyed by exact head); the confirming read is
 *   keyed by that head, so it is reported as `pending_visibility`, and it is
 *   never retried in the same pass.
 * - Every GitHub read/write passes the shared cooldown gate first and stops at
 *   the absolute run deadline.
 *
 * Base evidence (2026-10-24): the CI-first gate attributes a red head check
 * by the same-name check on the record's base, but `Gateway CI` on a closed
 * pull request reports on the PR head, so a `development` merge commit has no
 * check run and every red gateway head stays `unattributed` until the
 * pre-review bound parks it. When no head needs a dispatch this pass, the
 * pass's one dispatch may instead go to the base branch for a bound head that
 * already has a run, when the record base is the live pull request base and
 * that base has no run of the workflow (any event, any status) and is still
 * the base branch tip; its `scope_base` is the base itself, an empty
 * changed-path scope the gateway runs as everything (a first-parent scope
 * would report `success` for gates it never ran), and an unreadable tip
 * skips it. The same request-only, binding, grant, gate and deadline rules
 * apply; a base ref that moved first yields a run on another SHA, which is
 * reported as `pending_visibility` and never retried in the pass. Like-for-like
 * attribution of `docs` and `verify-artifact`, which a full-scope run still
 * skips, also needs the owner's ai.ubq.fi change tracked in Sentinel issue
 * #181; until then a head check the base run skips stays unattributed exactly
 * as before.
 */
import type { Clock, GitHubCooldownGateV1 } from "../contracts/ports.ts";
import type { StateReadView } from "../contracts/ports-state.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { isGitSha } from "../contracts/brands.ts";
import type { HttpResponseV1, HttpTransportV1 } from "../github/http.ts";
import { classifyGitHubRateLimit } from "../github/rate-limit.ts";
import { CI_PRE_REVIEW_PENDING_PREFIX } from "../repair/ci-first-policy.ts";
import { parseHostedAppMintGrant } from "./hosted-app-grant.ts";
import { premergeCiPolicyV1 } from "./target-policy.ts";

export interface PremergeCiDepsV1 {
  http: HttpTransportV1;
  clock: Clock;
  state: StateReadView;
  gate: GitHubCooldownGateV1;
  /** The target-scoped installation token that performs the dispatch. */
  token: string;
  /** Verbatim mint grant of `token`; absent or unverifiable refuses. */
  mintGrant: string | undefined;
  /** The live installation id the grant must name. */
  installationId: number;
  /** Login that authors Sentinel-owned pull requests. */
  trustedAuthor: string;
  /** Absolute run deadline; no request starts at or after it. */
  deadline: number;
  apiBaseUrl?: string;
  log?: (line: Record<string, unknown>) => void;
}

export interface PremergeCiReportV1 {
  repository: string;
  decision:
    | "no_policy"
    | "deadline"
    | "grant_refused"
    | "state_unavailable"
    | "cooldown"
    | "rate_limited"
    | "nothing_pending"
    | "dispatched"
    | "base_dispatched"
    | "dispatch_refused";
  /**
   * The pull request the single dispatch targeted (its head, or the base it
   * requested evidence for), when one was sent.
   */
  pr: number | null;
  /**
   * Per-record decisions, in pull request order; base-evidence decisions
   * (`<pr>:base_*`) follow the head decisions.
   */
  decisions: string[];
}

/** Minimum remaining run time for the bounded read/dispatch sequence. */
export const PREMERGE_CI_MARGIN_MS = 60_000;

type Row = Record<string, unknown>;

/**
 * Why a request was not answered by GitHub: the run deadline (issue #199),
 * a cooldown refusal of the gate, or a rate limit GitHub just answered and
 * the gate recorded (issue #198). Each ends the pass.
 */
type Stop = "deadline" | "refused" | "rate_limited";

function isStop(value: unknown): value is Stop {
  return value === "deadline" || value === "refused" ||
    value === "rate_limited";
}

function row(value: unknown): Row | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Row
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Parsed JSON, or undefined for a body that is not JSON. */
function json(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText);
  } catch {
    return undefined;
  }
}

function slugOf(config: RepositoryConfigV1): string {
  return `${config.repository.owner}/${config.repository.name}`;
}

/**
 * A head the pre-review gate parked because its CI did not finish within the
 * bound (#204). On a target whose CI only runs when dispatched, a head that
 * never got a run there is otherwise never dispatched again (the selector
 * read only unblocked `ci_pending` waits) and the launcher's green rule never
 * sees a green head, so it stays parked until the base moves. Dispatching it
 * once (the dispatcher still skips a head that has any run) lets the
 * ordinary green re-admission take it back, uncharged.
 */
function pendingCiParked(record: WorkRecordV1): boolean {
  return record.nextStep === "blocked" && record.wait === null &&
    record.blocker?.kind === "other" &&
    record.blocker.message.startsWith(CI_PRE_REVIEW_PENDING_PREFIX);
}

/**
 * Records whose published head waits on CI the target never starts itself:
 * live `ci_pending` waits first, then pending-CI parks, each by pull request.
 */
export function pendingPremergeRecords(
  work: readonly WorkRecordV1[],
  config: RepositoryConfigV1,
): WorkRecordV1[] {
  const waiting = (record: WorkRecordV1) =>
    record.blocker === null &&
    (record.nextStep === "work" || record.nextStep === "delivery") &&
    record.wait?.reason === "ci_pending";
  return work
    .filter((record) =>
      record.repository.owner === config.repository.owner &&
      record.repository.name === config.repository.name &&
      record.source.kind === "issue" &&
      record.intent === null &&
      (waiting(record) || pendingCiParked(record)) &&
      record.target.pr !== null && record.target.head !== null &&
      record.target.branch !== null
    )
    .sort((left, right) =>
      Number(pendingCiParked(left)) - Number(pendingCiParked(right)) ||
      left.target.pr! - right.target.pr!
    );
}

export async function dispatchPremergeCi(
  deps: PremergeCiDepsV1,
  config: RepositoryConfigV1,
): Promise<PremergeCiReportV1> {
  const repository = slugOf(config);
  const decisions: string[] = [];
  const log = (line: Record<string, unknown>) =>
    (deps.log ?? ((entry) => console.log(JSON.stringify(entry))))({
      kind: "sentinel_premerge_ci",
      repository,
      ...line,
    });
  const report = (
    decision: PremergeCiReportV1["decision"],
    pr: number | null = null,
  ): PremergeCiReportV1 => {
    log({ decision, pr, decisions });
    return { repository, decision, pr, decisions };
  };
  const policy = premergeCiPolicyV1(config.repository);
  if (policy === null) return report("no_policy");
  const withinDeadline = () =>
    deps.clock.now() + PREMERGE_CI_MARGIN_MS < deps.deadline;
  if (!withinDeadline()) return report("deadline");
  const grant = parseHostedAppMintGrant(
    deps.mintGrant,
    deps.clock.now(),
    deps.installationId,
  );
  if (
    grant === null || grant.permissions.actions !== "write" ||
    grant.repositoryNames === undefined ||
    !grant.repositoryNames.some((name) =>
      name.toLowerCase() === config.repository.name.toLowerCase()
    )
  ) return report("grant_refused");
  const read = await deps.state.readRepair();
  if (!read.ok || read.value.status !== "found") {
    return report("state_unavailable");
  }
  const pending = pendingPremergeRecords(read.value.snapshot.work, config);
  if (pending.length === 0) return report("nothing_pending");

  const base = deps.apiBaseUrl ?? "https://api.github.com";
  const stop = (reason: Stop) =>
    report(reason === "refused" ? "cooldown" : reason);
  const api = async (
    method: "GET" | "POST",
    path: string,
    body: Row | null,
  ): Promise<HttpResponseV1 | Stop | "transport"> => {
    if (!withinDeadline()) return "deadline";
    const admitted = await deps.gate.beforeRequest(
      config.repository.installationId,
    );
    if (!admitted.ok) return "refused";
    let response: HttpResponseV1;
    try {
      response = await deps.http({
        method,
        url: `${base}/repos/${repository}${path}`,
        headers: new Map([
          ["authorization", `Bearer ${deps.token}`],
          ["accept", "application/vnd.github+json"],
          ["x-github-api-version", "2022-11-28"],
          ...(body === null
            ? []
            : [["content-type", "application/json"] as [string, string]]),
        ]),
        body: body === null ? null : JSON.stringify(body),
      });
    } catch {
      return "transport";
    }
    // The gate contract: an observed limit is persisted before any later
    // request, and the pass ends instead of reading the next record.
    const limit = await classifyGitHubRateLimit(response, deps.clock.now());
    if (limit !== null) {
      await deps.gate.recordRateLimit(config.repository.installationId, limit);
      return "rate_limited";
    }
    return response;
  };
  /** Runs of the workflow bound to the exact SHA (any event, any status). */
  const runsOn = async (sha: string): Promise<number | null | Stop> => {
    const response = await api(
      "GET",
      `/actions/workflows/${policy.workflowFile}/runs?head_sha=${sha}&per_page=100`,
      null,
    );
    if (isStop(response)) return response;
    if (response === "transport" || response.status !== 200) return null;
    const page = row(json(response.bodyText));
    const runs = page === null ? null : page.workflow_runs;
    if (!Array.isArray(runs)) return null;
    return runs.filter((run) => row(run)?.head_sha === sha).length;
  };
  /**
   * The base branch tip, read through the branch itself: the dispatch takes
   * the branch as its ref, so it is sent only while that tip is still the
   * exact base (`moved` otherwise, so a moved branch never draws one dispatch
   * per pass for a run that lands on another SHA). Null when unreadable.
   */
  const baseTip = async (
    sha: string,
  ): Promise<"current" | "moved" | null | Stop> => {
    const response = await api("GET", `/commits/${config.baseBranch}`, null);
    if (isStop(response)) return response;
    if (response === "transport" || response.status !== 200) return null;
    const commit = row(json(response.bodyText));
    if (commit === null || !isGitSha(commit.sha)) return null;
    return commit.sha === sha ? "current" : "moved";
  };
  /**
   * The pass's one POST, then one read keyed by the exact SHA: a run there
   * confirms the request; its absence proves nothing yet (GitHub lists runs
   * after a delay) or means the ref moved first.
   */
  const dispatch = async (
    ref: string,
    sha: string,
    scopeBase: string,
  ): Promise<Stop | { refused: string } | { sent: string }> => {
    const posted = await api(
      "POST",
      `/actions/workflows/${policy.workflowFile}/dispatches`,
      {
        ref,
        inputs: {
          [policy.baseRefInput]: config.baseBranch,
          [policy.authorInput]: deps.trustedAuthor,
          [policy.scopeBaseInput]: scopeBase,
        },
      },
    );
    if (isStop(posted)) return posted;
    if (posted === "transport" || posted.status !== 204) {
      return {
        refused: posted === "transport" ? "transport" : `http_${posted.status}`,
      };
    }
    const read = await runsOn(sha);
    const confirmed = isStop(read) ? null : read;
    return {
      sent: confirmed === null
        ? "unconfirmed"
        : confirmed > 0
        ? "confirmed"
        : "pending_visibility",
    };
  };

  // Bases that may need evidence, first pull request per distinct SHA; read
  // only after every pending head has been offered the pass's dispatch.
  const bases: { pr: number; sha: string }[] = [];

  for (const record of pending) {
    const pr = record.target.pr!;
    const head = record.target.head!;
    const pull = await api("GET", `/pulls/${pr}`, null);
    if (isStop(pull)) return stop(pull);
    if (pull === "transport" || pull.status !== 200) {
      decisions.push(`${pr}:pull_unavailable`);
      continue;
    }
    let body: unknown;
    try {
      body = JSON.parse(pull.bodyText);
    } catch {
      decisions.push(`${pr}:pull_unavailable`);
      continue;
    }
    const live = row(body);
    const headRow = row(live?.head);
    const baseRow = row(live?.base);
    const baseSha = text(baseRow?.sha);
    const bound = live !== null && headRow !== null && baseRow !== null &&
      live.state === "open" && live.merged === false &&
      row(live.user)?.login === deps.trustedAuthor &&
      headRow.sha === head && headRow.ref === record.target.branch &&
      text(row(headRow.repo)?.full_name)?.toLowerCase() ===
        repository.toLowerCase() &&
      baseRow.ref === config.baseBranch && baseSha !== null;
    if (!bound) {
      decisions.push(`${pr}:pull_mismatch`);
      continue;
    }
    const existing = await runsOn(head);
    if (isStop(existing)) return stop(existing);
    if (existing === null) {
      decisions.push(`${pr}:runs_unreadable`);
      continue;
    }
    if (existing > 0) {
      decisions.push(`${pr}:run_exists`);
      // The gate reads the record's base; evidence for any other SHA would
      // not attribute this head.
      if (record.target.base !== baseSha) {
        decisions.push(`${pr}:base_stale`);
      } else if (!bases.some((entry) => entry.sha === baseSha)) {
        bases.push({ pr, sha: baseSha });
      }
      continue;
    }
    const sent = await dispatch(record.target.branch!, head, baseSha);
    if (isStop(sent)) return stop(sent);
    if ("refused" in sent) {
      decisions.push(`${pr}:dispatch_refused:${sent.refused}`);
      return report("dispatch_refused", pr);
    }
    decisions.push(`${pr}:dispatched:${sent.sent}`);
    return report("dispatched", pr);
  }
  for (const { pr, sha } of bases) {
    const existing = await runsOn(sha);
    if (isStop(existing)) return stop(existing);
    if (existing === null) {
      decisions.push(`${pr}:base_runs_unreadable`);
      continue;
    }
    if (existing > 0) {
      decisions.push(`${pr}:base_run_exists`);
      continue;
    }
    const tip = await baseTip(sha);
    if (isStop(tip)) return stop(tip);
    if (tip === "moved") {
      decisions.push(`${pr}:base_moved`);
      continue;
    }
    if (tip === null) {
      decisions.push(`${pr}:base_tip_unreadable`);
      continue;
    }
    // `scope_base` is the base itself: an empty changed-path scope, which the
    // gateway's test scope runs as everything (`runAll`). A scoped base run
    // would report `success` for gates it never exercised and blame a
    // pre-existing base failure on the candidate.
    const sent = await dispatch(config.baseBranch, sha, sha);
    if (isStop(sent)) return stop(sent);
    if ("refused" in sent) {
      decisions.push(`${pr}:base_dispatch_refused:${sent.refused}`);
      return report("dispatch_refused", pr);
    }
    decisions.push(`${pr}:base_dispatched:${sent.sent}`);
    return report("base_dispatched", pr);
  }
  return report("nothing_pending");
}
