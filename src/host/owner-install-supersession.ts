/** One atomic prepromotion owner supersession. Failed PRIOR is never recovery health. */
import { canonicalStringify } from "../contracts/canonical.ts";
import type { GitSha } from "../contracts/brands.ts";
import {
  isHostedReleaseTerminal,
  parseHostedExecutionIntentV1,
  parseHostedReleaseRecordV1,
  parseHostedRunProofV1,
} from "../contracts/hosted-supervisor.ts";
import type {
  HostedOwnerDispositionV1,
  HostedOwnerSuccessorBindingV1,
  HostedOwnerSupersessionIntentV1,
} from "../contracts/hosted-supervisor.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../contracts/state-snapshots.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../contracts/state-snapshots.ts";
import { portError, portOk } from "../contracts/ports.ts";
import { GitHubApiClient } from "../github/client.ts";
import { fetchHttpTransport } from "../github/http.ts";
import { reviewTaskStatementDigest } from "../contracts/review-task-acceptance.ts";
import {
  HOSTED_RUNTIME_ROLLOUT,
  parseHostedRuntimeRollout,
} from "./hosted-runtime-rollout.ts";
import type {
  HostedRuntimeRecovery,
  HostedRuntimeRollout,
} from "./hosted-runtime-rollout.ts";
import {
  QUEUE_RUNTIME_CAPABILITY,
  type QueueRuntimeCapability,
} from "./queue-runtime-capability.ts";
import {
  EXISTING_PR_RUNTIME_CAPABILITY,
  type ExistingPrRuntimeCapability,
} from "./existing-pr-runtime-capability.ts";
import {
  OWNER_DEVELOPMENT_INSTALL_GEN80_REVISION,
  OWNER_DEVELOPMENT_INSTALL_GEN81_REVISION,
} from "./owner-install-runtime-pins.ts";
import { sha256HexText } from "./owner-install-api.ts";
import { movePlan, waiting } from "./owner-install-plan-proof.ts";
import type {
  OwnerDevelopmentInstallMoveV1,
  OwnerDevelopmentInstallPlanV1,
} from "./owner-install-types.ts";
import {
  nativeProof,
  type ReadInput,
  sourceApproved,
} from "./owner-install-future-recovery.ts";
import { ownerStartupNativeQuiescent } from "./owner-install-startup-evidence.ts";
import {
  ownerSupersessionSourceApproved,
  ownerSupersessionSourceData,
} from "./owner-install-supersession-source.ts";
import { ownerSuccessorBindingFor } from "./owner-successor-acceptance-binding.ts";
import { readOwnerSupersededNormalEvidence } from "./owner-install-supersession-normal.ts";
import { readOriginalPriorNativeObservation } from "./owner-install-supersession-original.ts";

declare const issuedAuthority: unique symbol;
export interface OwnerSupersessionAuthority {
  readonly [issuedAuthority]: true;
}
type Verified = {
  kind: "supersession" | "recovery" | "normal";
  row: HostedOwnerSupersessionIntentV1 | HostedRuntimeRecovery;
  releaseHead: GitSha;
  disposition: HostedOwnerDispositionV1;
  snapshot: string;
  repair: string;
  policies: string;
  run: ReadInput["run"];
  successorBinding?: HostedOwnerSuccessorBindingV1;
  normalMove?: OwnerDevelopmentInstallMoveV1;
  normalRollout?: string;
};
const issued = new WeakMap<OwnerSupersessionAuthority, Verified>();
const detail = "exact owner supersession authority is unavailable";
const digest = (value: unknown) => sha256HexText(canonicalStringify(value));
type TargetInput = {
  snapshot: ReleaseStateSnapshotV1;
  repair: RepairStateSnapshotV1;
  releaseHead: GitSha;
  repairHead: GitSha;
  launcherSha: GitSha;
  now: number;
  queue?: QueueRuntimeCapability;
  custody?: ExistingPrRuntimeCapability;
  rollout?: HostedRuntimeRollout;
};

