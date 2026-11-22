import assert from "node:assert/strict";
import { portOk } from "../../src/contracts/ports.ts";
import { mergeContentRefusal } from "../../src/github/merge-content-gate.ts";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import { selectTrustedTargetPolicyV1 } from "../../src/host/target-policy.ts";
import { touchesProtected } from "../../src/repair/loop-records.ts";
import {
  authorityPath,
  ownerLandingTouch,
  publicationProtectedPaths,
  withOwnerLanding,
} from "../../src/repair/owner-landing.ts";
import { SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";

const SELF = {
  owner: "ubiquity-sentinel",
  name: "sentinel",
  installationId: 1,
};

/** #240: direct merge authorization, promotion-state and App-principal proofs. */
const AUTHORITY_DEPENDENCY_PATHS = [
  "src/repair/review-gate.ts",
  "src/github/review-normalize.ts",
  "src/host/actions-supervisor-state.ts",
  "src/host/actions-supervisor-installation-state.ts",
  "src/contracts/hosted-supervisor-installation.ts",
  "src/host/hosted-app-principal-source.ts",
  "src/host/hosted-app-principal-native.ts",
] as const;

Deno.test("hosted authority: direct authorization dependencies are protected", () => {
  const protectedPaths = createLocalRepositoryConfig().protectedPaths;
  for (const path of AUTHORITY_DEPENDENCY_PATHS) {
    assert.equal(touchesProtected(protectedPaths, path), true, path);
  }
});

Deno.test("hosted authority: reviewed callers and policy candidates stay ordinary work", () => {
  const protectedPaths = createLocalRepositoryConfig().protectedPaths;
  for (
    const path of [
      "ops/hosted-autonomy-delivery-pass.ts",
      "src/repair/loop-carried-delivery.ts",
      "src/repair/carried-review.ts",
      "src/repair/loop-merge.ts",
      "src/repair/loop-implementation-result.ts",
      "src/repair/loop-conflict-resolution.ts",
      "src/host/actions-candidates-proof.ts",
      "src/github/review-snapshot.ts",
      "src/repair/passport-work-trial.ts",
      "sentinel.targets.json",
      "src/github/codex-review-rubric.ts",
    ]
  ) assert.equal(touchesProtected(protectedPaths, path), false, path);
});

Deno.test("hosted authority: dependency candidates publish for the owner but the merge executor refuses them", async (t) => {
  const config = selectTrustedTargetPolicyV1(
    createLocalRepositoryConfig(),
    SELF,
  );
  for (const path of AUTHORITY_DEPENDENCY_PATHS) {
    await t.step(path, async () => {
      assert.equal(authorityPath(path), true, path);
      const touch = ownerLandingTouch(config, [path], SELF);
      assert.deepEqual(touch, { kind: "owner", paths: [path] });
      assert.equal(touchesProtected(config.protectedPaths, path), true, path);
      const record = withOwnerLanding(
        { ...workRecord("issue-240"), repository: SELF },
        [path],
        T0,
      );
      assert.equal(
        touchesProtected(
          publicationProtectedPaths(config.protectedPaths, SELF, record),
          path,
        ),
        false,
        "owner-landing authority changes must remain publishable",
      );
      const reads: string[] = [];
      assert.equal(
        await mergeContentRefusal(
          {
            readChangedPaths: (base, head) => {
              reads.push("changedPaths");
              assert.equal(base, SHA1);
              assert.equal(head, SHA2);
              return Promise.resolve(portOk([path]));
            },
            readChecks: () => {
              throw new Error("a protected change cannot reach the CI gate");
            },
          },
          SELF,
          SHA1,
          SHA2,
          [],
        ),
        "protection_required",
      );
      assert.deepEqual(reads, ["changedPaths"]);
    });
  }
});
