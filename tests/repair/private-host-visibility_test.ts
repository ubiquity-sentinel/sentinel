import {
  HOSTED_CONTROLLER_PROFILES,
  HostedControllerVisibilityRefusalV1,
} from "../../src/contracts/hosted-controller-deployment.ts";
import assert from "node:assert/strict";
import {
  PRIVATE_TARGET_REASON,
  PUBLIC_TARGET_REASON,
  type TargetVisibilityV1,
} from "../../src/repair/target-visibility.ts";
import {
  loadTargetConfigsV1,
  privateTargetsLineV1,
  type TargetSlugV1,
  unavailableTargetCountsV1,
} from "../../src/host/targets.ts";
import { parsePrivateTargetsLine } from "../../src/repair/private-targets-line.ts";
import { createLocalRepositoryConfig } from "../../src/host/local.ts";

const SETTING = [
  "ubiquity/ai.ubq.fi",
  "ubiquity/prospector",
  "ubiquity/stated-nothing",
];
const ANSWERS: Record<string, TargetVisibilityV1> = {
  "ai.ubq.fi": "public",
  prospector: "private",
  "stated-nothing": "unknown",
};

async function load(
  host: Parameters<typeof loadTargetConfigsV1>[0]["host"],
  setting: readonly string[] = SETTING,
) {
  const reads: string[] = [];
  const result = await loadTargetConfigsV1({
    template: createLocalRepositoryConfig(),
    readFile: () => Promise.resolve(JSON.stringify(setting)),
    resolveRepository: (target: TargetSlugV1) => {
      reads.push(target.slug);
      return Promise.resolve({
        defaultBranch: "main",
        visibility: ANSWERS[target.name] ?? "public",
      });
    },
    resolveTreeFacts: () =>
      Promise.resolve({ files: [], scripts: [], hasCiWorkflow: true }),
    host,
  });
  return { result, reads };
}

const configured = (result: Awaited<ReturnType<typeof load>>["result"]) =>
  result.configs.map((c) => `${c.repository.owner}/${c.repository.name}`);

const [publicProfile, privateProfile] = HOSTED_CONTROLLER_PROFILES;

Deno.test("a hosted target load requires an explicit host at compile time", () => {
  type Options = Parameters<typeof loadTargetConfigsV1>[0];
  const optional: Omit<Options, "host"> extends Options ? true : false = false;
  assert.equal(optional, false);
});

Deno.test("a contradictory listed self read refuses before even the first foreign target", async () => {
  const asked: string[] = [];
  await assert.rejects(
    loadTargetConfigsV1({
      template: createLocalRepositoryConfig(),
      readFile: () =>
        Promise.resolve(JSON.stringify([...SETTING, publicProfile.repository])),
      host: {
        profile: publicProfile,
        readVisibility: () => Promise.resolve("public"),
      },
      resolveRepository: (target) => {
        asked.push(target.slug);
        return Promise.resolve({
          defaultBranch: "development",
          visibility: "private",
        });
      },
    }),
    { reason: "deployment_visibility_mismatch" },
  );
  assert.deepEqual(asked, [publicProfile.repository]);
});

Deno.test("the bound public deployment reuses its listed target read and cannot switch target classes", async () => {
  const setting = [publicProfile.repository, ...SETTING];
  let hostReads = 0;
  const host = {
    profile: publicProfile,
    readVisibility: () => {
      hostReads++;
      return Promise.resolve("unknown" as const);
    },
  };
  const { result, reads } = await load(host, setting);
  assert.deepEqual(configured(result), [
    publicProfile.repository,
    "ubiquity/ai.ubq.fi",
  ]);
  assert.deepEqual(reads, setting);
  assert.equal(hostReads, 0);
  assert.deepEqual(privateTargetsLineV1(result), {
    kind: "sentinel_private_targets",
    reason: PRIVATE_TARGET_REASON,
    skipped: 1,
    listed: 4,
    configured: 2,
  });
});

Deno.test("mismatched or unproven private hosts refuse before reading foreign targets", async () => {
  for (
    const [profile, observed, reason] of [
      [publicProfile, "private", "deployment_visibility_mismatch"],
      [privateProfile, "public", "deployment_visibility_mismatch"],
      [privateProfile, "unknown", "deployment_visibility_unavailable"],
    ] as const
  ) {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line) => lines.push(line);
    try {
      await assert.rejects(
        load({ profile, readVisibility: () => Promise.resolve(observed) }),
        (error: unknown) =>
          error instanceof HostedControllerVisibilityRefusalV1 &&
          error.reason === reason,
      );
    } finally {
      console.log = original;
    }
    assert.deepEqual(lines.map((line) => JSON.parse(line)), [{
      kind: "sentinel_deployment_refused",
      reason,
      repository: profile.repository,
      expected: profile.targetVisibility,
      observed,
    }]);
  }
  await assert.rejects(
    load({
      profile: privateProfile,
      readVisibility: () => Promise.resolve("private"),
    }, [privateProfile.repository, ...SETTING]),
    { reason: "private_controller_self_listed" },
  );
});

Deno.test("private host: private targets are configured, public ones are left to the public deployment, unknown is skipped", async () => {
  let hostReads = 0;
  const { result, reads } = await load({
    profile: privateProfile,
    readVisibility: () => {
      hostReads++;
      return Promise.resolve("private");
    },
  });
  assert.equal(hostReads, 1, "one host read per load");
  assert.deepEqual(reads, SETTING, "one repository read per target, in order");
  assert.deepEqual(configured(result), ["ubiquity/prospector"]);
  assert.deepEqual(result.publicTargets, ["ubiquity/ai.ubq.fi"]);
  assert.deepEqual(result.privateTargets, []);
  assert.deepEqual(result.skipped, ["ubiquity/stated-nothing"]);
  const line = privateTargetsLineV1(result);
  assert.deepEqual(line, {
    kind: "sentinel_private_targets",
    reason: PUBLIC_TARGET_REASON,
    skipped: 1,
    listed: 3,
    configured: 1,
  });
  assert.deepEqual(parsePrivateTargetsLine(line), line);
  // A public skip is never a read failure.
  const publicOnly = await load({
    profile: privateProfile,
    readVisibility: () => Promise.resolve("private"),
  }, ["ubiquity/ai.ubq.fi"]);
  assert.deepEqual(publicOnly.result.configs, []);
  assert.equal(unavailableTargetCountsV1(publicOnly.result), null);
});