/** Read-only maintenance admission. Only the private native issuer below can authorize movement. */
export async function readOwnerSupersessionTarget(
  input: TargetInput,
): Promise<{ revision: GitSha; generation: number } | undefined> {
  try {
    const row = await matchingIntent(input);
    if (!row) return;
    if (
      !await ownerSupersessionSourceData({
        launcherSha: input.launcherSha,
        queue: input.queue ?? QUEUE_RUNTIME_CAPABILITY,
        custody: input.custody ?? EXISTING_PR_RUNTIME_CAPABILITY,
        rollout: input.rollout ?? HOSTED_RUNTIME_ROLLOUT,
      })
    ) return;
    return Object.freeze({
      revision: row.toRevision,
      generation: row.toGeneration,
    });
  } catch {
    return undefined;
  }
}

async function matchingIntent(
  input: TargetInput,
): Promise<HostedOwnerSupersessionIntentV1 | undefined> {
  const snapshot = parseReleaseStateSnapshotV1(input.snapshot);
  const repair = parseRepairStateSnapshotV1(input.repair);
  const pins = parseHostedRuntimeRollout(
    input.rollout ?? HOSTED_RUNTIME_ROLLOUT,
  );
  const queue = input.queue ?? QUEUE_RUNTIME_CAPABILITY;
  const custody = input.custody ?? EXISTING_PR_RUNTIME_CAPABILITY;
  const runtime = snapshot.hostedRuntimes.length === 1
    ? snapshot.hostedRuntimes[0]
    : undefined;
  const row = pins.ownerSupersessions.find((i) =>
    i.fromRevision === runtime?.activeRevision &&
    i.fromGeneration === runtime.generation
  );
  if (
    !row || !runtime || runtime.execution !== null ||
    runtime.activeRevision !== OWNER_DEVELOPMENT_INSTALL_GEN81_REVISION ||
    runtime.generation !== 81 ||
    !Number.isSafeInteger(input.now) || input.now < row.authorizedAt ||
    snapshot.updatedAt > input.now || repair.updatedAt > input.now ||
    input.releaseHead !== row.releaseHead ||
    input.repairHead !== row.repairHead ||
    await digest(snapshot) !== row.releaseSnapshotSha256 ||
    await digest(repair) !== row.repairSnapshotSha256 ||
    [...snapshot.githubCooldowns, ...repair.githubCooldowns].some((c) =>
      c.retryNotBefore === null || input.now < c.retryNotBefore
    )
  ) return;
  const exact = (
    i: {
      fromRevision: GitSha;
      fromGeneration: number;
      toRevision: GitSha;
      toGeneration: number;
    },
  ) =>
    i.fromRevision === row.fromRevision &&
    i.fromGeneration === row.fromGeneration &&
    i.toRevision === row.toRevision && i.toGeneration === row.toGeneration;
  if (
    queue.proofActivated !== true || custody.custodyActivated !== true ||
    !pins.installs.some((i) => exact(i) && !i.rollbackToPrior) ||
    [queue, custody].some((p) =>
      !p.revisions.includes(row.toRevision) ||
      p.revisions.includes(OWNER_DEVELOPMENT_INSTALL_GEN80_REVISION) ||
      p.revisions.includes(OWNER_DEVELOPMENT_INSTALL_GEN81_REVISION) ||
      !p.ownerInstallMigrations?.some(exact)
    )
  ) return;
  const release = snapshot.hostedReleases.find((r) => r.id === row.releaseId);
  const request = repair.releaseRequests.find((r) => r.id === row.releaseId);
  const work = repair.work.find((w) => w.id === row.workId);
  if (
    !release || release.phase !== "requested" ||
    release.ownerDisposition !== undefined ||
    release.priorProof !== null || release.candidateProof !== null ||
    release.rollbackProof !== null || release.pointerIntent !== null ||
    snapshot.hostedReleases.some((r) =>
      r.id !== row.releaseId &&
      (!isHostedReleaseTerminal(r.phase) || r.pointerIntent !== null)
    ) ||
    !request || request.status !== "open" ||
    canonicalStringify(request) !== canonicalStringify(release.request) ||
    !work || work.nextStep !== "delivery" ||
    work.related.issueNumber !== row.issueNumber ||
    work.target.pr !== request.source.pullRequest ||
    work.target.head !== request.source.head ||
    work.target.base !== request.source.base ||
    canonicalStringify(work.repository) !==
      canonicalStringify(request.target.repository) ||
    await digest(request) !== row.requestSha256 ||
    await digest(request.source) !== row.sourceSha256 ||
    await digest(work) !== row.workSha256
  ) return;
  const failed = parseHostedRunProofV1(runtime.lastExecutionProof);
  const healthy = parseHostedRunProofV1(runtime.lastHealthyProof);
  if (
    release.priorRevision !== row.fromRevision || failed.outcome !== "failed" ||
    failed.execution.purpose !== "prior" ||
    failed.execution.releaseId !== release.id ||
    failed.execution.revision !== row.fromRevision ||
    failed.execution.generation !== row.fromGeneration ||
    healthy.outcome !== "healthy" ||
    healthy.execution.revision !== row.fromRevision ||
    healthy.execution.generation !== row.fromGeneration ||
    healthy.finishedAt > failed.startedAt ||
    failed.observedAt > row.authorizedAt ||
    healthy.observedAt > row.authorizedAt ||
    await digest(failed) !== row.failedProofSha256 ||
    await digest(healthy) !== row.retainedHealthyProofSha256
  ) return;
  return row;
}

