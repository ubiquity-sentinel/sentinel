/**
 * A GitHub Actions job that never started is not CI evidence (live Passport,
 * 2026-10-24). With Actions billing stopped, every check run on a head and on
 * its base completed `failure` within a second without a step or a runner.
 * Read as real failures, the base and the head were both red, so every
 * repair waited in `base_red` backoff behind a base no fix could turn green;
 * once billing came back and only the base re-ran green, the head's stale
 * failure would have been attributed to the candidate and charged a CI fix.
 *
 * A check the client marks `neverStarted` is now no evidence on either side:
 * the CI-first gate waits on it in the existing bounded, uncharged
 * `ci_pending` path (parked under the pending prefix after six hours, which
 * the launcher's re-run and green rules re-admit), never in `base_red`,
 * never as the candidate's failure and never charged. Every row runs the real
 * repair loop over real Git state with fake GitHub/model ports.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { GitHubCheckV1 } from "../../src/contracts/ports.ts";
import {
  attributeFailedChecks,
  ciCheckLabels,
  decideCiDisposition,
  failedChecks,
} from "../../src/repair/ci-rejection.ts";
import { decideCiGate } from "../../src/repair/loop-checks.ts";
import { SHA1, SHA3, T0 } from "../state/helpers.ts";
import {
  check,
  ciFirstRig,
  HOUR,
  modelCharges,
  reviewCharges,
  taskRecord,
} from "./ci-first-rig.ts";

/** A check run GitHub completed `failure` without ever starting its job. */
function notStarted(name: string, head: GitSha): GitHubCheckV1 {
  return { ...check(name, head, "failure"), neverStarted: true };
}

/** The pending park the six-hour bound writes for a never-started `deno`. */
const PARK =
  "CI did not finish before review within 6 hours: deno(not_started)";

Deno.test("never started (pure): no failure, the gate waits, the label says so", () => {
  const checks = [notStarted("deno", SHA3)];
  assert.deepEqual(failedChecks(checks), []);
  assert.equal(decideCiGate(checks), "wait");
  assert.equal(ciCheckLabels(checks), "deno(not_started)");
  // A real failure next to it still decides first.
  assert.deepEqual(
    decideCiGate([...checks, check("lint", SHA3, "failure")]),
    { blocked: "CI checks failed: lint(failure)" },
  );
  // On the base it attributes nothing: neither red nor green there.
  const attributed = attributeFailedChecks(
    [check("deno", SHA3, "failure")],
    [notStarted("deno", SHA1)],
  );
  assert.equal(attributed.baseRed.length, 0);
  assert.equal(attributed.candidate.length, 0);
  assert.equal(attributed.unattributed.length, 1);
  assert.equal(decideCiDisposition(attributed).kind, "unattributed");
});

for (const hosted of [false, true]) {
  const mode = hosted ? "hosted" : "in process";
  Deno.test(`CI first (${mode}): a never-started head on a never-started base waits uncharged in ci_pending, never base_red`, async () => {
    const { rig, charges } = await ciFirstRig(
      `cf-ns-both-${hosted ? "h" : "l"}`,
      {
        hosted,
        checks: {
          [SHA3]: [notStarted("deno", SHA3)],
          [SHA1]: [notStarted("deno", SHA1)],
        },
      },
    );
    try {
      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      let work = taskRecord(await rig.snapshot());
      assert.equal(work.nextStep, "work");
      assert.equal(work.blocker, null);
      assert.equal(work.wait?.reason, "ci_pending", JSON.stringify(work.wait));
      assert.equal(work.wait!.until, work.wait!.since + 5 * 60_000);
      const since = work.wait!.since;
      rig.clock.advance(5 * 60_000 + 1);
      await rig.run();
      work = taskRecord(await rig.snapshot());
      assert.equal(work.wait?.reason, "ci_pending");
      assert.equal(work.wait!.since, since, "since is kept across polls");
      // Past the bound: the pending park the launcher's rules re-admit.
      rig.clock.advance(6 * HOUR);
      await rig.run();
      const after = await rig.snapshot();
      work = taskRecord(after);
      assert.equal(work.nextStep, "blocked");
      assert.equal(work.blocker?.message, PARK);
      assert.equal(work.counters.retries, 0);
      assert.equal(work.counters.reviewRounds, 0);
      assert.equal(rig.github.calls.includes("requestReview"), false);
      assert.equal(rig.model.requests.length, 0);
      assert.deepEqual(after.reservations, charges, "nothing charged");
    } finally {
      await rig.ctx.cleanup();
    }
  });
}

Deno.test("CI first: a never-started head failure on a green base is not the candidate's and charges nothing", async () => {
  // Billing is back and the base re-ran green; the head's run is still the
  // stale never-started one. In process the CI fix route is open, so a
  // candidate attribution would have started a charged fix in this run.
  const { rig, charges } = await ciFirstRig("cf-ns-green-base", {
    checks: {
      [SHA3]: [notStarted("deno", SHA3)],
      [SHA1]: [check("deno", SHA1, "success")],
    },
  });
  try {
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const after = await rig.snapshot();
    const work = taskRecord(after);
    assert.equal(rig.model.requests.length, 0, "no CI fix started");
    assert.deepEqual(after.reservations, charges, "nothing charged");
    assert.equal(work.counters.retries, 0);
    assert.equal(work.nextStep, "work");
    assert.equal(work.wait?.reason, "ci_pending", JSON.stringify(work.wait));
    assert.equal(rig.github.calls.includes("requestReview"), false);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("CI first: a real head failure on a never-started base is unattributed, not base_red", async () => {
  const { rig, charges } = await ciFirstRig("cf-ns-base-only", {
    hosted: true,
    checks: {
      [SHA3]: [check("deno", SHA3, "failure")],
      [SHA1]: [notStarted("deno", SHA1)],
    },
  });
  try {
    await rig.run();
    const after = await rig.snapshot();
    const work = taskRecord(after);
    assert.equal(work.nextStep, "work");
    assert.equal(work.wait?.reason, "ci_pending", JSON.stringify(work.wait));
    assert.equal(work.counters.retries, 0);
    assert.deepEqual(after.reservations, charges, "nothing charged");
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("CI first: a CI fix marker whose head failure never started is dropped uncharged", async () => {
  // An earlier run (or the launcher) marked the head for a CI fix; the
  // admission re-reads live CI and finds no evidence, so nothing starts.
  const { rig, charges } = await ciFirstRig("cf-ns-marker", {
    wait: { reason: "backoff", since: T0, until: T0 },
    checks: {
      [SHA3]: [notStarted("deno", SHA3)],
      [SHA1]: [check("deno", SHA1, "success")],
    },
  });
  try {
    await rig.run();
    const after = await rig.snapshot();
    const work = taskRecord(after);
    assert.equal(rig.model.requests.length, 0, "no CI fix started");
    assert.equal(work.counters.retries, 0);
    assert.deepEqual(
      modelCharges(after),
      modelCharges({ ...after, reservations: charges }),
    );
    assert.equal(reviewCharges(after).length, 0, "no review either");
    assert.equal(work.wait?.reason, "ci_pending", JSON.stringify(work.wait));
  } finally {
    await rig.ctx.cleanup();
  }
});
