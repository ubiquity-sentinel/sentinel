/**
 * Preserved-candidate recovery from native ref evidence. A record the
 * historical runtime-mismatch isolation or the historical matrix custody
 * (MATRIX_PRESERVATION_UNCERTAINTY_DETAIL) parked (its exact candidate head and
 * charged implementation retained, nothing preserved yet) whose deterministic
 * sentinel-candidates preservation ref already exists at exactly that head
 * needs no matrix artifact: the head SHA already binds the content. The SAME
 * trusted preserver re-proves that existing ref in a fresh object store and
 * revalidates publication, and the SAME expected-head CAS as the artifact
 * path returns the record to `work` with its preserved descriptor. The charge
 * stays as it is; nothing is refunded, started, pushed or published here.
 */
import { isHostedReleaseTerminal } from "../src/contracts/hosted-supervisor.ts";
import type { GitSha } from "../src/contracts/brands.ts";
import { queueRecordProtected } from "./hosted-autonomy-queue-context.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import type { GitHubPort } from "../src/contracts/ports.ts";
import type { RepositoryConfigV1 } from "../src/contracts/repository-config.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import { candidatePreservationRef } from "../src/repair/keys.ts";
import {
  preserveBlockedCandidate,
  restorableParkedCandidate,
} from "./hosted-autonomy-blocked-candidate.ts";
import { CurrentMatrixRecoveryIntegrityFailure } from "./hosted-autonomy-producer-recovery.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyResultV1,
  HostedClosedMatrixDepsV1,
} from "./hosted-autonomy-types.ts";

/** No new preservation starts after this bound; the next run continues. */
const EXISTING_REF_BUDGET_MS = 180_000;
const HEADS = "refs/heads/";

export async function restoreExistingCandidateRefs(input: {
  deps: HostedAutonomyDepsV1;
  ports: HostedClosedMatrixDepsV1;
  dedicated: ReadonlySet<string>;
  /** Fixed-vocabulary outcomes, carried by the run result either way. */
  actions: string[];
}): Promise<HostedAutonomyResultV1 | null> {
  const { deps, ports, dedicated, actions } = input;
  const startedAt = deps.clock.now();
  const withinBudget = () =>
    deps.clock.now() - startedAt < EXISTING_REF_BUDGET_MS;
  const [read, release] = await Promise.all([
    deps.state.readRepair(),
    deps.state.readRelease(),
  ]);
  if (!read.ok || read.value.status !== "found") return null;
  const candidates = read.value.snapshot.work.filter((record) =>
    !queueRecordProtected(record, deps.queueCustody) &&
    restorableParkedCandidate(record) &&
    !dedicated.has(record.intent?.requestId ?? "")
  );
  if (candidates.length === 0) return null;
  // Matrix custody maintenance never runs beside an active execution or a
  // nonterminal release; that condition is a deferral, never a failure.
  if (
    !release.ok || release.value.status !== "found" ||
    release.value.snapshot.hostedRuntimes.some((row) =>
      row.execution !== null
    ) ||
    release.value.snapshot.hostedReleases.some((row) =>
      !isHostedReleaseTerminal(row.phase)
    )
  ) return null;
  const selected: { record: WorkRecordV1; config: RepositoryConfigV1 }[] = [];
  for (const record of candidates) {
    if (!withinBudget()) break;
    const ref = record.intent!.branch;
    const config = ports.configs.find((row) =>
      canonicalStringify(row.repository) ===
        canonicalStringify(record.repository)
    );
    // Only the record's own deterministic preservation ref is ever read.
    if (
      !config || ref === null || !ref.startsWith(HEADS) ||
      ref !== await candidatePreservationRef(
          record.repository,
          record.id,
          record.intent!.key,
        )
    ) continue;
    // A cheap selection read; the trusted preserver re-reads and re-proves
    // the exact ref before and after anything is written.
    let observed: string | null;
    try {
      observed = await deps.githubFor(record.repository)?.readBaseTip(
        ref.slice(HEADS.length),
      ) ?? null;
    } catch {
      observed = null;
    }
    // An absent or unreadable ref stays with artifact recovery.
    if (observed === null) continue;
    if (observed !== record.target.head) {
      actions.push(`existing-ref:${record.id}:conflict`);
      continue;
    }
    selected.push({ record, config });
  }
  const beforeHead = read.value.head;
  let restored = 0;
  const prepared = new Map<string, GitHubPort>();
  for (const { record, config } of selected) {
    if (!withinBudget()) break;
    const key = canonicalStringify(config.repository);
    try {
      let github = prepared.get(key);
      if (github === undefined) {
        await ports.prepareTarget(config);
        github = ports.cycleFor(config).github;
        prepared.set(key, github);
      }
      const done = await preserveBlockedCandidate({
        record,
        state: deps.state,
        github,
        clock: deps.clock,
        readbackFailure: (write) =>
          new CurrentMatrixRecoveryIntegrityFailure(
            "current matrix existing candidate readback changed",
            beforeHead,
            write.ok && write.value.status === "applied"
              ? write.value.head
              : null,
            write,
          ),
      });
      actions.push(
        `existing-ref:${record.id}:${
          done === "preserved" ? "preserved" : "unproven"
        }`,
      );
      if (done === "preserved") restored++;
    } catch (error) {
      // A changed readback after an applied write is an integrity fault;
      // an unavailable mirror or preserver only defers this record.
      if (error instanceof CurrentMatrixRecoveryIntegrityFailure) throw error;
      actions.push(`existing-ref:${record.id}:unavailable`);
    }
  }
  if (restored === 0) return null;
  const after = await deps.state.readRepair();
  return {
    kind: "hosted_autonomy",
    status: "applied",
    reason: "applied",
    beforeHead,
    appliedHead: after.ok && after.value.status === "found"
      ? after.value.head as GitSha
      : null,
    actions: [...actions],
    revisions: [],
  };
}