export async function readOwnerSupersessionAuthority(
  input: ReadInput,
): Promise<OwnerSupersessionAuthority | undefined> {
  try {
    const repair = await input.state.readRepair();
    if (
      !repair.ok || repair.value.status !== "found" ||
      !input.state.readReleaseAt
    ) return;
    const now = Date.now();
    const target: TargetInput = {
      snapshot: input.current.snapshot,
      repair: repair.value.snapshot,
      releaseHead: input.current.head,
      repairHead: repair.value.head,
      launcherSha: input.run.launcherSha,
      now,
      queue: input.queue,
      custody: input.custody,
      rollout: input.rollout,
    };
    const row = await matchingIntent(target);
    if (!row || !await readOwnerSupersessionTarget(target)) return;
    const runtime = input.current.snapshot.hostedRuntimes[0];
    const healthy = parseHostedRunProofV1(runtime.lastHealthyProof);
    const failed = parseHostedRunProofV1(runtime.lastExecutionProof);
    const witness = await input.state.readReleaseAt({
      commit: row.healthyWitnessHead,
      expectedHead: input.current.head,
    });
    if (
      !witness.ok || witness.value.status !== "found" ||
      witness.value.snapshot.hostedRuntimes.length !== 1 ||
      canonicalStringify(
          witness.value.snapshot.hostedRuntimes[0].lastHealthyProof,
        ) !== canonicalStringify(healthy)
    ) return;
    const snapshot = canonicalStringify(input.current.snapshot),
      repairText = canonicalStringify(repair.value.snapshot);
    const repairHead = repair.value.head;
    let rateLimited = false;
    const unchanged = async () => {
      const [r, p] = await Promise.all([
        input.state.readRelease(),
        input.state.readRepair(),
      ]);
      return !rateLimited && r.ok && r.value.status === "found" && p.ok &&
        p.value.status === "found" &&
        r.value.head === input.current.head && p.value.head === repairHead &&
        canonicalStringify(r.value.snapshot) === snapshot &&
        canonicalStringify(p.value.snapshot) === repairText &&
        ![
          ...r.value.snapshot.githubCooldowns,
          ...p.value.snapshot.githubCooldowns,
        ].some((c) =>
          c.retryNotBefore === null || Date.now() < c.retryNotBefore
        );
    };
    const client = new GitHubApiClient({
      repository: { owner: "ubiquity", name: "sentinel", installationId: 0 },
      apiBaseUrl: "https://api.github.com",
      http: fetchHttpTransport(),
      auth: {
        authorizationHeader: () =>
          Promise.resolve(portOk(`Bearer ${input.token}`)),
      },
      clock: { now: () => Date.now() },
      includeIssueRelations: false,
      cooldownGate: {
        beforeRequest: async (scope) =>
          scope === 0 && await unchanged()
            ? portOk(undefined)
            : portError("unavailable", detail),
        recordRateLimit: () => {
          rateLimited = true;
          return Promise.resolve(portOk(undefined));
        },
      },
    });
    const task = await client.readIssue(row.issueNumber);
    const originalFailedPriorProof = await readOriginalPriorNativeObservation(
      client,
      row,
    );
    if (
      !originalFailedPriorProof ||
      originalFailedPriorProof.finishedAt > failed.finishedAt ||
      healthy.finishedAt > originalFailedPriorProof.startedAt ||
      !task.ok || !task.value ||
      await reviewTaskStatementDigest({
          issueNumber: task.value.number,
          title: task.value.title,
          body: task.value.body,
        }) !== row.taskSha256 ||
      !await ownerSupersessionSourceApproved(input, row, now) ||
      !await nativeProof(client, healthy) ||
      !await nativeProof(client, failed) ||
      !await ownerStartupNativeQuiescent(input.token, input.run) ||
      !await unchanged()
    ) return;
    const disposition: HostedOwnerDispositionV1 = {
      version: "v1",
      kind: "owner_supersession",
      intent: row,
      intentSha256: await digest(row),
      controllerRevision: input.run.launcherSha,
      controllerCiRevision: input.run.launcherSha,
      failedPriorProof: structuredClone(failed),
      retainedHealthyProof: structuredClone(healthy),
      originalFailedPriorProof: structuredClone(originalFailedPriorProof),
    };
    const authority = Object.freeze({}) as OwnerSupersessionAuthority;
    issued.set(authority, {
      kind: "supersession",
      releaseHead: input.current.head,
      row,
      disposition,
      snapshot,
      repair: repairText,
      policies: canonicalStringify({
        queue: input.queue ?? QUEUE_RUNTIME_CAPABILITY,
        custody: input.custody ?? EXISTING_PR_RUNTIME_CAPABILITY,
      }),
      run: Object.freeze({ ...input.run }),
    });
    return authority;
  } catch {
    return undefined;
  }
}

