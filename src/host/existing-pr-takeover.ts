/** Trusted native discovery/preservation composition. State transitions remain with the coordinator. */
import { canonicalStringify } from "../contracts/canonical.ts";
import type {
  ExistingPrTakeoverPort,
  TakeoverCandidateCustody,
  TakeoverEffectBoundary,
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
import {
  createTakeoverProofPort,
  type TakeoverProofDependencies,
} from "../github/existing-pr-takeover-proof.ts";
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
import {
  createTakeoverBoundaryGuard,
  revalidateTakeoverPrincipal,
} from "../github/existing-pr-takeover-effect.ts";
import { createTakeoverPublicationReader } from "../github/existing-pr-publication-proof.ts";
import { createTakeoverProducerReader } from "./existing-pr-produced-custody.ts";
import type { WorkItemId } from "../contracts/brands.ts";
import type { GitSha } from "../contracts/brands.ts";
import type { GitHubPrAssociationsClient } from "../github/client-pr-associations.ts";
import { queueIntentBinding } from "../../ops/hosted-autonomy-queue-intent.ts";
import { isQueueHeld } from "../../ops/hosted-autonomy-queue-policy.ts";

export interface ExistingPrTakeoverHostInput extends NativeTakeoverGitInput {
  state: Pick<StateReadView, "readRepair" | "readRepairAt">;
  client:
    & TakeoverDiscoveryDependencies["client"]
    & Pick<
      GitHubPrAssociationsClient,
      "readQueue" | "readQueuePull" | "readQueueLegacyPull"
    >;
  port: Pick<GitHubPort, "readRef" | "pushHead" | "nativeQueue">;
  baseBranch: string;
  /** Source-only test/composition policy. Production defaults to the dormant policy. */
  policy?: ExistingPrTakeoverPolicy;
  runtimeCapabilityAccepted?: () => boolean;
  contentsWriteAllowed?: () => boolean;
  principal?: TakeoverPrincipalAuthority;
  /** Existing trusted task-mapped loader; availability is never producer authority. */
  ensureLocalCandidate?: (
    taskId: WorkItemId,
    head: GitSha,
  ) => Promise<PortResultV1<void>>;
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
  const producerReader = input.verifyProducedCandidate ??
    createTakeoverProducerReader(input);
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
  const nativePushes = new WeakMap<object, {
    boundary: TakeoverEffectBoundary;
    verify(): Promise<boolean>;
  }>();

  const readCandidate: TakeoverProofDependencies["readCandidate"] = async (
    request,
  ) => {
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
      const producer = await producerReader(
        request.operation === "preserve_successor"
          ? request
          : { ...request, candidate: undefined },
      );
      const descriptor = target.candidateState?.preserved ??
        (request.operation === "preserve_successor"
          ? request.candidate
          : undefined);
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
      const pending = target.candidateState?.preserved === null &&
        request.operation === "preserve_successor";
      if (
        pending &&
        !(await input.ensureLocalCandidate?.(
          request.record.id,
          descriptor.head,
        ))?.ok
      ) return refused();
      const candidate = pending
        ? await git.validateLocal(
          descriptor.base,
          descriptor.head,
          target.candidateState?.publishedHead ?? null,
          request.deadline,
        )
        : await git.restore(
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
    const regenerate = request.operation === "refresh" &&
      (request.phase ?? "prepare") === "prepare";
    const next = request.nextHead === undefined || regenerate
      ? portOk(false)
      : await git.isAncestor(
        request.expectedHead,
        request.nextHead,
        request.deadline,
      );
    if (!next.ok) return next;
    if (
      request.operation === "refresh" && request.nextHead !== undefined &&
      !regenerate
    ) {
      const descendant = await git.isAncestor(
        target.head,
        request.nextHead,
        request.deadline,
      );
      const baseIncluded = await git.isAncestor(
        request.observedBase!,
        request.nextHead,
        request.deadline,
      );
      if (
        !descendant.ok || !descendant.value || !baseIncluded.ok ||
        !baseIncluded.value || request.candidate === undefined
      ) return refused();
      const producer = await producerReader(request);
      if (
        !producer.ok || producer.value?.kind !== "base_refresh" ||
        !same(producer.value.candidate, request.candidate)
      ) return refused();
      const prepared = request.phase === "publish"
        ? await git.restore(
          request.candidate.ref,
          request.candidate.head,
          request.candidate.base,
          request.deadline,
        )
        : await git.validateLocal(
          request.candidate.base,
          request.candidate.head,
          target.head,
          request.deadline,
        );
      if (!prepared.ok || !prepared.value.protectedPathsClear) return refused();
    }
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
  };

  const proof = createTakeoverProofPort({
    state: input.state,
    clock: input.clock,
    repository: input.repository,
    baseBranch: input.baseBranch,
    policy,
    runtimeCapabilityAccepted,
    principal: input.principal,
    async readNative(request) {
      const enqueueDiscovery = request.operation !== "enqueue"
        ? discover
        : createTakeoverDiscovery({
          repository: input.repository,
          baseBranch: input.baseBranch,
          clock: input.clock,
          client: input.client,
          port: input.port,
          contentsWriteAllowed,
          inspectNativeGit: (pull, deadline) => git.inspect(pull, deadline),
          async observeQueueAdmission(pull, deadline) {
            const saved = await queueIntentBinding(
              request.snapshot,
              request.record,
            );
            if (
              saved === null || !isQueueHeld(request.record) ||
              saved.binding.head !== request.expectedHead ||
              saved.binding.base !== request.record.target.base ||
              saved.binding.pullRequest !== pull.number ||
              saved.state.intent.resultId !== null ||
              !same(saved.binding.repository, input.repository)
            ) return false;
            const [queue, membership, rules] = await Promise.all([
              input.client.readQueue(input.baseBranch),
              input.client.readQueuePull(pull.number, deadline),
              input.client.readBranchRules(input.baseBranch),
            ]);
            return queue.status === "complete" &&
              membership.status === "complete" && rules.ok &&
              rules.value.some((rule) => rule.type === "merge_queue") &&
              same(queue.value.repository, input.repository) &&
              queue.value.queueId !== null &&
              queue.value.baseTip === pull.base &&
              membership.value.base === pull.base &&
              same(
                membership.value.membership.pull.repository,
                input.repository,
              ) &&
              membership.value.membership.pull.nodeId === pull.nodeId &&
              queue.value.baseRef === input.baseBranch &&
              !queue.value.entries.some((entry) =>
                entry.pull.number === pull.number
              ) &&
              membership.value.membership.entry === null &&
              membership.value.membership.mergedRevision === null &&
              membership.value.membership.pull.number === pull.number &&
              membership.value.membership.pull.head === pull.head &&
              membership.value.membership.pull.headRef === pull.headRef &&
              membership.value.membership.pull.baseRef === pull.baseRef &&
              input.clock.now() < deadline;
          },
        });
      const found = await enqueueDiscovery(request);
      return found.status === "candidate" ? portOk(found.candidate) : refused();
    },
    readCandidate,
  });

  return {
    get coordinationActivated() {
      return policy.activated === true;
    },
    discover,
    ...proof,
    resolvePublication: createTakeoverPublicationReader({
      ...input,
      readCandidate,
    }),
    authorizeBoundary: createTakeoverBoundaryGuard({
      repository: input.repository,
      state: input.state,
      activated: () => policy.activated === true,
      now: () => input.clock.now(),
      port: { discover, authorizeEffect: proof.authorizeEffect },
      async nativePush(boundary, authorization) {
        const saved = nativePushes.get(authorization.proof);
        nativePushes.delete(authorization.proof);
        return saved !== undefined && same(saved.boundary, boundary) &&
            await saved.verify()
          ? portOk(undefined)
          : refused();
      },
    }),
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
          const nativeProof = Object.freeze({
            kind: "verified_native_preservation_push" as const,
          });
          nativePushes.set(nativeProof, {
            boundary: {
              kind: "push",
              ref: request.ref,
              head: request.head,
              expectedRef: null,
            },
            verify: unchanged,
          });
          const pushed = await input.port.pushHead(
            request.ref,
            request.head,
            null,
            { kind: "native_preservation", proof: nativeProof },
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
