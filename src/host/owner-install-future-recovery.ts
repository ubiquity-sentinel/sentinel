/** Exact reviewed fix-forward authority; no state writer or historical admission bypass. */
import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import {
  parseHostedExecutionIntentV1,
  parseHostedRunProofV1,
} from "../contracts/hosted-supervisor.ts";
import type { HostedRunProofV1 } from "../contracts/hosted-supervisor.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { StateReadView } from "../contracts/ports.ts";
import type { ReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../contracts/state-snapshots.ts";
import { GitHubApiClient } from "../github/client.ts";
import { fetchHttpTransport } from "../github/http.ts";
import { DenoReplayRuntime } from "../replay/runtime.ts";
import {
  parseHostedAppSourceProfiles,
  readHostedAppSourceManifest,
} from "./hosted-app-principal-source.ts";
import { allowsHostedRuntimeMove } from "./hosted-runtime-compatibility.ts";
import { parseHostedCustodyCapability } from "./hosted-custody-capability.ts";
import {
  HOSTED_RUNTIME_ROLLOUT,
  parseHostedRuntimeRollout,
} from "./hosted-runtime-rollout.ts";
import type {
  HostedRuntimeRecovery,
  HostedRuntimeRollout,
  HostedRuntimeRolloutInstall,
} from "./hosted-runtime-rollout.ts";
import {
  QUEUE_RUNTIME_CAPABILITY,
  type QueueRuntimeCapability,
  type QueueRuntimeMigration,
} from "./queue-runtime-capability.ts";
import {
  EXISTING_PR_RUNTIME_CAPABILITY,
  type ExistingPrRuntimeCapability,
} from "./existing-pr-runtime-capability.ts";
import {
  OWNER_DEVELOPMENT_INSTALL_GEN80_REVISION,
  OWNER_DEVELOPMENT_INSTALL_GEN81_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_GEN81_REVISION,
} from "./owner-install-runtime-pins.ts";
import { movePlan, waiting } from "./owner-install-plan-proof.ts";
import type {
  OwnerDevelopmentInstallMoveV1,
  OwnerDevelopmentInstallPlanV1,
  OwnerDevelopmentInstallStateReadV1,
} from "./owner-install-types.ts";
import {
  ownerStartupNativeQuiescent,
  ownerStartupSourceHead,
} from "./owner-install-startup-evidence.ts";
import { verifyOwnerDevelopmentInstallRevision } from "./owner-install-state.ts";
import {
  ownerDevelopmentInstallApi,
  sha256HexText,
  testLocalCheckSucceeded,
} from "./owner-install-api.ts";

declare const issuedAuthority: unique symbol;
export interface OwnerFutureRecoveryAuthority {
  readonly [issuedAuthority]: true;
}
type Run = {
  readonly runId: number;
  readonly runAttempt: number;
  readonly launcherSha: GitSha;
};
type Current = Extract<OwnerDevelopmentInstallStateReadV1, { status: "found" }>;
export type ReadInput = {
  state: StateReadView;
  token: string;
  current: Current;
  run: Run;
  queue?: QueueRuntimeCapability;
  custody?: ExistingPrRuntimeCapability;
  rollout?: HostedRuntimeRollout;
};
type Verified = {
  row: HostedRuntimeRecovery;
  classification: { kind: "future" } | {
    kind: "legacy_first";
    install: HostedRuntimeRolloutInstall;
  };
  capability: { sha256: string; policies: string } | null;
  snapshot: string;
  releaseHead: GitSha;
  repairHead: GitSha;
  repair: string;
  healthy: HostedRunProofV1;
  run: Run;
};
const issued = new WeakMap<OwnerFutureRecoveryAuthority, Verified>();
const detail = "exact future recovery authority is unavailable";

/** The immutable legacy tuple is classified before generic future eligibility. */
function classify(
  row: HostedRuntimeRecovery,
  pins: HostedRuntimeRollout,
  queue: QueueRuntimeCapability,
  custody: ExistingPrRuntimeCapability,
): Verified["classification"] | undefined {
  if (queue.proofActivated !== true || custody.custodyActivated !== true) {
    return;
  }
  if (row.fromRevision === OWNER_DEVELOPMENT_INSTALL_GEN80_REVISION) return;
  if (row.fromRevision !== OWNER_DEVELOPMENT_INSTALL_GEN81_REVISION) {
    return allowsHostedRuntimeMove(
        row.fromRevision,
        row.toRevision,
        queue,
        custody,
      )
      ? { kind: "future" }
      : undefined;
  }
  const exact = (pin: QueueRuntimeMigration) =>
    pin.fromRevision === row.fromRevision &&
    pin.fromGeneration === row.fromGeneration &&
    pin.toRevision === row.toRevision && pin.toGeneration === row.toGeneration;
  const old = [
    OWNER_DEVELOPMENT_INSTALL_GEN80_REVISION,
    OWNER_DEVELOPMENT_INSTALL_GEN81_REVISION,
  ];
  const install = pins.installs.find((pin) =>
    exact(pin) && !pin.rollbackToPrior
  );
  if (
    row.fromGeneration !== OWNER_DEVELOPMENT_INSTALL_GEN81_GENERATION ||
    row.toGeneration !== OWNER_DEVELOPMENT_INSTALL_GEN81_GENERATION + 1 ||
    old.includes(row.toRevision) || !install ||
    [queue, custody].some((policy) =>
      !policy.revisions.includes(row.toRevision) || old.some((revision) =>
        policy.revisions.includes(revision)
      ) ||
      !policy.ownerInstallMigrations?.some(exact)
    )
  ) return;
  return { kind: "legacy_first", install };
}

/** Pure consumer guard, bound to the issued row, state, exact move and source policy. */
export function allowsOwnerFutureRecoveryMove(
  snapshot: ReleaseStateSnapshotV1,
  move: OwnerDevelopmentInstallMoveV1,
  authority: OwnerFutureRecoveryAuthority,
  queue: QueueRuntimeCapability = QUEUE_RUNTIME_CAPABILITY,
  custody: ExistingPrRuntimeCapability = EXISTING_PR_RUNTIME_CAPABILITY,
  rollout: HostedRuntimeRollout = HOSTED_RUNTIME_ROLLOUT,
): boolean {
  try {
    const proof = issued.get(authority);
    if (!proof) return false;
    const plan = planOwnerFutureRecovery(snapshot, authority, rollout);
    return plan.status === "install" &&
      canonicalStringify(plan.move) === canonicalStringify(move) &&
      canonicalStringify(
          classify(
            proof.row,
            parseHostedRuntimeRollout(rollout),
            queue,
            custody,
          ),
        ) ===
        canonicalStringify(proof.classification) &&
      (proof.capability === null ||
        proof.capability.policies === canonicalStringify({ queue, custody }));
  } catch {
    return false;
  }
}

/** Row equality and snapshot equality are required in addition to opaque issuance. */
export function planOwnerFutureRecovery(
  snapshot: ReleaseStateSnapshotV1,
  authority: OwnerFutureRecoveryAuthority,
  rollout: HostedRuntimeRollout = HOSTED_RUNTIME_ROLLOUT,
): OwnerDevelopmentInstallPlanV1 {
  const proof = issued.get(authority);
  try {
    if (
      !proof || proof.snapshot !== canonicalStringify(snapshot) ||
      !parseHostedRuntimeRollout(rollout).recoveries.some((row) =>
        canonicalStringify(row) === canonicalStringify(proof.row)
      )
    ) return waiting(detail);
    const runtime = snapshot.hostedRuntimes[0];
    return movePlan(
      "install",
      runtime,
      proof.row.toRevision,
      proof.row.toGeneration,
      proof.healthy,
      "install the exact reviewed future recovery with a model-disabled bootstrap",
    );
  } catch {
    return waiting(detail);
  }
}

/** Only a genuine issued token can bind an atomic snapshot bootstrap intent. */
export function ownerFutureRecoveryBootstrap(
  authority: OwnerFutureRecoveryAuthority,
  head: GitSha,
  now: number,
) {
  const proof = issued.get(authority);
  if (!proof || proof.releaseHead !== head) throw new Error(detail);
  return parseHostedExecutionIntentV1({
    id: `${proof.run.runId}:${proof.run.runAttempt}:repair`,
    ...proof.run,
    purpose: "bootstrap",
    releaseId: null,
    revision: proof.row.toRevision,
    generation: proof.row.toGeneration,
    createdAt: now,
  });
}

export async function sourceData(path: string): Promise<string> {
  const root = await Deno.realPath(Deno.cwd());
  const file = `${root}/${path}`;
  const info = await Deno.lstat(file);
  if (
    !info.isFile || info.isSymlink || info.size > 512 * 1024 ||
    await Deno.realPath(file) !== file
  ) throw new Error(detail);
  const result = await new Deno.Command("git", {
    args: [
      "--no-replace-objects",
      "-c",
      "core.hooksPath=/dev/null",
      "show",
      `HEAD:${path}`,
    ],
    cwd: root,
    clearEnv: true,
    env: {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      HOME: root,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
    stdout: "piped",
    stderr: "null",
    signal: AbortSignal.timeout(10_000),
  }).output();
  if (!result.success || result.stdout.length > 512 * 1024) {
    throw new Error(detail);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  if (await Deno.readTextFile(file) !== text) throw new Error(detail);
  return text;
}

/** Inert maintenance routing only; full native issuance remains mandatory in prepare. */
export async function readOwnerLegacyFirstRecoveryTarget(input: {
  snapshot: ReleaseStateSnapshotV1;
  repair: RepairStateSnapshotV1;
  launcherSha: GitSha;
  now: number;
  queue?: QueueRuntimeCapability;
  custody?: ExistingPrRuntimeCapability;
  rollout?: HostedRuntimeRollout;
}): Promise<{ revision: GitSha; generation: number } | undefined> {
  try {
    const { now } = input;
    if (!Number.isSafeInteger(now) || now < 0) return;
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
    const row = pins.recoveries.find((row) =>
      row.fromRevision === runtime?.activeRevision &&
      row.fromGeneration === runtime.generation
    );
    if (
      !runtime || !row || runtime.execution !== null ||
      classify(row, pins, queue, custody)?.kind !== "legacy_first" ||
      snapshot.updatedAt > now || repair.updatedAt > now ||
      snapshot.hostedReleases.some((release) =>
        release.pointerIntent !== null ||
        !["accepted", "rolled_back"].includes(release.phase)
      ) ||
      [...snapshot.githubCooldowns, ...repair.githubCooldowns].some((hold) =>
        hold.retryNotBefore === null || now < hold.retryNotBefore
      )
    ) return;
    const failed = parseHostedRunProofV1(runtime.lastExecutionProof);
    const healthy = parseHostedRunProofV1(runtime.lastHealthyProof);
    if (
      failed.outcome !== "failed" || failed.execution.purpose !== "ordinary" ||
      failed.execution.releaseId !== null ||
      failed.execution.revision !== row.fromRevision ||
      failed.execution.generation !== row.fromGeneration ||
      healthy.outcome !== "healthy" ||
      healthy.execution.purpose !== "ordinary" ||
      healthy.execution.releaseId !== null ||
      healthy.execution.revision !== row.fromRevision ||
      healthy.execution.generation !== row.fromGeneration ||
      healthy.finishedAt > failed.startedAt || failed.observedAt > now ||
      healthy.observedAt > now ||
      await sha256HexText(canonicalStringify(failed)) !==
        row.failedProofSha256 ||
      await sha256HexText(canonicalStringify(healthy)) !==
        row.retainedHealthyProofSha256 ||
      await ownerStartupSourceHead() !== input.launcherSha
    ) return;
    const sourcePins = parseHostedRuntimeRollout(
      JSON.parse(await sourceData("src/host/hosted-runtime-rollout.json")),
    );
    const source = parseHostedCustodyCapability(
      JSON.parse(await sourceData("src/host/hosted-custody-capability.json")),
    );
    if (
      canonicalStringify(sourcePins) !== canonicalStringify(pins) ||
      canonicalStringify({
          queue: source.queue,
          custody: source.existingPr,
        }) !== canonicalStringify({ queue, custody })
    ) return;
    return Object.freeze({
      revision: row.toRevision,
      generation: row.toGeneration,
    });
  } catch {
    return undefined;
  }
}

export async function sourceApproved(
  input: ReadInput,
  row: HostedRuntimeRecovery,
  now: number,
): Promise<boolean> {
  if (await ownerStartupSourceHead() !== input.run.launcherSha) return false;
  const root = await Deno.realPath(Deno.cwd());
  const rollout = parseHostedRuntimeRollout(
    JSON.parse(await sourceData("src/host/hosted-runtime-rollout.json")),
  );
  if (
    canonicalStringify(rollout) !==
      canonicalStringify(input.rollout ?? HOSTED_RUNTIME_ROLLOUT)
  ) return false;
  const profiles = parseHostedAppSourceProfiles(
    JSON.parse(await sourceData("src/host/hosted-app-source-profiles.json")),
  );
  const intent = parseHostedExecutionIntentV1({
    id: `${input.run.runId}:${input.run.runAttempt}:repair`,
    ...input.run,
    purpose: "bootstrap",
    releaseId: null,
    revision: row.toRevision,
    generation: row.toGeneration,
    createdAt: now,
  });
  // This is the intended child identity for a source manifest, never principal evidence.
  const manifest = await readHostedAppSourceManifest({
    launcherDir: root,
    runtimeDir: root,
    identity: { ...input.run, job: "repair" },
    execution: intent,
    process: new DenoReplayRuntime(Deno.env.get("PATH") ?? "/usr/bin:/bin"),
  }, root);
  const targets = await sha256HexText(
    await Deno.readTextFile(`${root}/sentinel.targets.json`),
  );
  if (
    !profiles.some((profile) =>
      profile.codeSha256 === manifest.digest &&
      profile.targetsSha256 === targets
    )
  ) return false;
  const controller = await ownerDevelopmentInstallApi(
    input.token,
    "GET",
    `/repos/ubiquity-sentinel/sentinel/commits/${input.run.launcherSha}/check-runs?per_page=100`,
  );
  if (
    !controller.ok || controller.value.status !== 200 ||
    !testLocalCheckSucceeded(controller.value.value, input.run.launcherSha)
  ) return false;
  const candidate = await verifyOwnerDevelopmentInstallRevision(
    input.token,
    row.toRevision,
  );
  return candidate.verified;
}

/** Full generic native proof comparison; observation freshness never changes saved digest identity. */
export async function nativeProof(
  client: GitHubApiClient,
  saved: HostedRunProofV1,
): Promise<boolean> {
  const result = await client.readHostedExecution(saved.execution);
  if (
    !result.ok || result.value === null ||
    result.value.outcome === "not_started"
  ) return false;
  const fresh = parseHostedRunProofV1(result.value);
  return saved.observedAt <= fresh.observedAt &&
    fresh.observedAt <= Date.now() &&
    canonicalStringify({ ...fresh, observedAt: saved.observedAt }) ===
      canonicalStringify(saved);
}

/** Read-only issuer: exact state ancestry, complete native proofs, reviewed source and both floors. */
export async function readOwnerFutureRecoveryAuthority(
  input: ReadInput,
): Promise<OwnerFutureRecoveryAuthority | undefined> {
  try {
    const pins = parseHostedRuntimeRollout(
      input.rollout ?? HOSTED_RUNTIME_ROLLOUT,
    );
    const runtime = input.current.snapshot.hostedRuntimes.length === 1
      ? input.current.snapshot.hostedRuntimes[0]
      : undefined;
    const row = pins.recoveries.find((row) =>
      row.fromRevision === runtime?.activeRevision &&
      row.fromGeneration === runtime.generation
    );
    const classification = row === undefined ? undefined : classify(
      row,
      pins,
      input.queue ?? QUEUE_RUNTIME_CAPABILITY,
      input.custody ?? EXISTING_PR_RUNTIME_CAPABILITY,
    );
    if (
      !runtime || !row || runtime.execution !== null ||
      !input.state.readReleaseAt ||
      input.current.snapshot.hostedReleases.some((release) =>
        release.pointerIntent !== null ||
        !["accepted", "rolled_back"].includes(release.phase)
      ) ||
      !classification
    ) return undefined;
    const failed = parseHostedRunProofV1(runtime.lastExecutionProof);
    const healthy = parseHostedRunProofV1(runtime.lastHealthyProof);
    const now = Date.now();
    if (
      failed.outcome !== "failed" || healthy.outcome !== "healthy" ||
      failed.execution.revision !== row.fromRevision ||
      failed.execution.generation !== row.fromGeneration ||
      failed.execution.releaseId !== null ||
      !["bootstrap", "ordinary"].includes(failed.execution.purpose) ||
      (classification.kind === "legacy_first" &&
        (failed.execution.purpose !== "ordinary" ||
          healthy.execution.purpose !== "ordinary" ||
          healthy.execution.releaseId !== null ||
          healthy.execution.revision !==
            OWNER_DEVELOPMENT_INSTALL_GEN81_REVISION ||
          healthy.execution.generation !==
            OWNER_DEVELOPMENT_INSTALL_GEN81_GENERATION)) ||
      healthy.finishedAt > failed.startedAt || failed.observedAt > now ||
      input.current.snapshot.updatedAt > now ||
      await sha256HexText(canonicalStringify(failed)) !==
        row.failedProofSha256 ||
      await sha256HexText(canonicalStringify(healthy)) !==
        row.retainedHealthyProofSha256
    ) return undefined;
    const witness = await input.state.readReleaseAt({
      commit: row.healthyWitnessHead,
      expectedHead: input.current.head,
    });
    const repair = await input.state.readRepair();
    if (
      !witness.ok || witness.value.status !== "found" || !repair.ok ||
      repair.value.status !== "found" ||
      witness.value.snapshot.hostedRuntimes.length !== 1 ||
      canonicalStringify(
          witness.value.snapshot.hostedRuntimes[0].lastHealthyProof,
        ) !== canonicalStringify(healthy)
    ) return undefined;
    const snapshot = canonicalStringify(input.current.snapshot);
    const repairText = canonicalStringify(repair.value.snapshot);
    const repairHead = repair.value.head;
    let rateLimited = false;
    const headsUnchanged = async () => {
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
        ].some((hold) =>
          hold.retryNotBefore === null || Date.now() < hold.retryNotBefore
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
          scope === 0 && await headsUnchanged()
            ? portOk(undefined)
            : portError("unavailable", detail),
        recordRateLimit: () => {
          rateLimited = true;
          return Promise.resolve(portOk(undefined));
        },
      },
    });
    let capability: Verified["capability"] = null;
    if (classification.kind === "legacy_first") {
      const text = await sourceData("src/host/hosted-custody-capability.json");
      const source = parseHostedCustodyCapability(JSON.parse(text));
      const policies = canonicalStringify({
        queue: source.queue,
        custody: source.existingPr,
      });
      if (
        policies !==
          canonicalStringify({ queue: input.queue, custody: input.custody })
      ) return;
      capability = Object.freeze({
        sha256: await sha256HexText(text),
        policies,
      });
    }
    if (
      !await headsUnchanged() || !await sourceApproved(input, row, now) ||
      !await nativeProof(client, healthy) ||
      !await nativeProof(client, failed) ||
      !await ownerStartupNativeQuiescent(input.token, input.run) ||
      !await headsUnchanged()
    ) return undefined;
    const authority = Object.freeze({}) as OwnerFutureRecoveryAuthority;
    issued.set(
      authority,
      Object.freeze({
        row,
        classification: Object.freeze(classification),
        capability,
        snapshot,
        releaseHead: input.current.head,
        repairHead: repair.value.head,
        repair: repairText,
        healthy: Object.freeze({
          ...healthy,
          execution: Object.freeze({ ...healthy.execution }),
        }),
        run: Object.freeze({ ...input.run }),
      }),
    );
    return authority;
  } catch {
    return undefined;
  }
}

/** Re-read every proof/source/head gate immediately before the existing trusted CAS. */
export async function ownerFutureRecoveryUnchanged(
  input: ReadInput,
  authority: OwnerFutureRecoveryAuthority,
): Promise<boolean> {
  const expected = issued.get(authority);
  if (!expected) return false;
  const refreshed = await readOwnerFutureRecoveryAuthority(input);
  const actual = refreshed === undefined ? undefined : issued.get(refreshed);
  return actual !== undefined &&
    canonicalStringify(actual) === canonicalStringify(expected);
}