export function planOwnerSupersession(
  snapshot: ReleaseStateSnapshotV1,
  authority: OwnerSupersessionAuthority,
  queue: QueueRuntimeCapability = QUEUE_RUNTIME_CAPABILITY,
  custody: ExistingPrRuntimeCapability = EXISTING_PR_RUNTIME_CAPABILITY,
  rollout: HostedRuntimeRollout = HOSTED_RUNTIME_ROLLOUT,
): OwnerDevelopmentInstallPlanV1 {
  try {
    const proof = issued.get(authority);
    if (
      !proof || proof.snapshot !== canonicalStringify(snapshot) ||
      proof.policies !== canonicalStringify({ queue, custody }) ||
      (proof.kind === "normal"
        ? proof.normalRollout !==
          canonicalStringify(parseHostedRuntimeRollout(rollout))
        : !(proof.kind === "supersession"
          ? parseHostedRuntimeRollout(rollout).ownerSupersessions
          : parseHostedRuntimeRollout(rollout).recoveries).some((r) =>
            canonicalStringify(r) === canonicalStringify(proof.row)
          ))
    ) return waiting(detail);
    if (proof.kind === "normal") {
      return proof.normalMove?.action === "rollback"
        ? {
          status: "rollback",
          move: structuredClone(proof.normalMove),
          detail:
            "restore the exact accepted capable prior across immutable owner history",
        }
        : proof.normalMove?.action === "install"
        ? {
          status: "install",
          move: structuredClone(proof.normalMove),
          detail:
            "install the exact accepted capable runtime across immutable owner history",
        }
        : waiting(detail);
    }
    return movePlan(
      "install",
      snapshot.hostedRuntimes[0],
      proof.row.toRevision,
      proof.row.toGeneration,
      structuredClone(proof.disposition.retainedHealthyProof),
      "atomically supersede the exact prepromotion owner request and install its capable successor",
    );
  } catch {
    return waiting(detail);
  }
}

