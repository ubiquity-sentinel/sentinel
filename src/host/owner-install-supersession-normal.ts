/** Explicit authenticated normal capable movement across immutable owner-superseded history. */
import {
  canonicalStringify,
  canonicalStringifySha256,
} from "../contracts/canonical.ts";
import {
  isHostedReleaseTerminal,
  parseHostedRunProofV1,
} from "../contracts/hosted-supervisor.ts";
import { portError, portOk } from "../contracts/ports.ts";
import { GitHubApiClient } from "../github/client.ts";
import { fetchHttpTransport } from "../github/http.ts";
import {
  nativeProof,
  type ReadInput,
  sourceApproved,
} from "./owner-install-future-recovery.ts";
import {
  HOSTED_RUNTIME_ROLLOUT,
  parseHostedRuntimeRollout,
} from "./hosted-runtime-rollout.ts";
import { QUEUE_RUNTIME_CAPABILITY } from "./queue-runtime-capability.ts";
import { EXISTING_PR_RUNTIME_CAPABILITY } from "./existing-pr-runtime-capability.ts";
import { allowsHostedOwnerInstallMove } from "./hosted-runtime-compatibility.ts";
import {
  failedSettlementFor,
  healthyProofFor,
} from "./owner-install-plan-proof.ts";
import { planOwnerInstallRollout } from "./owner-install-plan-rollout.ts";
import { ownerSupersessionSourceData } from "./owner-install-supersession-source.ts";
import { ownerStartupNativeQuiescent } from "./owner-install-startup-evidence.ts";
import type { HostedRuntimeRecovery } from "./hosted-runtime-rollout.ts";
import type { HostedOwnerSuccessorBindingV1 } from "../contracts/hosted-supervisor.ts";
import { reviewTaskStatementDigest } from "../contracts/review-task-acceptance.ts";
import { ownerSupersessionSourceApproved } from "./owner-install-supersession-source.ts";
import { originalPriorNativeFingerprint } from "./owner-install-supersession-original.ts";

const digest = canonicalStringifySha256;
const same = (a: unknown, b: unknown) =>
  canonicalStringify(a) === canonicalStringify(b);
