/**
 * A blocked Passport trial keeps the implementation intent of the attempt
 * that parked it (`markBlocked` never clears it). That retained intent is in
 * flight only while its own charge is unsettled, so a settled park must be
 * re-admittable and an unsettled one must still be denied. A charge settled
 * `ambiguous` by `settleAndBlock` is settled for this purpose when it is the
 * current attempt's implementation charge and the record is blocked: that park
 * is the attempt's terminal disposition, regardless of write-clock order. Only
 * a `reserved` implementation-start row of the current attempt is a live start;
 * review reservations carry review-round numbers and never deny. No refund and
 * no new charge are involved.
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
  attempt = 9,
  id: string = CHARGE,
  purpose: "implementation" | "retry" | "continuation" | "review_request" =
    "retry",
) {
  return reservation(id, {
    repository: PASSPORT,
    taskId: RECORD_ID,
    head: BASE,
    attempt,
    purpose,
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

Deno.test("Passport trial: a settled ambiguous park is re-admitted uncharged", () => {
  const record = parked();
  // The settlement reads its own clock after the park timestamp is captured,
  // so it is deliberately later than `blocker.since`: the attempt identity and
  // the park prove the disposition, not timestamp equality.
  const charges = [charge("ambiguous", record.blocker!.since + 3)];
  assert.equal(passportTrialCanReconsider(record, charges), true);
  assert.deepEqual(
    passportTrialCandidateBinding(record, charges),
    record.target.candidateState!.preserved,
  );
  // Re-admission neither refunds nor re-charges the retained ambiguity.
  assert.equal(charges[0].outcome, "ambiguous");
  assert.equal(charges[0].settledAt, record.blocker!.since + 3);
});

Deno.test("Passport trial: an ambiguous charge only settles the current blocked attempt", () => {
  const older = parked();
  assert.equal(
    passportTrialCanReconsider(older, [charge("ambiguous", 1793421752327, 8)]),
    false,
    "an older attempt's ambiguity is not the current attempt's charge",
  );
  const unparked = parked();
  unparked.nextStep = "review";
  assert.equal(
    passportTrialCanReconsider(unparked, [
      charge("ambiguous", 1793421752327),
    ]),
    false,
    "an ambiguous charge without a terminal park is not a settled disposition",
  );
  const unblocked = parked();
  unblocked.blocker = null;
  assert.equal(
    passportTrialCanReconsider(unblocked, [
      charge("ambiguous", 1793421752327),
    ]),
    false,
    "no park means no terminal disposition",
  );
});

Deno.test("Passport trial: an unsettled or unbound retained intent is still denied", () => {
  const record = parked();
  assert.equal(
    passportTrialCanReconsider(record, [charge("reserved", null)]),
    false,
    "a reserved charge of the current attempt is in flight",
  );
  assert.equal(
    passportTrialCanReconsider(record, [
      charge("confirmed_not_submitted", 1793421752327),
    ]),
    false,
    "a provably never-submitted attempt is not a settled model run",
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
});

Deno.test("Passport trial: a settled submitted charge must match the retained intent requestId", () => {
  const record = parked();
  const charges = [charge("submitted", 1793421752327)];
  assert.equal(passportTrialCanReconsider(record, charges), true);

  const unbound = {
    ...record,
    intent: { ...record.intent!, requestId: "f".repeat(64) },
  };
  assert.equal(
    passportTrialCanReconsider(unbound, charges),
    false,
    "a settled charge cannot settle a different retained request",
  );
  assert.equal(passportTrialCandidateBinding(unbound, charges), null);
});

Deno.test("Passport trial: only a reserved row of the current attempt denies", () => {
  const record = parked();
  const current = charge("submitted", 1793421752327);
  const stale = charge("reserved", null, 8, "b".repeat(64));
  assert.equal(
    passportTrialCanReconsider(record, [stale, current]),
    true,
    "an older attempt's leaked reserved row was superseded by settlement",
  );
  assert.deepEqual(
    passportTrialCandidateBinding(record, [stale, current]),
    record.target.candidateState!.preserved,
  );
  assert.equal(
    passportTrialCanReconsider(record, [
      charge("reserved", null, 9, "c".repeat(64)),
      current,
    ]),
    false,
    "the current attempt's reserved row is a live start",
  );
  // A review reservation's `attempt` is a review-round number; it is never a
  // live implementation start even when its number reaches the attempt count.
  const review = charge("reserved", null, 9, "d".repeat(64), "review_request");
  assert.equal(
    passportTrialCanReconsider(record, [review, current]),
    true,
    "a leaked reserved review row does not deny re-entry",
  );
  assert.deepEqual(
    passportTrialCandidateBinding(record, [review, current]),
    record.target.candidateState!.preserved,
  );
});
