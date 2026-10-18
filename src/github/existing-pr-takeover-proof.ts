/** Opaque operation-scoped authority from authenticated state, native facts and Git custody. */
import { isGitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type {
  ExistingPrTakeoverPort,
  NativeTakeoverObservation,
  TakeoverCandidateObservation,
  TakeoverCustodyProof,
  TakeoverPrincipalAuthority,
  TakeoverProofRequest,
} from "../contracts/existing-pr-takeover.ts";
import {
  type Clock,
  portError,
  portOk,
  type PortResultV1,
  type StateReadView,
} from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { parseRepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import {
  EXISTING_PR_TAKEOVER_POLICY,
  type ExistingPrTakeoverPolicy,
} from "./existing-pr-takeover-policy.ts";
import {
  readTakeoverAnchor,
  type TakeoverAnchor,
  takeoverBindingDigest,
} from "./existing-pr-takeover-provenance.ts";
import {
  revalidateTakeoverPrincipal,
  takeoverPrincipalBinding,
} from "./existing-pr-takeover-effect.ts";

const OPERATIONS = new Set([
  "correct",
  "preserve_successor",
  "publish",
  "review",
  "refresh",
  "merge",
  "enqueue",
]);
const MAX_PROOF_AGE_MS = 30_000;
const equal = (a: unknown, b: unknown) =>
  canonicalStringify(a) === canonicalStringify(b);
const refused = (): PortResultV1<never> =>
  portError(
    "unavailable",
    "existing pull request takeover custody unavailable",
  );

export interface TakeoverProofDependencies {
  state: Pick<StateReadView, "readRepair" | "readRepairAt">;
  clock: Clock;
  repository: RepositoryIdentityV1;
  baseBranch: string;
  policy?: ExistingPrTakeoverPolicy;
  /** Trusted installed-source fence, independent of queue mode/occupancy. */
  runtimeCapabilityAccepted(): boolean;
  principal?: TakeoverPrincipalAuthority;
  readNative(
    input: TakeoverProofRequest,
  ): Promise<PortResultV1<NativeTakeoverObservation>>;
  readCandidate(
    input: TakeoverProofRequest & { anchor: TakeoverAnchor },
  ): Promise<PortResultV1<TakeoverCandidateObservation>>;
}

/** No public mint/structural cast can create a recognized proof. Fact readers are trusted ports. */
export function createTakeoverProofPort(
  deps: TakeoverProofDependencies,
): Pick<ExistingPrTakeoverPort, "resolve" | "authorizeEffect"> {
  const policy = deps.policy ?? EXISTING_PR_TAKEOVER_POLICY;
  const proofs = new WeakMap<object, { request: string; expires: number }>();
  const live = (input: TakeoverProofRequest): boolean =>
    policy.activated === true && deps.runtimeCapabilityAccepted() === true &&
    Number.isSafeInteger(input.deadline) && deps.clock.now() < input.deadline;

  const verify = async (input: TakeoverProofRequest): Promise<boolean> => {
    try {
      if (!live(input) || !requestShape(input)) return false;
      const principal = takeoverPrincipalBinding(input);
      if (
        principal === null ||
        !(await revalidateTakeoverPrincipal(deps.principal, principal)).ok ||
        !live(input)
      ) return false;
      const before = await deps.state.readRepair();
      if (
        !live(input) || !before.ok || before.value.status !== "found" ||
        before.value.head !== input.expectedStateHead ||
        !equal(
          parseRepairStateSnapshotV1(before.value.snapshot),
          input.snapshot,
        ) ||
        !equal(
          input.snapshot.work.find((row) => row.id === input.record.id) ?? null,
          input.record,
        )
      ) return false;
      const anchor = await readTakeoverAnchor({ ...input, state: deps.state });
      if (anchor === null || !live(input)) return false;
      const observed = await deps.readNative(input);
      if (!observed.ok || !live(input)) return false;
      const native = structuredClone(observed.value);
      const binding = native.binding;
      if (
        native.state !== "open" || native.issueOpen !== true ||
        native.associationComplete !== true ||
        native.associated !== true || native.reciprocalComplete !== true ||
        !Array.isArray(native.reciprocalIssues) ||
        native.reciprocalIssues.filter((issue) =>
            issue.nodeId === binding.issueNodeId &&
            issue.number === binding.issueNumber &&
            equal(issue.repository, binding.headRepository)
          ).length !== 1 ||
        native.headRefExists !== true ||
        native.sameRepository !== true ||
        native.writableBranch !== true || native.protectedPathsClear !== true ||
        native.queueCustodyClear !== true ||
        native.head !== input.expectedHead ||
        (!(input.operation === "refresh" && isGitSha(input.nextHead) &&
          input.record.intent?.resultId === input.nextHead) &&
          native.base !== (input.observedBase ?? input.record.target.base)) ||
        input.snapshot.work.some((other) =>
          other.id !== input.record.id &&
          other.target.pr === input.record.target.pr &&
          equal(other.repository, input.record.repository)
        ) ||
        binding.taskId !== input.record.id ||
        (input.taskDigest !== undefined &&
          input.taskDigest !== binding.issueDigest) ||
        binding.baseRef !== deps.baseBranch ||
        !equal(binding.repository, deps.repository) ||
        binding.issueNumber !== input.record.related.issueNumber ||
        binding.pullRequest !== input.record.target.pr ||
        binding.headRef !== input.record.target.branch ||
        !equal(binding.repository, input.record.repository) ||
        !Array.isArray(native.openCandidates) ||
        native.openCandidates.length !== 1 ||
        native.openCandidates[0].number !== binding.pullRequest ||
        native.openCandidates[0].nodeId !== binding.pullNodeId ||
        await takeoverBindingDigest(binding) !== anchor.bindingDigest
      ) return false;
      const candidate = await deps.readCandidate({ ...input, anchor });
      if (!candidate.ok || !live(input)) return false;
      const facts = structuredClone(candidate.value);
      const sameNativeHead =
        input.record.target.head === anchor.record.target.head &&
        input.record.target.base === anchor.record.target.base;
      const preserved = input.record.target.candidateState?.preserved;
      const descriptor =
        preserved === null && input.operation === "preserve_successor"
          ? input.candidate
          : preserved;
      if (
        facts.anchorRef !== anchor.nativeRef ||
        facts.anchorHead !== anchor.record.target.head ||
        facts.anchorRestored !== true ||
        facts.currentHead !== input.record.target.head ||
        facts.currentBase !== input.record.target.base ||
        facts.currentDescendsFromAnchor !== true ||
        (sameNativeHead &&
          (facts.custody?.kind !== "native" || descriptor !== null)) ||
        (!sameNativeHead &&
          (facts.custody === null || facts.custody.kind === "native" ||
            descriptor === undefined ||
            descriptor === null ||
            descriptor.head !== input.record.target.head ||
            descriptor.base !== input.record.target.base ||
            !equal(facts.custody.candidate, descriptor) ||
            (facts.custody.kind === "implementation" &&
              descriptor.operationKey !==
                `impl:${facts.custody.reservationId}`) ||
            (facts.custody.kind === "base_refresh" &&
              !isGitSha(facts.custody.predecessor)))) ||
        facts.nextHead !== (input.nextHead ?? null) ||
        (input.nextHead !== undefined &&
          !(input.operation === "refresh" &&
            (input.phase ?? "prepare") === "prepare") &&
          facts.nextDescendsFromExpected !== true)
      ) return false;
      if (!(await revalidateTakeoverPrincipal(deps.principal, principal)).ok) {
        return false;
      }
      const after = await deps.state.readRepair();
      return live(input) && after.ok && after.value.status === "found" &&
        after.value.head === before.value.head &&
        equal(after.value.snapshot, before.value.snapshot);
    } catch {
      return false;
    }
  };

  return {
    async resolve(input) {
      // Clone before awaiting: later mutation of caller-owned data cannot widen a proof.
      let request: TakeoverProofRequest;
      try {
        request = structuredClone(input);
        canonicalStringify(request);
      } catch {
        return refused();
      }
      if (!await verify(request)) return refused();
      const proof: TakeoverCustodyProof = Object.freeze({
        kind: "verified_existing_pr_custody",
      });
      proofs.set(proof, {
        request: canonicalStringify(request),
        expires: Math.min(
          request.deadline,
          deps.clock.now() + MAX_PROOF_AGE_MS,
        ),
      });
      return portOk(proof);
    },
    async authorizeEffect(proof, input) {
      try {
        const saved = proofs.get(proof);
        proofs.delete(proof); // A failed/replayed authorization needs a newly resolved proof.
        if (saved === undefined || deps.clock.now() >= saved.expires) {
          return refused();
        }
        const request = structuredClone(input);
        if (
          saved.request !== canonicalStringify(request) ||
          !await verify(request)
        ) return refused();
        if (!live(request) || deps.clock.now() >= saved.expires) {
          return refused();
        }
        return portOk(undefined);
      } catch {
        return refused();
      }
    },
  };
}

/** Transient operation shapes never rewrite the persisted V1 intent. */
function requestShape(input: TakeoverProofRequest): boolean {
  const { record } = input;
  const intent = record.intent;
  if (
    !isGitSha(input.expectedStateHead) || !isGitSha(input.expectedHead) ||
    !OPERATIONS.has(input.operation) || record.nextStep === "done" ||
    record.target.head === null ||
    record.target.pr === null || record.target.branch === null ||
    input.operation !== "review" && input.taskDigest !== undefined
  ) return false;
  if (input.operation === "refresh") {
    const phase = input.phase ?? "prepare";
    if (
      !isGitSha(input.observedBase) || input.observedBase === record.target.base
    ) return false;
    // Planning may authorize only the exact intent CAS. The concrete refresh
    // boundary below separately requires its already-persisted intent.
    if (intent === null) {
      return phase === "prepare" && input.nextHead === undefined &&
        input.candidate === undefined &&
        input.expectedHead === record.target.head;
    }
    if (
      intent.kind !== "base_refresh" ||
      intent.branch !== record.target.branch ||
      intent.pr !== record.target.pr ||
      intent.expectedHead !== record.target.head ||
      intent.observedBase !== input.observedBase ||
      intent.key !==
        `base_refresh:${intent.pr}:${record.target.head}:${input.observedBase}` ||
      intent.requestId !== null
    ) return false;
    if (phase === "prepare") {
      return input.candidate === undefined &&
        (intent.resultId === null
          ? input.nextHead === undefined &&
            input.expectedHead === record.target.head
          : isGitSha(intent.resultId) && input.nextHead === intent.resultId &&
            (input.expectedHead === record.target.head ||
              input.expectedHead === intent.resultId));
    }
    return (phase === "preserve" || phase === "publish") &&
      isGitSha(intent.resultId) &&
      input.nextHead === intent.resultId &&
      input.candidate?.head === intent.resultId &&
      input.candidate.base === input.observedBase &&
      input.candidate.operationKey === intent.key &&
      (input.expectedHead === record.target.head ||
        input.expectedHead === intent.resultId);
  }
  if (input.phase !== undefined || input.observedBase !== undefined) {
    return false;
  }
  if (input.operation === "preserve_successor") {
    return intent?.kind === "candidate_preservation" &&
      record.target.candidateState?.preserved === null &&
      input.expectedHead === record.target.candidateState.publishedHead &&
      input.nextHead === record.target.head &&
      input.nextHead !== input.expectedHead &&
      input.candidate?.head === record.target.head &&
      input.candidate.base === record.target.base &&
      input.candidate.operationKey === intent.key &&
      input.candidate.ref === intent.branch;
  }
  if (input.candidate !== undefined) return false;
  return input.operation === "publish"
    ? isGitSha(input.nextHead) && input.nextHead === record.target.head &&
      (input.expectedHead === record.target.candidateState?.publishedHead ||
        input.expectedHead === input.nextHead)
    : input.nextHead === undefined && input.expectedHead === record.target.head;
}
