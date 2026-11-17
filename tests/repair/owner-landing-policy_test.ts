/**
 * Owner-landing policy (owner directive 2026-11-17, "give sentinel full
 * access"): a protected change publishes as an ordinary pull request on every
 * target, credential paths never publish, and on Sentinel's own repository a
 * protected change publishes for its owner to merge.
 */
import assert from "node:assert/strict";
import { asCommandId } from "../../src/contracts/brands.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import { selectTrustedTargetPolicyV1 } from "../../src/host/target-policy.ts";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import {
  authorityPath,
  credentialPath,
  ownerLandingTouch,
  protectedBeyondOwnerLanding,
  publicationProtectedPaths,
  sentinelNeverMerges,
  withOwnerLanding,
} from "../../src/repair/owner-landing.ts";
import { T0, workRecord } from "../state/helpers.ts";

const named = {
  commands: { test: asCommandId("test"), replay: asCommandId("test") },
  protectedPaths: ["src/auth/", "ops/", ".github/workflows/", ".env"],
};
const TARGET = { owner: "ubiquity", name: "pay.ubq.fi" };
const SELF = { owner: "ubiquity-sentinel", name: "sentinel" };

Deno.test("owner landing policy: a target's protected change is ordinary, a credential path never publishes", () => {
  assert.deepEqual(ownerLandingTouch(named, ["src/app.ts"], TARGET), {
    kind: "none",
  });
  assert.deepEqual(
    ownerLandingTouch(
      named,
      ["src/auth/a.ts", "ops/x.ts", ".github/workflows/ci.yml"],
      TARGET,
    ),
    { kind: "none" },
  );
  for (const path of [".env", "apps/web/.env.local"]) {
    assert.deepEqual(
      ownerLandingTouch(
        { ...named, protectedPaths: [...named.protectedPaths, path] },
        ["src/auth/a.ts", path],
        TARGET,
      ),
      { kind: "unpublishable" },
      path,
    );
  }
  for (
    const path of [
      "apps/web/.env.local",
      ".npmrc",
      ".actrc",
      ".secrets",
      ".vars",
      ".input",
      "sentinel.protected",
      "a/.git/config",
    ]
  ) assert.equal(credentialPath(path), true, path);
  for (
    const path of [
      ".github/workflows/ci.yml",
      ".github/actions/setup/action.yml",
      "src/auth/session.ts",
    ]
  ) assert.equal(credentialPath(path), false, path);
});

Deno.test("owner landing policy: the gateway's workflow and Sentinel-code changes are ordinary, its env file parks", () => {
  const gateway = selectTrustedTargetPolicyV1(createLocalRepositoryConfig(), {
    owner: "ubiquity",
    name: "ai.ubq.fi",
  });
  const repository = { owner: "ubiquity", name: "ai.ubq.fi" };
  for (
    const path of [
      "src/auth/login.ts",
      "src/sentinel/probe.ts",
      ".github/workflows/deno-deploy.yml",
      "AGENTS.md",
    ]
  ) {
    assert.deepEqual(ownerLandingTouch(gateway, [path], repository), {
      kind: "none",
    }, path);
    assert.equal(sentinelNeverMerges(gateway, repository, [path]), false);
  }
  assert.deepEqual(ownerLandingTouch(gateway, [".env"], repository), {
    kind: "unpublishable",
  });
  assert.equal(sentinelNeverMerges(gateway, repository, [".env"]), true);
});

Deno.test("owner landing policy: a target's publication validates only credential prefixes", () => {
  const record = withOwnerLanding(workRecord("issue-1"), ["src/auth/"], T0);
  assert.deepEqual(
    publicationProtectedPaths(named.protectedPaths, TARGET, record),
    [".env"],
  );
  assert.deepEqual(
    publicationProtectedPaths(named.protectedPaths, TARGET, null),
    [".env"],
  );
  // A flag can never lift a credential path, on any repository.
  const forged = { ownerLanding: { paths: [".env"], since: 1 } };
  assert.deepEqual(
    publicationProtectedPaths(named.protectedPaths, SELF, forged),
    ["src/auth/", "ops/", ".github/workflows/", ".env"],
  );
});

Deno.test("owner landing policy: a conflict merge on a target refuses only credential paths", () => {
  const plain = {
    ...workRecord("issue-1"),
    repository: { ...TARGET, installationId: 1 },
  };
  const auth = ["src/auth/a.ts", "src/app.ts", ".github/workflows/a.yml"];
  assert.equal(protectedBeyondOwnerLanding(named, plain, auth), false);
  assert.equal(
    protectedBeyondOwnerLanding(named, plain, [...auth, ".env"]),
    true,
  );
});

Deno.test("owner landing policy: the flag widens, keeps its first time and round-trips", () => {
  const first = withOwnerLanding(workRecord("issue-1"), ["src/auth/"], T0);
  const second = withOwnerLanding(first, ["ops/", "src/auth/"], T0 + 5);
  assert.deepEqual(second.ownerLanding, {
    paths: ["ops/", "src/auth/"],
    since: T0,
  });
  assert.deepEqual(
    parseWorkRecordV1(JSON.parse(JSON.stringify(second))),
    second,
  );
  assert.throws(() =>
    parseWorkRecordV1({ ...second, ownerLanding: { paths: [], since: T0 } })
  );
  assert.throws(() =>
    parseWorkRecordV1({
      ...second,
      ownerLanding: { paths: ["src/auth/", "ops/"], since: T0 },
    })
  );
  const legacy = workRecord("issue-1");
  assert.equal("ownerLanding" in parseWorkRecordV1(legacy), false);
});

Deno.test("owner landing policy: Sentinel's own protected changes publish for its owner, never for Sentinel to merge", () => {
  const template = createLocalRepositoryConfig();
  const self = selectTrustedTargetPolicyV1(template, SELF);
  for (
    const [path, prefix] of [
      ["src/repair/owner-landing.ts", "src/repair/owner-landing.ts"],
      ["src/repair/loop-records.ts", "src/repair/loop-records.ts"],
      ["src/host/local-config.ts", "src/host/local-config.ts"],
      ["src/host/supervisor-dispatch.ts", "src/host/supervisor-dispatch.ts"],
      [".github/workflows/ci.yml", ".github/workflows/"],
      [
        ".github/actions/sentinel-app-token/action.yml",
        ".github/actions/sentinel-app-token/",
      ],
    ]
  ) {
    assert.equal(authorityPath(path), true, path);
    assert.deepEqual(ownerLandingTouch(self, ["src/app.ts", path], SELF), {
      kind: "owner",
      paths: [prefix],
    }, path);
    assert.equal(sentinelNeverMerges(self, SELF, [path]), true, path);
  }
  assert.deepEqual(ownerLandingTouch(self, ["src/app.ts"], SELF), {
    kind: "none",
  });
  assert.equal(sentinelNeverMerges(self, SELF, ["src/app.ts"]), false);
  // The self publication check drops only the prefixes the flag names.
  assert.deepEqual(
    publicationProtectedPaths(
      ["src/repair/loop-records.ts", ".github/workflows/"],
      SELF,
      { ownerLanding: { paths: [".github/workflows/"], since: T0 } },
    ),
    ["src/repair/loop-records.ts"],
  );
});
