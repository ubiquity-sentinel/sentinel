/** Hosted actions-candidates-legacy responsibility. */
import type { GitSha, WorkItemId } from "../contracts/brands.ts";
import type {
  LegacyBaseRefreshLossProofV1,
  PortResultV1,
  StateReadResultV1,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { hasCandidateState } from "../contracts/work-record.ts";
import { baseRefreshIntentKey, candidateBranch } from "../repair/keys.ts";
import { DenoReplayRuntime } from "../replay/runtime.ts";
import { githubGitAuthEnv } from "./local.ts";
import {
  eligibleSourceIssue,
  exactOwnedPullRequest,
  historicalCorrectionReview,
  STATIC_LOSS_BINDING,
  STATIC_LOSS_DRIFT,
  STATIC_LOSS_INPUT,
  STATIC_LOSS_LOCAL,
  STATIC_LOSS_PR,
  STATIC_LOSS_PRESENT,
  STATIC_LOSS_REF,
  STATIC_LOSS_REVIEW,
  STATIC_LOSS_SOURCE,
} from "./actions-candidates-legacy-bindings.ts";
import type {
  ActionsLegacyLossProverInputV1,
  LegacyBaseRefreshLossProverV1,
} from "./actions-candidates-legacy-bindings.ts";
import {
  GIT_MAX_OUTPUT_BYTES,
  GIT_TIMEOUT_MS,
  sameRepository,
  SELF_REPOSITORY,
} from "./actions-candidates-shared.ts";
import type { PreserverGitRunV1 } from "./actions-candidates-objects.ts";
import { legacyLossAbsenceProof } from "./actions-candidates-legacy-proof.ts";

/**
 * Trusted legacy candidate-loss prover.
 *
 * It reads the exact durable state FIRST and returns an explicit `null` when
 * the unique self-scope record for the task is not the covered legacy shape
 * (new-format candidate state, another intent, prepared refresh, ineligible
 * lifecycle). For the covered shape every later unprovable identity is a typed
 * refusal — never a null absence: the exact target/intent binding, a
 * deterministic task branch, all recorded dependencies done, exactly one
 * submitted implementation/retry reservation at the current attempt bound to
 * the task/repository/B0, scoped local absence (ONLY `not_found`; a loadable
 * candidate is an explicit null, other errors pass through), the open eligible
 * source issue read through the same (later scope-wrapped) port, the exact task
 * branch and owned open PR at the predecessor H0 != H1, the historical
 * completed H0/B0 correction review, a fresh empty-store proof that H1 is
 * absent as both a commit and an object, and finally re-observed issue/branch/
 * PR, local absence and an UNMOVED authoritative state head. The returned proof
 * is bound to `StateReadResultV1.head`, never `snapshot.stateHead`. No push,
 * code execution, candidate validation, model, review or state write occurs.
 */
export function createLegacyBaseRefreshLossProver(
  input: ActionsLegacyLossProverInputV1,
): LegacyBaseRefreshLossProverV1 {
  const repository = input.repository ?? SELF_REPOSITORY;
  const remoteUrl = input.remoteUrl ??
    `https://github.com/${repository.owner}/${repository.name}.git`;
  const runtime = input.runtime ?? new DenoReplayRuntime(input.trustedPath);
  const runGit: PreserverGitRunV1 = async (cwd, args, credentials) => {
    let result;
    try {
      result = await runtime.run({
        executable: input.gitExecutable,
        args: ["-c", "core.hooksPath=/dev/null", ...args],
        cwd,
        env: {
          PATH: input.trustedPath,
          HOME: input.scratch,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          ...(credentials ? githubGitAuthEnv(input.token, remoteUrl) : {}),
        },
        maxDurationMs: GIT_TIMEOUT_MS,
        maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
      });
    } catch {
      // A runtime throw leaves settlement unproven: it is carried as a null
      // (unsettled) result instead of being discarded as a plain failure.
      return null;
    }
    return {
      code: result.exitCode ?? 1,
      stdout: result.outcome === "exited"
        ? new TextDecoder().decode(result.stdout)
        : "",
      settled: result.settled,
      truncated: result.truncated,
      exited: result.outcome === "exited",
    };
  };

  return async (
    taskId: WorkItemId,
  ): Promise<PortResultV1<LegacyBaseRefreshLossProofV1 | null>> => {
    if (typeof taskId !== "string" || taskId.length === 0) {
      return portError("invalid", STATIC_LOSS_INPUT);
    }
    // 1. Exact durable state FIRST; the proof binds this read's authoritative
    //    head, never the snapshot's prior stateHead.
    let snapshot: RepairStateSnapshotV1;
    let stateHead: GitSha;
    try {
      const read: PortResultV1<StateReadResultV1<RepairStateSnapshotV1>> =
        await input.state.readRepair();
      if (!read.ok) return portError("unavailable", STATIC_LOSS_BINDING);
      if (read.value.status !== "found") {
        return portError("unavailable", STATIC_LOSS_BINDING);
      }
      snapshot = read.value.snapshot;
      stateHead = read.value.head;
    } catch {
      return portError("unavailable", STATIC_LOSS_BINDING);
    }
    // 2. Exactly one self-scope record for this task; absence is not a loss
    //    case and is never inferred from an error.
    const matches = snapshot.work.filter((work) =>
      sameRepository(work.repository, repository) && work.id === taskId
    );
    if (matches.length === 0) return portOk(null);
    if (matches.length !== 1) {
      return portError("unavailable", STATIC_LOSS_BINDING);
    }
    const record = matches[0]!;
    // 3. New-format/present candidate state and every non-legacy intent are
    //    outside this bridge: an explicit "not a legacy-loss case".
    if (hasCandidateState(record)) return portOk(null);
    const intent = record.intent;
    if (
      intent === null || intent.kind !== "base_refresh" ||
      intent.resultId !== null
    ) {
      return portOk(null);
    }
    // 4. From here the record claims the covered legacy base-refresh shape:
    //    every unprovable input is a typed refusal, never a null absence.
    const issueNumber = record.related.issueNumber;
    if (
      record.source.kind !== "issue" || issueNumber === null ||
      record.related.incidentId !== null ||
      record.source.id !== String(issueNumber)
    ) {
      return portError("unavailable", STATIC_LOSS_BINDING);
    }
    if (
      record.nextStep !== "work" &&
      !(record.nextStep === "blocked" &&
        record.blocker?.kind === "missing_evidence")
    ) {
      return portOk(null);
    }
    const base = record.target.base;
    const lostHead = record.target.head;
    const branch = record.target.branch;
    const pr = record.target.pr;
    const observedBase = intent.observedBase;
    if (
      lostHead === null || branch === null || pr === null ||
      observedBase === null
    ) {
      return portError("unavailable", STATIC_LOSS_BINDING);
    }
    if (
      branch !== candidateBranch(record.id) ||
      intent.requestId !== null ||
      intent.expectedHead !== lostHead ||
      intent.branch !== branch || intent.pr !== pr ||
      intent.key !== baseRefreshIntentKey(pr, lostHead, observedBase)
    ) {
      return portError("unavailable", STATIC_LOSS_BINDING);
    }
    // 5. Every recorded dependency must exist exactly once and be done.
    for (const dependency of record.dependencies) {
      const found = snapshot.work.filter((work) => work.id === dependency);
      if (found.length !== 1 || found[0]!.nextStep !== "done") {
        return portError("unavailable", STATIC_LOSS_BINDING);
      }
    }
    // 6. Exactly one submitted implementation/retry reservation for the
    //    current attempt bound to the task, the full repository and B0. No
    //    spare attempt is required: loss can be recorded even when none
    //    remains.
    const reservations = snapshot.reservations.filter((entry) =>
      entry.taskId === record.id &&
      sameRepository(entry.repository, record.repository) &&
      entry.attempt === record.counters.attempts &&
      (entry.purpose === "implementation" || entry.purpose === "retry") &&
      entry.head === base &&
      entry.outcome === "submitted"
    );
    if (reservations.length !== 1) {
      return portError("unavailable", STATIC_LOSS_BINDING);
    }
    // 7. Scoped local availability BEFORE the expensive proof: a loadable
    //    candidate is not a loss, and ONLY `not_found` proves absence.
    let local: PortResultV1<void>;
    try {
      local = await input.ensureLocalCandidate(taskId, lostHead);
    } catch {
      return portError("unavailable", STATIC_LOSS_LOCAL);
    }
    if (local.ok) return portOk(null);
    if (local.error.kind !== "not_found") return local;
    // 8. The exact source issue through the SAME port, resolved at invocation
    //    so the later scope wrapper remains authoritative.
    const issue = await input.port.readIssue(issueNumber);
    if (!issue.ok) return issue;
    if (issue.value === null) {
      return portError("unavailable", STATIC_LOSS_SOURCE);
    }
    const issueCheck = eligibleSourceIssue(issue.value, issueNumber);
    if (!issueCheck.ok) return issueCheck;
    // 9. The exact task branch at the predecessor head H0 != H1.
    const ref = `refs/heads/${branch}`;
    const branchRead = await input.port.readRef(ref);
    if (!branchRead.ok) return branchRead;
    if (branchRead.value === null) {
      return portError("unavailable", STATIC_LOSS_REF);
    }
    const predecessor = branchRead.value.sha;
    if (predecessor === lostHead) {
      // Exact remote presence is not loss. The ordinary refresh consumer must
      // still restore and validate the candidate through its normal gates.
      return portOk(null);
    }
    // 10. The exact owned open PR on that same predecessor head. The PR's
    //     current base SHA is deliberately NOT required to equal B0.
    const pullRead = await input.port.readPullRequest(pr);
    if (!pullRead.ok) return pullRead;
    if (pullRead.value === null) {
      return portError("unavailable", STATIC_LOSS_PR);
    }
    const pullCheck = exactOwnedPullRequest(pullRead.value, {
      pr,
      predecessor,
      branch,
      baseBranch: input.baseBranch,
      trustedPrAuthor: input.trustedPrAuthor,
    });
    if (!pullCheck.ok) return pullCheck;
    // 11. The historical completed H0 correction review bound to B0.
    const review = historicalCorrectionReview(
      snapshot.reviews,
      record.repository,
      pr,
      predecessor,
      base,
      input.port.reviewerIdentity,
    );
    if (review === null) {
      return portError("unavailable", STATIC_LOSS_REVIEW);
    }
    // 12. Read-only fresh-store absence proof for the exact branch.
    const proved = await legacyLossAbsenceProof({
      runGit,
      gate: input.gate,
      installationId: repository.installationId,
      remoteUrl,
      branch,
      base,
      lost: lostHead,
      predecessor,
      scratch: input.scratch,
    });
    if (!proved.ok) return proved;
    // 13. Re-observe every external identity after the proof: any movement
    //     refuses, retaining the same predecessor and eligibility.
    const issueAfter = await input.port.readIssue(issueNumber);
    if (!issueAfter.ok) return issueAfter;
    if (issueAfter.value === null) {
      return portError("unavailable", STATIC_LOSS_SOURCE);
    }
    const issueAfterCheck = eligibleSourceIssue(issueAfter.value, issueNumber);
    if (!issueAfterCheck.ok) return issueAfterCheck;
    const branchAfter = await input.port.readRef(ref);
    if (!branchAfter.ok) return branchAfter;
    if (branchAfter.value === null || branchAfter.value.sha !== predecessor) {
      return portError("conflict", STATIC_LOSS_REF);
    }
    const pullAfter = await input.port.readPullRequest(pr);
    if (!pullAfter.ok) return pullAfter;
    if (pullAfter.value === null) {
      return portError("unavailable", STATIC_LOSS_PR);
    }
    const pullAfterCheck = exactOwnedPullRequest(pullAfter.value, {
      pr,
      predecessor,
      branch,
      baseBranch: input.baseBranch,
      trustedPrAuthor: input.trustedPrAuthor,
    });
    if (!pullAfterCheck.ok) return pullAfterCheck;
    // 14. The scoped local absence must still hold.
    let localAfter: PortResultV1<void>;
    try {
      localAfter = await input.ensureLocalCandidate(taskId, lostHead);
    } catch {
      return portError("unavailable", STATIC_LOSS_LOCAL);
    }
    if (localAfter.ok) return portError("conflict", STATIC_LOSS_PRESENT);
    if (localAfter.error.kind !== "not_found") return localAfter;
    // 15. The durable state head must not have moved since the first read.
    let confirmHead: GitSha;
    try {
      const read = await input.state.readRepair();
      if (!read.ok || read.value.status !== "found") {
        return portError("unavailable", STATIC_LOSS_DRIFT);
      }
      confirmHead = read.value.head;
    } catch {
      return portError("unavailable", STATIC_LOSS_DRIFT);
    }
    if (confirmHead !== stateHead) {
      return portError("conflict", STATIC_LOSS_DRIFT);
    }
    return portOk({
      taskId: record.id,
      repository: { ...record.repository },
      stateHead,
      shape: "legacy_base_refresh",
      lostBase: base,
      lostHead,
      predecessorHead: predecessor,
      branch,
      pr,
      intentKey: intent.key,
      reviewId: review.id,
    });
  };
}