export function ownerSupersessionTransition(
  snapshot: ReleaseStateSnapshotV1,
  head: GitSha,
  now: number,
  authority: OwnerSupersessionAuthority,
  move: OwnerDevelopmentInstallMoveV1,
  queue?: QueueRuntimeCapability,
  custody?: ExistingPrRuntimeCapability,
  rollout?: HostedRuntimeRollout,
) {
  const proof = issued.get(authority);
  const plan = planOwnerSupersession(
    snapshot,
    authority,
    queue,
    custody,
    rollout,
  );
  if (
    !proof || proof.releaseHead !== head ||
    now < proof.disposition.intent.authorizedAt ||
    plan.status !== "install" && plan.status !== "rollback" ||
    canonicalStringify(plan.move) !== canonicalStringify(move)
  ) throw new Error(detail);
  return {
    execution: parseHostedExecutionIntentV1({
      id: `${proof.run.runId}:${proof.run.runAttempt}:repair`,
      ...proof.run,
      purpose: "bootstrap",
      releaseId: null,
      revision: proof.row.toRevision,
      generation: proof.row.toGeneration,
      createdAt: now,
    }),
    hostedReleases: snapshot.hostedReleases.map((r) =>
      r.id !== proof.disposition.intent.releaseId
        ? r
        : proof.kind === "supersession"
        ? parseHostedReleaseRecordV1({
          ...r,
          phase: "owner_superseded",
          ownerDisposition: structuredClone(proof.disposition),
          updatedAt: now,
        })
        : proof.successorBinding === undefined
        ? r
        : parseHostedReleaseRecordV1({
          ...r,
          ownerSuccessorBindings: [
            ...r.ownerSuccessorBindings ?? [],
            structuredClone(proof.successorBinding),
          ],
          updatedAt: now,
        })
    ),
  };
}

export async function ownerSupersessionUnchanged(
  input: ReadInput,
  authority: OwnerSupersessionAuthority,
): Promise<boolean> {
  const expected = issued.get(authority);
  if (!expected) return false;
  const refreshed =
    await (expected.kind === "supersession"
      ? readOwnerSupersessionAuthority
      : expected.kind === "normal"
      ? readOwnerSupersededNormalAuthority
      : readOwnerSupersededRecoveryAuthority)(input);
  const actual = refreshed === undefined ? undefined : issued.get(refreshed);
  if (!actual) return false;
  if (expected.kind === "supersession") {
    if (
      actual.disposition.originalFailedPriorProof.observedAt <
        expected.disposition.originalFailedPriorProof.observedAt
    ) return false;
    const compared = structuredClone(actual);
    compared.disposition.originalFailedPriorProof.observedAt =
      expected.disposition.originalFailedPriorProof.observedAt;
    return canonicalStringify(compared) === canonicalStringify(expected);
  }
  return canonicalStringify(actual) === canonicalStringify(expected);
}

export async function readOwnerSupersededNormalAuthority(
  input: ReadInput,
): Promise<OwnerSupersessionAuthority | undefined> {
  const evidence = await readOwnerSupersededNormalEvidence(input);
  if (!evidence) return;
  const authority = Object.freeze({}) as OwnerSupersessionAuthority;
  issued.set(authority, { ...evidence, kind: "normal" });
  return authority;
}

