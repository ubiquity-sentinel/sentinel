import assert from "node:assert/strict";
import { cp } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  HostedSupervisorHostInputV1,
  HostedSupervisorHostResultV1,
} from "../../src/host/actions-supervisor-host.ts";
import { parseHostedCustodyCapability } from "../../src/host/hosted-custody-capability.ts";
import { parseHostedRuntimeRollout } from "../../src/host/hosted-runtime-rollout.ts";
import type { HostedRuntimeRollout } from "../../src/host/hosted-runtime-rollout.ts";
import type { QueueRuntimeCapability } from "../../src/host/queue-runtime-capability.ts";
import type { ExistingPrRuntimeCapability } from "../../src/host/existing-pr-runtime-capability.ts";

const dormant = parseHostedCustodyCapability({
  version: 1,
  takeover: { activated: false },
  queue: { proofActivated: false, revisions: [], ownerInstallMigrations: [] },
  existingPr: {
    custodyActivated: false,
    revisions: [],
    ownerInstallMigrations: [],
  },
});
/** Historical scenarios choose policy instead of inheriting the installed launcher. */
export const DORMANT_HOSTED_SUPERVISOR_POLICY = {
  queue: dormant.queue,
  custody: dormant.existingPr,
  rollout: parseHostedRuntimeRollout({
    version: 1,
    installs: [],
    ciCorrection: [],
    refreshRearm: [],
    conflictResolution: [],
    ciFirst: [],
    ciFirstFix: [],
    acceptanceCorrection: [],
    legacyReview: [],
    recoveries: [],
    ownerSupersessions: [],
    ownerSuccessorTaskBindings: [],
  }),
};
export interface FixturePolicy {
  queue: QueueRuntimeCapability;
  custody: ExistingPrRuntimeCapability;
  rollout: HostedRuntimeRollout;
}
async function files(root: string, prefix: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(root + "/" + prefix)) {
    const path = prefix + "/" + entry.name;
    assert.equal(entry.isSymlink, false, "production graph has no symlink");
    if (entry.isDirectory) found.push(...await files(root, path));
    else {
      assert.ok(entry.isFile);
      found.push(path);
    }
  }
  return found.sort();
}
/** Every loader resolves within one private graph, including opaque capability owners. */
export interface HostedPolicyGraph {
  supervisorHost(): Promise<
    typeof import("../../src/host/actions-supervisor-host.ts")
  >;
  runner(): Promise<typeof import("../../ops/hosted-autonomy-runner.ts")>;
  deliveryPass(): Promise<
    typeof import("../../ops/hosted-autonomy-delivery-pass.ts")
  >;
  scopes(): Promise<typeof import("../../ops/hosted-autonomy-scopes.ts")>;
  closedIssues(): Promise<
    typeof import("../../ops/hosted-autonomy-retry-pass.ts")
  >;
  followUps(): Promise<
    typeof import("../../ops/hosted-autonomy-follow-ups.ts")
  >;
  queueProof(): Promise<
    typeof import("../../ops/hosted-autonomy-queue-proof.ts")
  >;
  deliveryProof(): Promise<
    typeof import("../../ops/hosted-autonomy-delivery-proof.ts")
  >;
}

/** Historical/configuration fixture graph; only its two policy JSON files differ. */
export async function withHostedProductionPolicy<T>(
  policy: FixturePolicy,
  consume: (graph: HostedPolicyGraph) => Promise<T>,
): Promise<T> {
  const source = fileURLToPath(new URL("../../", import.meta.url)).replace(
    /\/$/,
    "",
  );
  const scratch = source + "/.sentinel-artifacts";
  await Deno.mkdir(scratch, { recursive: true });
  const root = await Deno.makeTempDir({
    dir: scratch,
    prefix: "supervisor-policy-",
  });
  const changed = new Set([
    "src/host/hosted-custody-capability.json",
    "src/host/hosted-runtime-rollout.json",
  ]);
  try {
    for (const name of ["src", "ops"]) {
      await cp(source + "/" + name, root + "/" + name, { recursive: true });
    }
    for (const name of ["deno.json", "deno.lock"]) {
      await Deno.copyFile(source + "/" + name, root + "/" + name);
    }
    const expected = [
      ...await files(source, "src"),
      ...await files(source, "ops"),
      "deno.json",
      "deno.lock",
    ].sort();
    const actual = [
      ...await files(root, "src"),
      ...await files(root, "ops"),
      "deno.json",
      "deno.lock",
    ].sort();
    assert.deepEqual(actual, expected);
    assert.ok(expected.length > 100, "copy the real production graph");
    await Deno.writeTextFile(
      root + "/src/host/hosted-custody-capability.json",
      JSON.stringify(parseHostedCustodyCapability({
        version: 1,
        takeover: { activated: false },
        queue: { ownerInstallMigrations: [], ...policy.queue },
        existingPr: { ownerInstallMigrations: [], ...policy.custody },
      })),
    );
    await Deno.writeTextFile(
      root + "/src/host/hosted-runtime-rollout.json",
      JSON.stringify(parseHostedRuntimeRollout(policy.rollout)),
    );
    for (const path of expected) {
      if (!changed.has(path)) {
        assert.deepEqual(
          await Deno.readFile(root + "/" + path),
          await Deno.readFile(source + "/" + path),
          path,
        );
      }
    }
    const load = (path: string) =>
      import(pathToFileURL(root + "/" + path).href);
    return await consume({
      supervisorHost: () => load("src/host/actions-supervisor-host.ts"),
      runner: () => load("ops/hosted-autonomy-runner.ts"),
      deliveryPass: () => load("ops/hosted-autonomy-delivery-pass.ts"),
      scopes: () => load("ops/hosted-autonomy-scopes.ts"),
      closedIssues: () => load("ops/hosted-autonomy-retry-pass.ts"),
      followUps: () => load("ops/hosted-autonomy-follow-ups.ts"),
      queueProof: () => load("ops/hosted-autonomy-queue-proof.ts"),
      deliveryProof: () => load("ops/hosted-autonomy-delivery-proof.ts"),
    });
  } finally {
    await Deno.remove(root, { recursive: true });
    await assert.rejects(() => Deno.lstat(root), Deno.errors.NotFound);
  }
}

/** Actual host composition retains native job/source guards and fixture cleanup. */
export function runHostedSupervisorWithPolicy(
  policy: FixturePolicy,
  input: HostedSupervisorHostInputV1,
): Promise<HostedSupervisorHostResultV1> {
  return withHostedProductionPolicy(policy, async (graph) => {
    const host = await graph.supervisorHost();
    await assert.rejects(
      () =>
        host.runHostedSupervisorHost({
          ...input,
          env: { ...input.env, GITHUB_JOB: "repair" },
        }),
      { message: host.STATIC_JOB },
    );
    await assert.rejects(
      () =>
        host.runHostedSupervisorHost({
          ...input,
          env: {
            ...input.env,
            GITHUB_SHA: "0".repeat(40),
            GITHUB_WORKFLOW_SHA: "0".repeat(40),
          },
        }),
      { message: host.STATIC_SOURCE_CHECKOUT },
    );
    return await host.runHostedSupervisorHost(input);
  });
}
