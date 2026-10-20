/** Bookkeeping-only recovery of an original publication after a forbidden correction. */
import { canonicalStringify } from "../src/contracts/canonical.ts";
import { parseRepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import { createLocalRepositoryConfig } from "../src/host/local-config.ts";
import { selectTrustedTargetPolicyV1 } from "../src/host/target-policy.ts";
import { touchesProtected } from "../src/repair/loop-records.ts";
import { queueRecordProtected } from "./hosted-autonomy-queue-context.ts";
import { HOSTED_AUTONOMY_TRUSTED_AUTHORS } from "./hosted-autonomy-policy.ts";
import type { HostedAutonomyPassContextV1 } from "./hosted-autonomy-scopes.ts";
import { failed, skipped } from "./hosted-autonomy-state.ts";
import type { HostedAutonomyResultV1 } from "./hosted-autonomy-types.ts";
import {
  ORIGINAL_CANDIDATE_DEADLINE_MS,
  protectedOriginalCandidateShape,
  readProtectedOriginalCandidates,
} from "./hosted-autonomy-original-candidate.ts";
import type { GitSha } from "../src/contracts/brands.ts";

const same = (a: unknown, b: unknown) =>
  canonicalStringify(a) === canonicalStringify(b);

export async function runHostedOriginalCandidateRecoveryPass(
  context: HostedAutonomyPassContextV1,
): Promise<HostedAutonomyResultV1 | null> {
  const { deps, snapshot, observedHead, releaseSnapshot, actions, revisions } =
    context;
  const records = snapshot.work.filter((record) =>
    !context.settled?.has(record.id) &&
    !queueRecordProtected(record, deps.queueCustody) &&
    protectedOriginalCandidateShape(record)
  );
  if (
    records.length === 0 ||
    releaseSnapshot.hostedRuntimes.some((r) => r.execution !== null)
  ) return null;
  const started = deps.clock.now();
  if (!Number.isSafeInteger(started)) return null;
  const deadlineAt = started + ORIGINAL_CANDIDATE_DEADLINE_MS;
  const proofs = await readProtectedOriginalCandidates({
    state: deps.state,
    snapshot,
    expectedHead: observedHead as GitSha,
    records,
    clock: deps.clock,
    deadlineAt,
  });
  const restored = new Map<string, (typeof proofs)[number]>();
  for (const proof of proofs) {
    const record = proof.current;
    const original = proof.original;
    const descriptor = original.target.candidateState!.preserved!;
    try {
      if (deps.clock.now() >= deadlineAt) break;
      const scope = await context.scopeFor(record.repository);
      const port = scope.surface;
      if (
        !port || !scope.baseBranch || !port.listPullsByHeadRef ||
        !port.mergeBaseTreeChanges
      ) continue;
      if (await port.readIssueOpen(record.related.issueNumber!) !== true) {
        continue;
      }
      const head = descriptor.head;
      const branch = record.target.branch!;
      const baseTip = await port.readBaseTip(scope.baseBranch);
      if (
        baseTip === null || await port.readBaseTip(branch) !== head ||
        await port.readBaseTip(descriptor.ref.slice("refs/heads/".length)) !==
          head
      ) continue;
      const pulls = await port.listPullsByHeadRef(branch);
      const pull = await context.readPull(scope, record.target.pr!);
      if (
        !pull || pull.number !== record.target.pr || pull.state !== "open" ||
        pull.merged ||
        pull.headSha !== head || pull.baseRef !== scope.baseBranch ||
        pull.baseSha !== baseTip ||
        !HOSTED_AUTONOMY_TRUSTED_AUTHORS.includes(pull.author ?? "") ||
        pulls === null || pulls.length !== 1 ||
        pulls[0].number !== record.target.pr ||
        pulls[0].state !== "open" || pulls[0].merged ||
        pulls[0].headRef !== branch ||
        pulls[0].headSha !== head || pulls[0].baseRef !== scope.baseBranch ||
        !HOSTED_AUTONOMY_TRUSTED_AUTHORS.includes(pulls[0].author ?? "")
      ) continue;
      const patch = await port.mergeBaseTreeChanges(descriptor.base, head);
      const policy = selectTrustedTargetPolicyV1(
        createLocalRepositoryConfig(),
        record.repository,
      );
      if (
        !patch || patch.mergeBase !== descriptor.base ||
        patch.changes.length === 0 ||
        patch.changes.some((change) =>
          touchesProtected(policy.protectedPaths, change.path)
        )
      ) continue;
      if (baseTip === descriptor.base) {
        if (await port.hasAllChecksGreen(head, descriptor.base) !== true) {
          continue;
        }
      } else if (
        !port.baseAdvanced || !await port.baseAdvanced(descriptor.base, baseTip)
      ) continue;
      if (
        deps.clock.now() >= deadlineAt ||
        await port.readBaseTip(scope.baseBranch) !== baseTip ||
        await port.readBaseTip(branch) !== head ||
        await port.readBaseTip(descriptor.ref.slice("refs/heads/".length)) !==
          head
      ) continue;
      restored.set(record.id, proof);
    } catch { /* No observation failure establishes recovery authority. */ }
  }
  if (restored.size === 0) return null;
  const fresh = await deps.state.readRepair();
  const release = await deps.state.readRelease();
  if (
    !fresh.ok || fresh.value.status !== "found" ||
    fresh.value.head !== observedHead ||
    !same(fresh.value.snapshot, snapshot) || !release.ok ||
    release.value.status !== "found" ||
    !same(release.value.snapshot, releaseSnapshot)
  ) return null;
  const now = deps.clock.now();
  if (
    !Number.isSafeInteger(now) || now < snapshot.updatedAt || now >= deadlineAt
  ) return null;
  const next = parseRepairStateSnapshotV1({
    ...snapshot,
    stateHead: observedHead,
    sequence: snapshot.sequence + 1,
    updatedAt: now,
    work: snapshot.work.map((record) => {
      const proof = restored.get(record.id);
      return proof === undefined ? record : {
        ...record,
        target: {
          ...record.target,
          head: proof.original.target.head,
          checkpoint: proof.original.target.checkpoint,
          candidateState: proof.original.target.candidateState,
        },
        nextStep: "work",
        blocker: null,
        wait: null,
        intent: null,
        updatedAt: now,
      };
    }),
  });
  const write = await deps.state.writeRepair(next, observedHead as GitSha);
  if (!write.ok) return failed("write_unavailable", observedHead, actions);
  if (write.value.status === "conflict") {
    return skipped("write_conflict", observedHead, actions);
  }
  if (write.value.status === "ambiguous") {
    return failed("write_ambiguous", observedHead, actions);
  }
  const readback = await deps.state.readRepair();
  if (
    !readback.ok || readback.value.status !== "found" ||
    readback.value.head !== write.value.head ||
    !same(readback.value.snapshot, next)
  ) return failed("readback_unverified", observedHead, actions);
  for (const proof of restored.values()) {
    actions.push(
      `original-candidate:${proof.current.id}:restored:${proof.rejectedStateHead}`,
    );
  }
  return {
    kind: "hosted_autonomy",
    status: "applied",
    reason: "applied",
    beforeHead: context.initialHead,
    appliedHead: write.value.head,
    actions,
    revisions,
  };
}