/** Distinct first-F issuer: generic future recovery keeps its terminal-only acceptance unchanged. */
export async function readOwnerSupersededRecoveryAuthority(
  input: ReadInput,
): Promise<OwnerSupersessionAuthority | undefined> {
  try {
    const repair = await input.state.readRepair();
    if (
      !repair.ok || repair.value.status !== "found" ||
      !input.state.readReleaseAt
    ) return;
    const now = Date.now();
    const target = await readOwnerSupersededRecoveryTarget({
      snapshot: input.current.snapshot,
      repair: repair.value.snapshot,
      releaseHead: input.current.head,
      repairHead: repair.value.head,
      launcherSha: input.run.launcherSha,
      now,
      queue: input.queue,
      custody: input.custody,
      rollout: input.rollout,
    });
    if (!target) return;
    const pins = parseHostedRuntimeRollout(
      input.rollout ?? HOSTED_RUNTIME_ROLLOUT,
    );
    const runtime = input.current.snapshot.hostedRuntimes[0];
    const row = pins.recoveries.find((r) =>
      r.fromRevision === runtime.activeRevision &&
      r.fromGeneration === runtime.generation
    )!;
    const receipt = input.current.snapshot.hostedReleases.find((r) =>
      r.phase === "owner_superseded" && r.ownerDisposition !== undefined &&
      (r.ownerDisposition.intent.toRevision === runtime.activeRevision &&
          r.ownerDisposition.intent.toGeneration === runtime.generation ||
        r.ownerSuccessorBindings?.some((b) =>
          b.binding.successorRevision === runtime.activeRevision &&
          b.binding.successorGeneration === runtime.generation
        ))
    )!;
    const healthy = parseHostedRunProofV1(runtime.lastHealthyProof),
      failed = parseHostedRunProofV1(runtime.lastExecutionProof);
    if (
      healthy.outcome !== "healthy" || healthy.finishedAt > failed.startedAt ||
      healthy.observedAt > now ||
      canonicalStringify(healthy) !==
        canonicalStringify(receipt.ownerDisposition!.retainedHealthyProof)
    ) return;
    const witness = await input.state.readReleaseAt({
      commit: row.healthyWitnessHead,
      expectedHead: input.current.head,
    });
    if (
      !witness.ok || witness.value.status !== "found" ||
      witness.value.snapshot.hostedRuntimes.length !== 1 ||
      canonicalStringify(
          witness.value.snapshot.hostedRuntimes[0].lastHealthyProof,
        ) !== canonicalStringify(healthy)
    ) return;
    const snapshot = canonicalStringify(input.current.snapshot),
      repairText = canonicalStringify(repair.value.snapshot);
    const repairHead = repair.value.head;
    let rateLimited = false;
    const unchanged = async () => {
      const [r, p] = await Promise.all([
        input.state.readRelease(),
        input.state.readRepair(),
      ]);
      return !rateLimited && r.ok && r.value.status === "found" && p.ok &&
        p.value.status === "found" &&
        r.value.head === input.current.head && p.value.head === repairHead &&
        canonicalStringify(r.value.snapshot) === snapshot &&
        canonicalStringify(p.value.snapshot) === repairText &&
        ![
          ...r.value.snapshot.githubCooldowns,
          ...p.value.snapshot.githubCooldowns,
        ].some((c) =>
          c.retryNotBefore === null || Date.now() < c.retryNotBefore
        );
    };
    const client = new GitHubApiClient({
      repository: { owner: "ubiquity", name: "sentinel", installationId: 0 },
      apiBaseUrl: "https://api.github.com",
      http: fetchHttpTransport(),
      auth: {
        authorizationHeader: () =>
          Promise.resolve(portOk(`Bearer ${input.token}`)),
      },
      clock: { now: () => Date.now() },
      cooldownGate: {
        beforeRequest: async (scope) =>
          scope === 0 && await unchanged()
            ? portOk(undefined)
            : portError("unavailable", detail),
        recordRateLimit: () => {
          rateLimited = true;
          return Promise.resolve(portOk(undefined));
        },
      },
    });
    const binding = pins.ownerSuccessorTaskBindings.find((b) =>
      b.releaseId === receipt.id &&
      b.intentSha256 === receipt.ownerDisposition!.intentSha256 &&
      b.successorRevision === row.toRevision &&
      b.successorGeneration === row.toGeneration
    );
    let successorBinding: HostedOwnerSuccessorBindingV1 | undefined;
    if (receipt.ownerAcceptance === undefined) {
      if (
        !binding ||
        binding.requestSha256 !==
          receipt.ownerDisposition!.intent.requestSha256 ||
        binding.taskSha256 !== receipt.ownerDisposition!.intent.taskSha256 ||
        binding.workId !== receipt.ownerDisposition!.intent.workId ||
        binding.issueNumber !== receipt.ownerDisposition!.intent.issueNumber
      ) return;
      const task = await client.readIssue(binding.issueNumber);
      if (
        !task.ok || !task.value ||
        await reviewTaskStatementDigest({
            issueNumber: task.value.number,
            title: task.value.title,
            body: task.value.body,
          }) !== binding.taskSha256 ||
        !await ownerSupersessionSourceApproved(input, {
          ...receipt.ownerDisposition!.intent,
          toRevision: binding.successorRevision,
          toGeneration: binding.successorGeneration,
          controllerSourceRevision: binding.controllerSourceRevision,
          controllerCodeSha256: binding.controllerCodeSha256,
          ciRevision: binding.ciRevision,
        }, now)
      ) return;
      const bindingSha256 = await digest(binding);
      successorBinding = {
        id: `owner-successor-binding:${bindingSha256}`,
        binding,
        bindingSha256,
        controllerRevision: input.run.launcherSha,
        recoveryFromRevision: row.fromRevision,
        recoveryFromGeneration: row.fromGeneration,
        movement: "recovery",
        movementProof: structuredClone(failed),
        movementProofSha256: row.failedProofSha256,
      };
    }
    if (
      !await sourceApproved(input, row, now) ||
      !await nativeProof(client, healthy) ||
      !await nativeProof(client, failed) ||
      !await ownerStartupNativeQuiescent(input.token, input.run) ||
      !await unchanged()
    ) return;
    const authority = Object.freeze({}) as OwnerSupersessionAuthority;
    issued.set(authority, {
      kind: "recovery",
      releaseHead: input.current.head,
      row,
      disposition: structuredClone(receipt.ownerDisposition!),
      snapshot,
      repair: repairText,
      ...(successorBinding === undefined ? {} : { successorBinding }),
      policies: canonicalStringify({
        queue: input.queue ?? QUEUE_RUNTIME_CAPABILITY,
        custody: input.custody ?? EXISTING_PR_RUNTIME_CAPABILITY,
      }),
      run: Object.freeze({ ...input.run }),
    });
    return authority;
  } catch {
    return undefined;
  }
}

