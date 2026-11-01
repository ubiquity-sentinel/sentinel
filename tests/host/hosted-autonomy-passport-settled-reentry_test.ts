/**
 * A blocked Passport trial keeps the implementation intent of the attempt
 * that parked it (`markBlocked` never clears it). That retained intent is in
 * flight only while its own charge is unsettled, so a settled park must be
 * re-admittable and an unsettled one must still be denied. No refund and no
 * new charge are involved.
 */
import assert from "node:assert/strict";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  passportTrialCandidateBinding,
  passportTrialCanReconsider,
} from "../../src/repair/passport-work-trial.ts";
import { BASE, deliveryRecord, HEAD } from "./hosted-autonomy-fixtures.ts";
import { reservation } from "../state/helpers.ts";

const PASSPORT = {
  owner: "ubiquity",
  name: "passport.ubq.fi",
  installationId: 155687488,
};
const RECORD_ID = "issue-ubiquity-passport.ubq.fi-96";
const CHARGE =
  "7a49c8fc686c4d04d830f04f66e61d1828474f383d295ba73c171011078cd68f";
const BRANCH = "sentinel/repair/issue-ubiquity-passport.ubq.fi-96";

function parked(): WorkRecordV1 {
  return deliveryRecord({
    repository: PASSPORT,
    id: RECORD_ID,
    source: { kind: "issue", id: "96", revision: BASE },
    related: { incidentId: null, issueNumber: 96 },
    target: {
      base: BASE,
      head: HEAD,
      branch: BRANCH,
      checkpoint: null,
      pr: 192,
      candidateState: {
        publishedHead: HEAD,
        preserved: {
          operationKey: `impl:${CHARGE}`,
          base: BASE,
          head: HEAD,
          ref: `refs/heads/sentinel-candidates/${"a".repeat(64)}`,
        },
      },
    },
    counters: { attempts: 9, retries: 4, reviewRounds: 0 },
    nextStep: "blocked",
    blocker: {
      kind: "other",
      message: "model run did not complete with a trusted candidate",
      since: 1793421752327,
    },
    intent: {
      kind: "implementation",
      key: `impl:${CHARGE}`,
      startedAt: 1793421358338,
      branch: BRANCH,
      expectedHead: null,
      observedBase: BASE,
      pr: null,
      requestId: CHARGE,
      resultId: null,
    },
    wait: null,
  });
}

function charge(
  outcome: "reserved" | "submitted" | "ambiguous" | "confirmed_not_submitted",
  settledAt: number | null,
) {
  return reservation(CHARGE, {
    repository: PASSPORT,
    taskId: RECORD_ID,
    head: BASE,
    attempt: 9,
    purpose: "retry",
    outcome,
    createdAt: 1793420000000,
    settledAt,
    proofRef: outcome === "confirmed_not_submitted" ? "artifact:proof" : null,
  });
}

Deno.test("Passport trial: a retained intent with its settled submitted charge is re-admitted", () => {
  const record = parked();
  const charges = [charge("submitted", 1793421752327)];
  assert.equal(passportTrialCanReconsider(record, charges), true);
  assert.deepEqual(
    passportTrialCandidateBinding(record, charges),
    record.target.candidateState!.preserved,
  );
  assert.deepEqual(charges, [charge("submitted", 1793421752327)]);
});

Deno.test("Passport trial: an unsettled or unbound retained intent is still denied", () => {
  const record = parked();
  assert.equal(
    passportTrialCanReconsider(record, [charge("reserved", null)]),
    false,
    "a reserved charge is in flight",
  );
  assert.equal(
    passportTrialCanReconsider(record, [
      charge("confirmed_not_submitted", 1793421752327),
    ]),
    false,
    "a provably never-submitted attempt is not a settled model run",
  );
  assert.equal(
    passportTrialCanReconsider(record, [charge("ambiguous", 1793421752327)]),
    false,
    "an ambiguous charge may still have a live run behind it",
  );
  const unbound = {
    ...record,
    intent: { ...record.intent!, requestId: "f".repeat(64) },
  };
  assert.equal(
    passportTrialCanReconsider(unbound, [charge("ambiguous", 1793421752327)]),
    false,
    "the retained intent must name the current charge",
  );
  const noIntent = { ...record, intent: null };
  assert.equal(
    passportTrialCanReconsider(noIntent, [charge("ambiguous", 1793421752327)]),
    false,
    "an ambiguous charge with no bound intent stays unfinished",
  );
});
