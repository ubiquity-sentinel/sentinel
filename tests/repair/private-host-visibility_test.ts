/**
 * The deployment rule (`src/repair/target-visibility.ts`): only a host
 * GitHub answers is private, and that does not list its own repository,
 * works private targets, and then only those. Every other host loads
 * exactly what the public-only load loads, with the same reads.
 */
import assert from "node:assert/strict";
import {
  PRIVATE_TARGET_REASON,
  PUBLIC_TARGET_REASON,
  resolveSentinelHostV1,
  sentinelWorksRepositoryV1,
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

Deno.test("private host: the predicate flips only on a host proven private that does not work itself", () => {
  const privateHost = { visibility: "private" as const, worksItself: false };
  for (const visibility of ["public", "private", "unknown"] as const) {
    assert.equal(
      sentinelWorksRepositoryV1(visibility),
      visibility === "public",
    );
    for (
      const host of [
        { visibility: "public" as const, worksItself: false },
        { visibility: "unknown" as const, worksItself: false },
        { visibility: "private" as const, worksItself: true },
      ]
    ) {
      assert.equal(
        sentinelWorksRepositoryV1(visibility, host),
        sentinelWorksRepositoryV1(visibility),
        `${visibility} on ${JSON.stringify(host)}`,
      );
    }
    assert.equal(
      sentinelWorksRepositoryV1(visibility, privateHost),
      visibility === "private",
    );
  }
});

Deno.test("private host: a host that lists itself is never read; a bad repository or a failed read is unknown", async () => {
  let reads = 0;
  const readVisibility = () => {
    reads++;
    return Promise.resolve("private" as const);
  };
  assert.deepEqual(
    await resolveSentinelHostV1({
      repository: "Ubiquity-Sentinel/Sentinel",
      listed: ["ubiquity-sentinel/sentinel", "ubiquity/prospector"],
      readVisibility,
    }),
    { visibility: "unknown", worksItself: true },
  );
  for (const repository of [undefined, null, "", "sentinel", "a/b/c", " a/b"]) {
    assert.deepEqual(
      await resolveSentinelHostV1({ repository, listed: [], readVisibility }),
      { visibility: "unknown", worksItself: false },
    );
  }
  assert.equal(reads, 0, "never read for a listed or malformed host");
  assert.deepEqual(
    await resolveSentinelHostV1({
      repository: "ubiquity-sentinel-private/sentinel",
      listed: ["ubiquity-sentinel/sentinel"],
      readVisibility: () => Promise.reject(new Error("unreadable")),
    }),
    { visibility: "unknown", worksItself: false },
  );
});

Deno.test("private host: a public host, an unknown host and a self-listed host load exactly the public-only load", async () => {
  const baseline = await load(undefined);
  assert.deepEqual(configured(baseline.result), ["ubiquity/ai.ubq.fi"]);
  for (
    const [name, host, setting] of [
      ["public host", {
        repository: "ubiquity-sentinel/sentinel",
        readVisibility: () => Promise.resolve("public" as const),
      }, SETTING],
      ["unreadable host", {
        repository: "ubiquity-sentinel/sentinel",
        readVisibility: () => Promise.reject(new Error("503")),
      }, SETTING],
      ["unstated host", {
        repository: "ubiquity-sentinel/sentinel",
        readVisibility: () => Promise.resolve("unknown" as const),
      }, SETTING],
      ["no repository", {
        repository: undefined,
        readVisibility: () => Promise.resolve("private" as const),
      }, SETTING],
    ] as const
  ) {
    const loaded = await load(host, setting);
    assert.deepEqual(loaded.result, baseline.result, name);
    assert.deepEqual(loaded.reads, baseline.reads, name);
    assert.deepEqual(
      privateTargetsLineV1(loaded.result),
      privateTargetsLineV1(baseline.result),
      name,
    );
  }
  // The production shape: the public deployment lists itself. GitHub's
  // answer about it is never asked, even one that would say private.
  const selfListed = ["ubiquity-sentinel/sentinel", ...SETTING];
  const plain = await load(undefined, selfListed);
  let hostReads = 0;
  const listed = await load({
    repository: "ubiquity-sentinel/sentinel",
    readVisibility: () => {
      hostReads++;
      return Promise.resolve("private");
    },
  }, selfListed);
  assert.equal(hostReads, 0);
  assert.deepEqual(listed.result, plain.result);
  assert.deepEqual(listed.reads, plain.reads);
  assert.equal(listed.result.publicTargets, undefined);
  assert.deepEqual(privateTargetsLineV1(listed.result), {
    kind: "sentinel_private_targets",
    reason: PRIVATE_TARGET_REASON,
    skipped: 1,
    listed: 4,
    configured: 2,
  });
});

Deno.test("private host: private targets are configured, public ones are left to the public deployment, unknown is skipped", async () => {
  let hostReads = 0;
  const { result, reads } = await load({
    repository: "ubiquity-sentinel-private/sentinel",
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
    repository: "ubiquity-sentinel-private/sentinel",
    readVisibility: () => Promise.resolve("private"),
  }, ["ubiquity/ai.ubq.fi"]);
  assert.deepEqual(publicOnly.result.configs, []);
  assert.equal(unavailableTargetCountsV1(publicOnly.result), null);
});