/** Failed first F stays held; this read-only route reaches the unchanged full future issuer. */
export async function readOwnerSupersededRecoveryTarget(
  input: TargetInput,
): Promise<{ revision: GitSha; generation: number } | undefined> {
  try {
    const pins = parseHostedRuntimeRollout(
      input.rollout ?? HOSTED_RUNTIME_ROLLOUT,
    );
    const snapshot = parseReleaseStateSnapshotV1(input.snapshot);
    const repair = parseRepairStateSnapshotV1(input.repair);
    const runtime = snapshot.hostedRuntimes[0];
    const failed = parseHostedRunProofV1(runtime?.lastExecutionProof);
    let receipt;
    for (const r of snapshot.hostedReleases) {
      if (
        await ownerSuccessorBindingFor(
          r,
          runtime?.activeRevision,
          runtime?.generation,
        )
      ) {
        if (receipt !== undefined) return;
        receipt = r;
      }
    }
    const row = pins.recoveries.find((r) =>
      r.fromRevision === runtime?.activeRevision &&
      r.fromGeneration === runtime.generation
    );
    if (
      !receipt?.ownerDisposition || !row || runtime.execution !== null ||
      snapshot.updatedAt > input.now || repair.updatedAt > input.now ||
      failed.outcome !== "failed" || failed.execution.purpose !== "bootstrap" ||
      failed.execution.releaseId !== null ||
      failed.execution.revision !== runtime.activeRevision ||
      failed.execution.generation !== runtime.generation ||
      await digest(failed) !== row.failedProofSha256 ||
      await digest(runtime.lastHealthyProof) !==
        row.retainedHealthyProofSha256 ||
      await digest(receipt.ownerDisposition.intent) !==
        receipt.ownerDisposition.intentSha256 ||
      snapshot.hostedReleases.some((r) =>
        !isHostedReleaseTerminal(r.phase) || r.pointerIntent !== null
      ) ||
      [...snapshot.githubCooldowns, ...repair.githubCooldowns].some((c) =>
        c.retryNotBefore === null || input.now < c.retryNotBefore
      ) ||
      failed.observedAt > input.now ||
      !await ownerSupersessionSourceData({
        launcherSha: input.launcherSha,
        queue: input.queue ?? QUEUE_RUNTIME_CAPABILITY,
        custody: input.custody ?? EXISTING_PR_RUNTIME_CAPABILITY,
        rollout: pins,
      })
    ) return;
    const queue = input.queue ?? QUEUE_RUNTIME_CAPABILITY,
      custody = input.custody ?? EXISTING_PR_RUNTIME_CAPABILITY;
    if (
      queue.proofActivated !== true || custody.custodyActivated !== true ||
      [queue, custody].some((p) =>
        !p.revisions.includes(row.fromRevision) ||
        !p.revisions.includes(row.toRevision)
      )
    ) return;
    if (
      receipt.ownerAcceptance === undefined &&
      !pins.ownerSuccessorTaskBindings.some((b) =>
        b.releaseId === receipt!.id &&
        b.intentSha256 === receipt!.ownerDisposition!.intentSha256 &&
        b.requestSha256 === receipt!.ownerDisposition!.intent.requestSha256 &&
        b.taskSha256 === receipt!.ownerDisposition!.intent.taskSha256 &&
        b.successorRevision === row.toRevision &&
        b.successorGeneration === row.toGeneration
      )
    ) return;
    return { revision: row.toRevision, generation: row.toGeneration };
  } catch {
    return undefined;
  }
}
