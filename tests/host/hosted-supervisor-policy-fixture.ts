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
interface FixturePolicy {
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
/** Actual host composition in a fresh graph; only its two policy JSON files differ. */
export async function runHostedSupervisorWithPolicy(
  policy: FixturePolicy,
  input: HostedSupervisorHostInputV1,
): Promise<HostedSupervisorHostResultV1> {
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
    const host = await import(
      pathToFileURL(root + "/src/host/actions-supervisor-host.ts").href
    );
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
  } finally {
    await Deno.remove(root, { recursive: true });
    await assert.rejects(() => Deno.lstat(root), Deno.errors.NotFound);
  }
}
