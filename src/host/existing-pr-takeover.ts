/** Trusted native discovery/preservation composition. State transitions remain with the coordinator. */
import { canonicalStringify } from "../contracts/canonical.ts";
import type {
  ExistingPrTakeoverPort,
  TakeoverCandidateCustody,
  TakeoverPrincipalAuthority,
  TakeoverProofRequest,
} from "../contracts/existing-pr-takeover.ts";
import {
  type GitHubPort,
  portError,
  portOk,
  type PortResultV1,
  type StateReadView,
} from "../contracts/ports.ts";
import { parseRepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import {
  EXISTING_PR_TAKEOVER_POLICY,
  type ExistingPrTakeoverPolicy,
} from "../github/existing-pr-takeover-policy.ts";
import { createTakeoverProofPort } from "../github/existing-pr-takeover-proof.ts";
import {
  nativeTakeoverIntentKey,
  TAKEOVER_EVIDENCE_NAMESPACE,
  TAKEOVER_NATIVE_PRESERVING,
  takeoverAnchorRef,
  takeoverBindingDigest,
  takeoverNativeRef,
} from "../github/existing-pr-takeover-provenance.ts";
import { candidatePreservationRef } from "../repair/keys.ts";
import {
  createTakeoverDiscovery,
  type TakeoverDiscoveryDependencies,
} from "./existing-pr-discovery.ts";
import {
  createNativeTakeoverGit,
  type NativeTakeoverGitInput,
} from "./existing-pr-native-git.ts";

export {
  nativeTakeoverIntentKey,
  TAKEOVER_NATIVE_PRESERVING,
} from "../github/existing-pr-takeover-provenance.ts";
import { revalidateTakeoverPrincipal } from "../github/existing-pr-takeover-effect.ts";

export interface ExistingPrTakeoverHostInput extends NativeTakeoverGitInput {
  state: Pick<StateReadView, "readRepair" | "readRepairAt">;
  client: TakeoverDiscoveryDependencies["client"];
  port: Pick<GitHubPort, "readRef" | "pushHead" | "nativeQueue">;
  baseBranch: string;
  /** Source-only test/composition policy. Production defaults to the dormant policy. */
  policy?: ExistingPrTakeoverPolicy;
  runtimeCapabilityAccepted?: () => boolean;
  contentsWriteAllowed?: () => boolean;
  principal?: TakeoverPrincipalAuthority;
  /** Actual producer state/reservation proof; descriptor syntax is insufficient. */
  verifyProducedCandidate?: (
    request: TakeoverProofRequest,
  ) => Promise<
    PortResultV1<Exclude<TakeoverCandidateCustody, { kind: "native" }> | null>
  >;
}

const same = (a: unknown, b: unknown) =>
  canonicalStringify(a) === canonicalStringify(b);
const refused = (): PortResultV1<never> =>
  portError("unavailable", "existing pull request native custody unavailable");

export function createExistingPrTakeover(
  input: ExistingPrTakeoverHostInput,
): ExistingPrTakeoverPort {
  const policy = input.policy ?? EXISTING_PR_TAKEOVER_POLICY;
  const runtimeCapabilityAccepted = input.runtimeCapabilityAccepted ??
    (() => false);
  const contentsWriteAllowed = input.contentsWriteAllowed ?? (() => false);
  const git = createNativeTakeoverGit(input);
  const discover = createTakeoverDiscovery({
    repository: input.repository,
    baseBranch: input.baseBranch,
    clock: input.clock,
    client: input.client,
    port: input.port,
    contentsWriteAllowed,
    inspectNativeGit: (pull, deadline) => git.inspect(pull, deadline),
  });
  const effectsAllowed = (deadline: number) =>
    policy.activated === true && runtimeCapabilityAccepted() === true &&
    contentsWriteAllowed() === true && Number.isSafeInteger(deadline) &&
    input.clock.now() < deadline;

  const proof = createTakeoverProofPort({
    state: input.state,
    clock: input.clock,
    repository: input.repository,
    baseBranch: input.baseBranch,
    policy,
    runtimeCapabilityAccepted,
    principal: input.principal,
    async readNative(request) {
      const found = await discover(request);
      return found.status === "candidate" ? portOk(found.candidate) : refused();
    },
    async readCandidate(request) {
      const anchor = request.anchor;
      const anchorHead = anchor.record.target.head;
      const target = request.record.target;
      if (anchorHead === null || target.head === null) return refused();
      const restored = await git.restore(
        anchor.nativeRef,
        anchorHead,
        anchor.record.target.base,
        request.deadline,
      );
      if (!restored.ok || !restored.value.protectedPathsClear) return refused();
      let custody: TakeoverCandidateCustody = { kind: "native" };
      if (
        target.head !== anchorHead || target.base !== anchor.record.target.base
      ) {
        const producer = await input.verifyProducedCandidate?.(request);
        const descriptor = target.candidateState?.preserved;
        if (
          producer?.ok !== true || producer.value === null ||
          descriptor === undefined || descriptor === null ||
          descriptor.head !== target.head || descriptor.base !== target.base ||
          descriptor.ref !== await candidatePreservationRef(
              request.record.repository,
              request.record.id,
              descriptor.operationKey,
            )
        ) return refused();
        const candidate = await git.restore(
          descriptor.ref,
          descriptor.head,
          descriptor.base,
          request.deadline,
        );
        if (!candidate.ok || !candidate.value.protectedPathsClear) {
          return refused();
        }
        custody = producer.value;
      }
      const ancestry = await git.isAncestor(
        anchorHead,
        target.head,
        request.deadline,
      );
      if (!ancestry.ok) return ancestry;
      const next = request.nextHead === undefined
        ? portOk(false)
        : await git.isAncestor(
          request.expectedHead,
          request.nextHead,
          request.deadline,
        );
      if (!next.ok) return next;
      return portOk({
        anchorRef: anchor.nativeRef,
        anchorHead,
        anchorRestored: true,
        currentHead: target.head,
        currentBase: target.base,
        custody,
        currentDescendsFromAnchor: ancestry.value,
        nextHead: request.nextHead ?? null,
        nextDescendsFromExpected: next.value,
      });
    },
  });

  return {
    get coordinationActivated() {
      return policy.activated === true;
    },
    discover,
    ...proof,
    async authorizeAdoption(request) {
      try {
        if (!effectsAllowed(request.deadline)) return refused();
        const { candidate, record } = request;
        const binding = candidate.binding;
        const before = await input.state.readRepair();
        if (
          !before.ok || before.value.status !== "found" ||
          before.value.head !== request.expectedStateHead ||
          !same(before.value.snapshot, request.snapshot) ||
          !same(
            request.snapshot.work.find((row) => row.id === record.id),
            record,
          ) ||
          !same(binding.repository, input.repository) ||
          binding.taskId !== record.id ||
          request.snapshot.work.some((other) =>
            other.id !== record.id &&
            same(other.repository, record.repository) &&
            other.target.pr === binding.pullRequest
          )
        ) return refused();
        const principalBinding = {
          repository: binding.repository,
          taskId: record.id,
          expectedStateHead: request.expectedStateHead,
          pullRequest: binding.pullRequest,
          branch: binding.headRef,
          head: candidate.head,
          base: candidate.base,
          operation: "native_preserve" as const,
          phase: "native" as const,
          nextHead: null,
          deadline: request.deadline,
        };
        const authorized = await revalidateTakeoverPrincipal(
          input.principal,
          principalBinding,
        );
        if (!authorized.ok) return authorized;
        const observed = await discover(request);
        if (
          !(await revalidateTakeoverPrincipal(
            input.principal,
            principalBinding,
          )).ok
        ) return refused();
        const after = await input.state.readRepair();
        return effectsAllowed(request.deadline) &&
            observed.status === "candidate" &&
            same(observed.candidate, candidate) && after.ok &&
            after.value.status === "found" &&
            after.value.head === request.expectedStateHead &&
            same(after.value.snapshot, request.snapshot)
          ? portOk(undefined)
          : refused();
      } catch {
        return refused();
      }
    },
    async preserveNativeHead(raw) {
      try {
        const request = structuredClone(raw);
        if (!effectsAllowed(request.deadline)) return refused();
        if (
          !same(request.binding.repository, input.repository) ||
          request.bindingDigest !==
            await takeoverBindingDigest(request.binding) ||
          request.ref !== await takeoverNativeRef({
              bindingDigest: request.bindingDigest,
              head: request.head,
              base: request.base,
            })
        ) return refused();
        const before = await input.state.readRepair();
        if (
          !before.ok || before.value.status !== "found" ||
          before.value.head !== request.expectedStateHead
        ) return refused();
        const snapshot = parseRepairStateSnapshotV1(before.value.snapshot);
        const stateHead = before.value.head;
        const record = snapshot.work.find((r) =>
          r.id === request.binding.taskId
        );
        if (record === undefined) return refused();
        const intent = record.intent;
        if (
          record.nextStep !== "blocked" || record.blocker?.kind !== "other" ||
          record.blocker.message !== TAKEOVER_NATIVE_PRESERVING ||
          record.wait !== null || record.target.head !== request.head ||
          record.target.base !== request.base ||
          record.target.pr !== request.binding.pullRequest ||
          record.target.branch !== request.binding.headRef ||
          record.target.checkpoint !== null ||
          record.target.candidateState?.preserved !== null ||
          record.target.candidateState.publishedHead !== request.head ||
          intent?.kind !== "push" ||
          intent.key !== nativeTakeoverIntentKey(request) ||
          intent.branch !== request.ref ||
          intent.expectedHead !== request.head ||
          intent.observedBase !== request.base || intent.pr !== null ||
          intent.requestId !== null || intent.resultId !== null ||
          !same(
            record.evidence.filter((e) =>
              e.ref.startsWith(TAKEOVER_EVIDENCE_NAMESPACE)
            ),
            [takeoverAnchorRef(request.bindingDigest)],
          ) ||
          snapshot.work.some((other) =>
            other.id !== record.id &&
            same(other.repository, record.repository) &&
            other.target.pr === record.target.pr
          )
        ) return refused();
        const unchanged = async () => {
          if (!effectsAllowed(request.deadline)) return false;
          const principal = await revalidateTakeoverPrincipal(input.principal, {
            repository: request.binding.repository,
            taskId: request.binding.taskId,
            expectedStateHead: request.expectedStateHead,
            pullRequest: request.binding.pullRequest,
            branch: request.binding.headRef,
            head: request.head,
            base: request.base,
            operation: "native_preserve",
            phase: "native",
            nextHead: null,
            deadline: request.deadline,
          });
          if (!principal.ok || !effectsAllowed(request.deadline)) return false;
          const current = await input.state.readRepair();
          return current.ok && current.value.status === "found" &&
            current.value.head === stateHead &&
            same(current.value.snapshot, snapshot) &&
            effectsAllowed(request.deadline);
        };
        const native = await discover({ record, deadline: request.deadline });
        if (
          native.status !== "candidate" ||
          !same(native.candidate.binding, request.binding) ||
          native.candidate.head !== request.head ||
          native.candidate.base !== request.base
        ) return refused();
        const observed = await input.port.readRef(request.ref);
        if (!observed.ok) return observed;
        if (observed.value !== null && observed.value.sha !== request.head) {
          return portError(
            "conflict",
            "existing pull request custody ref conflicts",
          );
        }
        if (observed.value === null) {
          const pull = await input.client.readAssociationPull(
            request.binding.pullRequest,
            request.deadline,
          );
          if (
            pull.status !== "complete" || pull.value.head !== request.head ||
            pull.value.base !== request.base ||
            pull.value.nodeId !== request.binding.pullNodeId ||
            pull.value.headRef !== request.binding.headRef ||
            pull.value.baseRef !== request.binding.baseRef
          ) return refused();
          const imported = await git.inspect(
            pull.value,
            request.deadline,
            true,
          );
          if (!imported.ok || !imported.value.protectedPathsClear) {
            return refused();
          }
          const finalNative = await discover({
            record,
            deadline: request.deadline,
          });
          if (
            finalNative.status !== "candidate" ||
            !same(finalNative.candidate, native.candidate) ||
            !await unchanged()
          ) return refused();
          const pushed = await input.port.pushHead(
            request.ref,
            request.head,
            null,
          );
          if (!pushed.ok) return pushed;
          // One attempt only, including lost acknowledgements; readback decides custody.
        }
        const restored = await git.restore(
          request.ref,
          request.head,
          request.base,
          request.deadline,
        );
        if (!restored.ok || !restored.value.protectedPathsClear) {
          return refused();
        }
        const afterRef = await input.port.readRef(request.ref);
        if (
          !afterRef.ok || afterRef.value?.sha !== request.head ||
          !await unchanged()
        ) return refused();
        const finalNative = await discover({
          record,
          deadline: request.deadline,
        });
        return finalNative.status === "candidate" &&
            same(finalNative.candidate, native.candidate) &&
            await unchanged()
          ? portOk(undefined)
          : refused();
      } catch {
        return refused();
      }
    },
  };
}
