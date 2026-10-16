/**
 * An unavailable observation of a legacy record's published predecessor is
 * never stored as a verified absent head (issue #103): the record keeps its
 * legacy shape, and its publication re-observes the branch, so the legitimate
 * predecessor ref is leased instead of being refused as an unrelated head.
 */
import assert from "node:assert/strict";
import { portError } from "../../src/contracts/ports.ts";
import {
  issueRecord,
  makeRig,
  RelationsFakeGithub,
  seededSnapshot,
} from "./loop-rig.ts";
import {
  LEGACY_B0,
  LEGACY_BRANCH,
  LEGACY_H0,
  LEGACY_ISSUE,
  LEGACY_PR,
  LEGACY_REVIEW_ID,
  legacyLossCharge,
  legacyLossCycles,
  legacyLossReview,
  legacyLossWork,
} from "./loop-legacy-fixtures.ts";

Deno.test(
  "legacy publication observation: an unavailable predecessor read stays unresolved and publication leases the recovered predecessor",
  async () => {
    // The owned candidate branch exists at the legacy predecessor head H0.
    const port = new RelationsFakeGithub({
      baseSha: LEGACY_B0,
      branchRefSha: LEGACY_H0,
    });
    const rig = await makeRig("legacy-observation", {
      summaries: false,
      localScope: true,
      githubPort: port,
    });
    try {
      // A legacy record (no V1 candidate state) whose published head H0 was
      // rejected by review, so the next attempt corrects it.
      const record = legacyLossWork("issue-48", LEGACY_ISSUE, {
        target: {
          base: LEGACY_B0,
          branch: LEGACY_BRANCH,
          checkpoint: null,
          head: LEGACY_H0,
          pr: LEGACY_PR,
        },
        intent: null,
      });
      const written = await rig.store.writeRepair(
        seededSnapshot([record], {
          reservations: [legacyLossCharge()],
          reviews: [legacyLossReview(LEGACY_REVIEW_ID, LEGACY_H0, LEGACY_B0)],
        }),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");
      port.latest.set(
        LEGACY_ISSUE,
        issueRecord(LEGACY_ISSUE, {
          relations: { subIssueCount: 0, openBlockers: [] },
        }),
      );

      // The predecessor observation after the model run is unavailable.
      let unavailable = true;
      const readRef = port.readRef.bind(port);
      port.readRef = (ref) =>
        unavailable && rig.model.requests.length > 0 &&
          ref === `refs/heads/${LEGACY_BRANCH}`
          ? Promise.resolve(portError("unavailable", "ref read unavailable"))
          : readRef(ref);

      const { run } = legacyLossCycles({
        clock: rig.clock,
        state: rig.store,
        github: port,
        incidents: rig.incidents,
        replay: rig.replay,
        model: rig.model,
      });
      rig.clock.advance(2000);
      const implemented = await run(1);
      assert.equal(
        implemented.status,
        "step_limit",
        JSON.stringify(implemented),
      );
      assert.equal(rig.model.requests.length, 1);
      assert.equal(rig.model.requests[0]!.checkoutBase, LEGACY_H0);

      const noted = (await rig.snapshot()).work[0]!;
      const head = noted.target.head;
      assert.ok(
        head !== null && head !== LEGACY_H0,
        "the new candidate is noted",
      );
      // Never persisted as a verified absent predecessor: no V1 candidate
      // state and no preservation intent were written on an unverified read.
      assert.equal(noted.target.candidateState, undefined);
      assert.equal(noted.intent, null);
      assert.equal(noted.nextStep, "work");
      assert.equal(noted.blocker, null);

      // Reads recover: publication re-observes the owned branch and leases the
      // exact predecessor head instead of refusing it as an unrelated head.
      unavailable = false;
      await run(1);
      const after = (await rig.snapshot()).work[0]!;
      assert.notEqual(after.nextStep, "blocked", JSON.stringify(after.blocker));
      assert.deepEqual(port.pushes, [{
        ref: `refs/heads/${LEGACY_BRANCH}`,
        sha: head,
        expected: LEGACY_H0,
      }]);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);
