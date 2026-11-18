import assert from "node:assert/strict";
import {
  repositoryVisibilityV1,
  sentinelWorksRepositoryV1,
} from "../../src/repair/target-visibility.ts";
import {
  loadTargetConfigsV1,
  privateTargetsLineV1,
  unavailableTargetCountsV1,
} from "../../src/host/targets.ts";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import { touchesProtected } from "../../src/repair/loop-records.ts";

Deno.test("target visibility: only GitHub's explicit public answer is public", () => {
  for (
    const [body, expected] of [
      [{ private: false, visibility: "public" }, "public"],
      [{ private: false }, "public"],
      [{ private: true }, "private"],
      [{ private: true, visibility: "private" }, "private"],
      [{ private: false, visibility: "private" }, "private"],
      [{ private: false, visibility: "internal" }, "private"],
      [{ visibility: "public" }, "unknown"],
      [{ private: "false", visibility: "public" }, "unknown"],
      [{ private: false, visibility: "secret" }, "unknown"],
      [{ private: null }, "unknown"],
      [{}, "unknown"],
      [[], "unknown"],
      [null, "unknown"],
      ["public", "unknown"],
    ] as const
  ) {
    assert.equal(repositoryVisibilityV1(body), expected, JSON.stringify(body));
  }
  assert.equal(sentinelWorksRepositoryV1("public"), true);
  assert.equal(sentinelWorksRepositoryV1("private"), false);
  assert.equal(sentinelWorksRepositoryV1("unknown"), false);
});

Deno.test("target visibility: the load configures public targets only; private is never a read failure", async () => {
  const visibility: Record<string, "public" | "private" | "unknown" | null> = {
    "ubiquity/public-a": "public",
    "ubiquity/private-b": "private",
    "ubiquity/unknown-c": "unknown",
    "ubiquity/gone-d": null,
  };
  const loaded = await loadTargetConfigsV1({
    template: createLocalRepositoryConfig(),
    readFile: () => Promise.resolve(JSON.stringify(Object.keys(visibility))),
    resolveRepository: (target) => {
      const answer = visibility[target.slug];
      return Promise.resolve(
        answer === null ? null : { defaultBranch: "main", visibility: answer },
      );
    },
    resolveTreeFacts: (target) => {
      assert.equal(target.slug, "ubiquity/public-a", "no facts read otherwise");
      return Promise.resolve({ files: [], hasCiWorkflow: true });
    },
  });
  assert.deepEqual(
    loaded.configs.map((config) => config.repository.name),
    ["public-a"],
  );
  assert.deepEqual(loaded.privateTargets, ["ubiquity/private-b"]);
  assert.deepEqual(loaded.skipped, ["ubiquity/unknown-c", "ubiquity/gone-d"]);
  assert.equal(unavailableTargetCountsV1(loaded), null);
  assert.deepEqual(privateTargetsLineV1(loaded), {
    kind: "sentinel_private_targets",
    reason: "private_repository",
    skipped: 1,
    listed: 4,
    configured: 1,
  });
  // Without the public target: the unavailability counts the other two only.
  const unavailable = {
    ...loaded,
    targets: loaded.targets.filter((target) => target.name !== "public-a"),
    configs: [],
  };
  assert.deepEqual(unavailableTargetCountsV1(unavailable), {
    listed: 2,
    branchUnavailable: 2,
    factsUnavailable: 0,
    transient: 0,
  });
  // Every listed target private: no unavailability at all.
  assert.equal(
    unavailableTargetCountsV1({
      targets: loaded.targets.filter((target) => target.name === "private-b"),
      configs: [],
      skipped: [],
      privateTargets: ["ubiquity/private-b"],
      factsUnavailable: [],
    }),
    null,
  );
  assert.equal(
    privateTargetsLineV1({ ...loaded, privateTargets: [] }),
    null,
  );
});

Deno.test("target visibility: the predicate's file is a Sentinel authority path", () => {
  assert.equal(
    touchesProtected(
      createLocalRepositoryConfig().protectedPaths,
      "src/repair/target-visibility.ts",
    ),
    true,
  );
});
