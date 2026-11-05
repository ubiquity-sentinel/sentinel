/**
 * Owner-landing policy: which protected changes publish for their owner, and
 * which (workflow and other CI-executable paths) never publish.
 */
import assert from "node:assert/strict";
import { asCommandId } from "../../src/contracts/brands.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import { selectTrustedTargetPolicyV1 } from "../../src/host/target-policy.ts";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import {
  authorityPath,
  ciExecutablePath,
  ownerLandingTouch,
  protectedBeyondOwnerLanding,
  publicationProtectedPaths,
  withOwnerLanding,
} from "../../src/repair/owner-landing.ts";
import { T0, workRecord } from "../state/helpers.ts";

const named = {
  commands: { test: asCommandId("test"), replay: asCommandId("test") },
  protectedPaths: ["src/auth/", "ops/", ".github/workflows/", ".env"],
};

Deno.test("owner landing policy: protected source publishes, CI-executable paths never do", () => {
  assert.deepEqual(ownerLandingTouch(named, ["src/app.ts"]), { kind: "none" });
  assert.deepEqual(
    ownerLandingTouch(named, ["src/auth/a.ts", "ops/x.ts", "src/app.ts"]),
    { kind: "owner", paths: ["ops/", "src/auth/"] },
  );
  for (
    const path of [
      ".github/workflows/ci.yml",
      ".env",
    ]
  ) {
    assert.deepEqual(
      ownerLandingTouch(named, ["src/auth/a.ts", path]),
      { kind: "unpublishable" },
      path,
    );
  }
  for (
    const path of [
      ".github/actions/setup/action.yml",
      "apps/web/.env.local",
      ".npmrc",
      ".actrc",
      "sentinel.protected",
      "a/.git/config",
    ]
  ) assert.equal(ciExecutablePath(path), true, path);
  assert.equal(ciExecutablePath("src/auth/session.ts"), false);
});

Deno.test("owner landing policy: the gateway's auth change publishes, its workflow change parks", () => {
  const gateway = selectTrustedTargetPolicyV1(createLocalRepositoryConfig(), {
    owner: "ubiquity",
    name: "ai.ubq.fi",
  });
  assert.deepEqual(ownerLandingTouch(gateway, ["src/auth/login.ts"]), {
    kind: "owner",
    paths: ["src/auth/"],
  });
  assert.deepEqual(
    ownerLandingTouch(gateway, [".github/workflows/deno-deploy.yml"]),
    { kind: "unpublishable" },
  );
});

Deno.test("owner landing policy: publication validates every protected path the flag does not name", () => {
  const record = withOwnerLanding(workRecord("issue-1"), ["src/auth/"], T0);
  assert.deepEqual(
    publicationProtectedPaths(named.protectedPaths, record),
    ["ops/", ".github/workflows/", ".env"],
  );
  assert.deepEqual(
    publicationProtectedPaths(named.protectedPaths, workRecord("issue-1")),
    named.protectedPaths,
  );
  // A flag can never lift a CI-executable path.
  const forged = { ownerLanding: { paths: [".github/workflows/"], since: 1 } };
  assert.deepEqual(
    publicationProtectedPaths(named.protectedPaths, forged),
    named.protectedPaths,
  );
});

Deno.test("owner landing policy: a conflict merge may carry only the flagged prefixes", () => {
  const plain = workRecord("issue-1");
  const flagged = withOwnerLanding(plain, ["src/auth/"], T0);
  const auth = ["src/auth/a.ts", "src/app.ts"];
  assert.equal(
    protectedBeyondOwnerLanding(named, plain, ["src/app.ts"]),
    false,
  );
  assert.equal(protectedBeyondOwnerLanding(named, plain, auth), true);
  assert.equal(protectedBeyondOwnerLanding(named, flagged, auth), false);
  assert.equal(
    protectedBeyondOwnerLanding(named, flagged, [...auth, "ops/x.ts"]),
    true,
  );
  assert.equal(
    protectedBeyondOwnerLanding(named, flagged, [".github/workflows/a.yml"]),
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

Deno.test("owner landing policy: Sentinel authority files never publish, other self-protected paths do", () => {
  const template = createLocalRepositoryConfig();
  const self = {
    commands: template.commands,
    protectedPaths: [...template.protectedPaths, "docs/private/"],
  };
  for (
    const path of [
      "src/repair/owner-landing.ts",
      "src/repair/loop-owner-landing.ts",
      "src/repair/loop-records.ts",
      "src/host/local-config.ts",
      ".github/actions/sentinel-app-token/action.yml",
    ]
  ) {
    assert.equal(authorityPath(path), true, path);
    assert.deepEqual(ownerLandingTouch(self, ["src/app.ts", path]), {
      kind: "unpublishable",
    }, path);
  }
  assert.equal(authorityPath("docs/private/notes.md"), false);
  assert.deepEqual(ownerLandingTouch(self, ["docs/private/notes.md"]), {
    kind: "owner",
    paths: ["docs/private/"],
  });
  // An authority prefix is never dropped from the publication check.
  assert.deepEqual(
    publicationProtectedPaths(["src/repair/loop-records.ts", "docs/private/"], {
      ownerLanding: {
        paths: ["src/repair/loop-records.ts", "docs/private/"],
        since: T0,
      },
    }),
    ["src/repair/loop-records.ts"],
  );
});