export async function readOwnerSupersededNormalEvidence(input: ReadInput) {
  try {
    const snapshot = input.current.snapshot,
      runtime = snapshot.hostedRuntimes[0];
    const repair = await input.state.readRepair();
    if (
      !repair.ok || repair.value.status !== "found" || !runtime ||
      runtime.execution !== null || snapshot.updatedAt > Date.now() ||
      repair.value.snapshot.updatedAt > Date.now() ||
      !snapshot.hostedReleases.some((r) => r.phase === "owner_superseded") ||
      snapshot.hostedReleases.some((r) =>
        !isHostedReleaseTerminal(r.phase) || r.pointerIntent !== null
      )
    ) return;
    const repairHead = repair.value.head,
      repairSnapshot = repair.value.snapshot;
    if (
      snapshot.hostedReleases.some((r) =>
        r.ownerAcceptance !== undefined &&
        same(r.ownerAcceptance.controllerRun, input.run)
      )
    ) return;
    const pins = parseHostedRuntimeRollout(
        input.rollout ?? HOSTED_RUNTIME_ROLLOUT,
      ),
      queue = input.queue ?? QUEUE_RUNTIME_CAPABILITY,
      custody = input.custody ?? EXISTING_PR_RUNTIME_CAPABILITY;
    for (
      const r of snapshot.hostedReleases.filter((r) =>
        r.phase === "owner_superseded"
      )
    ) {
      const d = r.ownerDisposition;
      if (
        !d || await digest(d.intent) !== d.intentSha256 ||
        await digest(r.request) !== d.intent.requestSha256 ||
        await digest(d.failedPriorProof) !== d.intent.failedProofSha256 ||
        await originalPriorNativeFingerprint(d.originalFailedPriorProof) !==
          d.intent.originalFailedPriorNativeSha256 ||
        !pins.ownerSupersessions.some((i) => same(i, d.intent))
      ) return;
    }
    const healthy = healthyProofFor(
        runtime,
        runtime.activeRevision,
        runtime.generation,
      ),
      failed = failedSettlementFor(
        runtime,
        runtime.activeRevision,
        runtime.generation,
      );
    const plan = planOwnerInstallRollout({
      runtime,
      revision: runtime.activeRevision,
      generation: runtime.generation,
      healthy,
      failed,
    }, pins);
    if (
      !plan || plan.status !== "install" && plan.status !== "rollback" ||
      !allowsHostedOwnerInstallMove(plan.move, queue, custody)
    ) return;
    const retained = parseHostedRunProofV1(runtime.lastHealthyProof),
      latest = parseHostedRunProofV1(runtime.lastExecutionProof);
    if (
      retained.outcome !== "healthy" ||
      !same(retained, plan.move.priorHealthyProof) ||
      latest.observedAt > Date.now() || retained.observedAt > Date.now() ||
      plan.status === "install" &&
        (!healthy || latest.outcome !== "healthy" || !same(latest, healthy)) ||
      plan.status === "rollback" &&
        (latest.outcome !== "failed" || retained.finishedAt > latest.startedAt)
    ) return;
    if (
      !await ownerSupersessionSourceData({
        launcherSha: input.run.launcherSha,
        queue,
        custody,
        rollout: pins,
      })
    ) return;
    const row: HostedRuntimeRecovery = {
      fromRevision: plan.move.priorRevision,
      fromGeneration: plan.move.priorGeneration,
      toRevision: plan.move.nextRevision,
      toGeneration: plan.move.nextGeneration,
      failedProofSha256: await digest(latest),
      retainedHealthyProofSha256: await digest(retained),
      healthyWitnessHead: input.current.head,
    };
    let rateLimited = false;
    const unchanged = async () => {
      const [r, p] = await Promise.all([
        input.state.readRelease(),
        input.state.readRepair(),
      ]);
      return !rateLimited && r.ok && r.value.status === "found" && p.ok &&
        p.value.status === "found" && r.value.head === input.current.head &&
        p.value.head === repairHead &&
        same(r.value.snapshot, snapshot) &&
        same(p.value.snapshot, repairSnapshot) &&
        ![
          ...r.value.snapshot.githubCooldowns,
          ...p.value.snapshot.githubCooldowns,
        ].some((c) =>
          c.retryNotBefore === null || Date.now() < c.retryNotBefore
        );
    };
    const client = new GitHubApiClient({
      repository: {
        owner: "ubiquity-sentinel",
        name: "sentinel",
        installationId: 0,
      },
      apiBaseUrl: "https://api.github.com",
      http: fetchHttpTransport(),
      auth: {
        authorizationHeader: () =>
          Promise.resolve(portOk(`Bearer ${input.token}`)),
      },
      clock: { now: () => Date.now() },
      cooldownGate: {
        beforeRequest: async (scope) =>
          scope === 0 && await unchanged() ? portOk(undefined) : portError(
            "unavailable",
            "owner normal movement custody unavailable",
          ),
        recordRateLimit: () => {
          rateLimited = true;
          return Promise.resolve(portOk(undefined));
        },
      },
    });
    let successorBinding: HostedOwnerSuccessorBindingV1 | undefined;
    const pending = snapshot.hostedReleases.filter((r) =>
      r.phase === "owner_superseded" &&
      repairSnapshot.work.some((w) =>
        w.id === r.ownerDisposition!.intent.workId && w.nextStep === "delivery"
      )
    );
    if (pending.length > 1) return;
    if (pending.length === 1) {
      const receipt = pending[0], d = receipt.ownerDisposition!;
      if (receipt.ownerAcceptance !== undefined) return;
      const bindings = pins.ownerSuccessorTaskBindings.filter((b) =>
        b.releaseId === receipt.id && b.intentSha256 === d.intentSha256 &&
        b.successorRevision === plan.move.nextRevision &&
        b.successorGeneration === plan.move.nextGeneration
      );
      if (bindings.length !== 1) return;
      const binding = bindings[0],
        task = await client.readIssue(binding.issueNumber);
      if (
        binding.requestSha256 !== d.intent.requestSha256 ||
        binding.taskSha256 !== d.intent.taskSha256 ||
        binding.workId !== d.intent.workId ||
        binding.issueNumber !== d.intent.issueNumber ||
        !task.ok || !task.value ||
        await reviewTaskStatementDigest({
            issueNumber: task.value.number,
            title: task.value.title,
            body: task.value.body,
          }) !== binding.taskSha256 ||
        !await ownerSupersessionSourceApproved(input, {
          ...d.intent,
          toRevision: binding.successorRevision,
          toGeneration: binding.successorGeneration,
          controllerSourceRevision: binding.controllerSourceRevision,
          controllerCodeSha256: binding.controllerCodeSha256,
          ciRevision: binding.ciRevision,
        }, Date.now())
      ) return;
      const bindingSha256 = await digest(binding);
      successorBinding = {
        id: `owner-successor-binding:${bindingSha256}`,
        binding,
        bindingSha256,
        controllerRevision: input.run.launcherSha,
        recoveryFromRevision: plan.move.priorRevision,
        recoveryFromGeneration: plan.move.priorGeneration,
        movement: plan.move.action,
        movementProof: structuredClone(latest),
        movementProofSha256: await digest(latest),
      };
    }
    if (
      !await sourceApproved(input, row, Date.now()) ||
      !await nativeProof(client, retained) ||
      !await nativeProof(client, latest) ||
      !await ownerStartupNativeQuiescent(input.token, input.run) ||
      !await unchanged()
    ) return;
    return {
      row,
      disposition: structuredClone(
        snapshot.hostedReleases.find((r) => r.phase === "owner_superseded")!
          .ownerDisposition!,
      ),
      snapshot: canonicalStringify(snapshot),
      repair: canonicalStringify(repairSnapshot),
      releaseHead: input.current.head,
      policies: canonicalStringify({ queue, custody }),
      run: Object.freeze({ ...input.run }),
      normalMove: structuredClone(plan.move),
      normalRollout: canonicalStringify(pins),
      ...(successorBinding === undefined ? {} : { successorBinding }),
    };
  } catch {
    return undefined;
  }
}
