/**
 * Backup CI record contracts (docs/backup-ci-spec.md §6.1): every parser is
 * closed and bounded and enforces its record's bindings; the unit digest is
 * canonical (key order never matters); store paths and receipt ids have one
 * exact shape; only the exact mode values `on` and `shadow` enable anything;
 * and the targets file must name every repository id. All synthetic.
 */
import assert from "node:assert/strict";
import {
  BACKUP_CI_CHECK_NAME_PATTERN,
  backupCiCommitPath,
  backupCiReceiptId,
  backupCiUnitDigest,
  backupCiUnitId,
  isBackupCiCalibrated,
  noEvidenceLegRan,
  parseBackupCiCalibration,
  parseBackupCiCommitFile,
  parseBackupCiMode,
  parseBackupCiResult,
  parseBackupCiSuspension,
  parseBackupCiTargets,
  parseBackupCiUnit,
} from "../../src/contracts/backup-ci.ts";
import { RecordParseError } from "../../src/contracts/validation.ts";
import { CI_CHECK_NAME_PATTERN } from "../../src/repair/ci-rejection.ts";
import {
  B,
  calibration,
  commitFile,
  coverage,
  dispatched,
  H,
  key,
  legResult,
  noEvidence,
  OTHER,
  REPO,
  REPO_ID,
  result,
  RUNNER,
  suspension,
  unit,
  wire,
} from "../github/backup-ci-fixtures.ts";

type Json = Record<string, unknown>;

function rejects(parse: (input: unknown) => unknown, input: unknown) {
  assert.throws(() => parse(input), RecordParseError);
}

/** A JSON copy with `edit` applied (edits never touch the fixture). */
function edited(value: unknown, edit: (copy: Json) => void): Json {
  const copy = wire(value) as Json;
  edit(copy);
  return copy;
}

/** Re-derives the unit id after an edit, so only the edited rule decides. */
function reId(copy: Json): Json {
  const { unitId: _id, plan: _plan, ...rest } = copy;
  copy.unitId = backupCiUnitId(rest as never);
  return copy;
}

Deno.test("parseBackupCiMode accepts only the exact on and shadow", () => {
  assert.equal(parseBackupCiMode("on"), "on");
  assert.equal(parseBackupCiMode("shadow"), "shadow");
  for (const raw of [undefined, "", "off", "ON", " on", "on ", "true", "1"]) {
    assert.equal(parseBackupCiMode(raw), "off");
  }
});

Deno.test("noEvidenceLegRan counts only reasons where a leg ran", () => {
  assert.equal(noEvidenceLegRan("leg_failed"), true);
  assert.equal(noEvidenceLegRan("setup_action_failed"), true);
  assert.equal(noEvidenceLegRan("leg_missing"), false);
  assert.equal(noEvidenceLegRan("pr_moved"), false);
  assert.equal(noEvidenceLegRan("unsupported:needs_or_job_if"), false);
});

Deno.test("the check-name shape is the runtime's trusted check name", () => {
  assert.equal(
    BACKUP_CI_CHECK_NAME_PATTERN.source,
    CI_CHECK_NAME_PATTERN.source,
  );
  assert.equal(BACKUP_CI_CHECK_NAME_PATTERN.flags, CI_CHECK_NAME_PATTERN.flags);
});

Deno.test("store paths and receipt ids have one exact shape", () => {
  assert.equal(
    backupCiCommitPath("ubiquity", "passport.ubq.fi", H),
    `v1/ubiquity/passport.ubq.fi/aa/${H}.json`,
  );
  assert.equal(
    backupCiReceiptId(REPO, H, key()),
    "bci1:ubiquity/passport.ubq.fi@aaaaaaaaaaaa:.github/workflows/ci.yml#deno:push:a1",
  );
  assert.equal(
    backupCiReceiptId(REPO, H, key({ context: "pull_request", attempt: 2 })),
    "bci1:ubiquity/passport.ubq.fi@aaaaaaaaaaaa:.github/workflows/ci.yml#deno:pull_request:bbbbbbbbbbbb:a2",
  );
});

Deno.test("the unit digest is canonical and the unit id ignores the plan", () => {
  const u = unit();
  const reordered = Object.fromEntries(Object.entries(u).reverse());
  assert.equal(backupCiUnitDigest(reordered as never), backupCiUnitDigest(u));
  assert.match(backupCiUnitDigest(u), /^[0-9a-f]{64}$/);
  assert.match(u.unitId, /^[0-9a-f]{24}$/);
  const replanned = unit(key(), {
    runnerId: "aaaaaaaaaaaaaaaa",
    mode: "shadow",
  });
  assert.equal(replanned.unitId, u.unitId);
  assert.notEqual(backupCiUnitDigest(replanned), backupCiUnitDigest(u));
  assert.notEqual(unit(key({ attempt: 2 })).unitId, u.unitId);
});

Deno.test("parseBackupCiUnit accepts push and pull_request units", () => {
  for (const u of [unit(), unit(key({ context: "pull_request" }))]) {
    assert.deepEqual(parseBackupCiUnit(wire(u)), u);
  }
});

Deno.test("parseBackupCiUnit is closed, bound and binding-checked", () => {
  const u = unit();
  const pr = unit(key({ context: "pull_request" }));
  rejects(parseBackupCiUnit, edited(u, (c) => (c.extra = 1)));
  rejects(parseBackupCiUnit, edited(u, (c) => delete c.native));
  rejects(parseBackupCiUnit, edited(u, (c) => (c.unitId = "0".repeat(24))));
  rejects(
    parseBackupCiUnit,
    edited(u, (c) => {
      (c.job as Json).extra = true;
      reId(c);
    }),
  );
  // 101 steps, a step out of order, a run step naming an action.
  const step = u.steps[1];
  const many = Array.from({ length: 101 }, (_, i) => ({ ...step, index: i }));
  rejects(parseBackupCiUnit, reId(edited(u, (c) => (c.steps = many))));
  rejects(
    parseBackupCiUnit,
    reId(edited(u, (c) => (c.steps = [u.steps[1], u.steps[0]]))),
  );
  rejects(
    parseBackupCiUnit,
    reId(edited(u, (c) => (c.steps = [{ ...step, uses: "a/b@v1" }]))),
  );
  // The event is bounded and its top-level keys are the context's.
  rejects(
    parseBackupCiUnit,
    reId(edited(u, (c) => {
      (c.event as Json).head_commit = { id: H, message: "x".repeat(17_000) };
    })),
  );
  rejects(
    parseBackupCiUnit,
    reId(edited(u, (c) => {
      (c.event as Json).inputs = {};
    })),
  );
  // At most 16 never-started check runs.
  rejects(
    parseBackupCiUnit,
    reId(edited(u, (c) => {
      (c.neverStarted as Json).checkRunIds = Array.from(
        { length: 17 },
        (_, i) => i + 1,
      );
    })),
  );
  // A pull_request unit executes exactly M = [B, H]; a push unit the commit.
  rejects(
    parseBackupCiUnit,
    reId(edited(pr, (c) => {
      (c.exec as Json).parents = [H, B];
    })),
  );
  rejects(
    parseBackupCiUnit,
    reId(edited(pr, (c) => (c.ref = "refs/pull/8/merge"))),
  );
  rejects(
    parseBackupCiUnit,
    reId(edited(u, (c) => {
      (c.exec as Json).commit = OTHER;
    })),
  );
  // The cap is min(target timeout ?? 360, 60); attempt 2 is a confirmation.
  rejects(
    parseBackupCiUnit,
    reId(edited(u, (c) => {
      (c.job as Json).capMinutes = 30;
    })),
  );
  rejects(parseBackupCiUnit, reId(edited(u, (c) => (c.purpose = "confirm"))));
  rejects(
    parseBackupCiUnit,
    reId(edited(u, (c) => {
      (c.key as Json).workflowPath = ".github/workflows/../ci.yml";
    })),
  );
  rejects(
    parseBackupCiUnit,
    edited(u, (c) => {
      (c.plan as Json).runnerId = "ABCDEF0123456789";
    }),
  );
});

Deno.test("parseBackupCiResult is closed and admits only leg reasons", () => {
  const r = legResult();
  assert.deepEqual(parseBackupCiResult(wire(r)), r);
  const red = legResult(unit(), { outcome: "failure", failingStep: 1 });
  assert.deepEqual(parseBackupCiResult(wire(red)), red);
  const none = legResult(unit(), {
    outcome: "no_evidence",
    reason: "setup_action_failed",
    failingStep: 0,
  });
  assert.deepEqual(parseBackupCiResult(wire(none)), none);
  rejects(parseBackupCiResult, edited(r, (c) => (c.extra = 1)));
  rejects(parseBackupCiResult, edited(r, (c) => (c.reason = "leg_failed")));
  rejects(parseBackupCiResult, edited(none, (c) => (c.reason = "leg_missing")));
  rejects(
    parseBackupCiResult,
    edited(none, (c) => (c.reason = "unsupported:token")),
  );
  rejects(parseBackupCiResult, edited(r, (c) => (c.selftest = "failed")));
  rejects(parseBackupCiResult, edited(r, (c) => (c.failingStep = 1)));
  rejects(
    parseBackupCiResult,
    edited(r, (c) => (c.startedAt = r.completedAt + 1)),
  );
  rejects(
    parseBackupCiResult,
    edited(r, (c) => {
      (c.observed as Json).clean = false;
    }),
  );
  rejects(
    parseBackupCiResult,
    edited(r, (c) => {
      (c.runner as Json).imageVersion = "has space";
    }),
  );
});

Deno.test("parseBackupCiCommitFile binds every entry and keeps order", () => {
  const pr = key({ context: "pull_request" });
  const file = commitFile([
    result(),
    result(pr, { conclusion: "failure" }),
    noEvidence(key({ attempt: 2 })),
    dispatched(unit(key({ checkName: "lint" }))),
  ]);
  assert.deepEqual(parseBackupCiCommitFile(wire(file)), file);
  rejects(parseBackupCiCommitFile, edited(file, (c) => (c.extra = 1)));
  rejects(
    parseBackupCiCommitFile,
    edited(file, (c) => (c.entries as unknown[]).reverse()),
  );
  rejects(
    parseBackupCiCommitFile,
    edited(file, (c) => {
      const entries = c.entries as unknown[];
      entries.push(entries[entries.length - 1]);
    }),
  );
  // A result for another commit, or a pull_request result on another base.
  rejects(
    parseBackupCiCommitFile,
    wire(commitFile([result(key(), { commit: OTHER })])),
  );
  rejects(
    parseBackupCiCommitFile,
    wire(commitFile([result(pr, { commit: OTHER })])),
  );
  // A dispatched unit of another commit, or a digest that is not its unit's.
  rejects(
    parseBackupCiCommitFile,
    wire(commitFile([dispatched(unit(key(), { commit: OTHER }))])),
  );
  rejects(
    parseBackupCiCommitFile,
    wire(commitFile([{
      ...dispatched(),
      unitDigest: "3".repeat(64),
    }])),
  );
  // Only unsupported is final, and a final entry has no next attempt.
  rejects(
    parseBackupCiCommitFile,
    wire(commitFile([noEvidence(key(), { final: true, nextAt: null })])),
  );
  rejects(
    parseBackupCiCommitFile,
    wire(commitFile([noEvidence(key(), {
      reason: "unsupported:needs_or_job_if",
    })])),
  );
  assert.equal(
    parseBackupCiCommitFile(wire(commitFile([noEvidence(key(), {
      reason: "unsupported:needs_or_job_if",
      final: true,
      nextAt: null,
    })]))).entries.length,
    1,
  );
  // A success has no failure excerpt; an excerpt is at most 8 KiB.
  rejects(
    parseBackupCiCommitFile,
    wire(commitFile([{
      ...result(),
      failure: { stepIndex: 1, excerpt: "x" },
    }])),
  );
  rejects(
    parseBackupCiCommitFile,
    wire(commitFile([{
      ...result(key(), { conclusion: "failure" }),
      failure: { stepIndex: 1, excerpt: "é".repeat(4097) },
    }])),
  );
});

Deno.test("parseBackupCiCommitFile enforces its bounds", () => {
  const entries = Array.from(
    { length: 129 },
    (_, i) => noEvidence(key({ checkName: `check ${i}` })),
  );
  rejects(parseBackupCiCommitFile, wire(commitFile(entries)));
  assert.equal(
    parseBackupCiCommitFile(wire(commitFile(entries.slice(0, 128)))).entries
      .length,
    128,
  );
  const workflows = Array.from(
    { length: 17 },
    (_, i) => coverage({ path: `.github/workflows/w${i}.yml` }),
  );
  rejects(parseBackupCiCommitFile, wire(commitFile([], { workflows })));
  rejects(
    parseBackupCiCommitFile,
    wire(commitFile([], {
      workflows: [coverage(), coverage()],
    })),
  );
  rejects(
    parseBackupCiCommitFile,
    wire(commitFile([], {
      workflows: [coverage({ supported: false })],
    })),
  );
  rejects(
    parseBackupCiCommitFile,
    wire(commitFile([], {
      workflows: [coverage({
        expected: Array.from({ length: 65 }, (_, i) => `n${i}`),
      })],
    })),
  );
});

Deno.test("parseBackupCiSuspension and parseBackupCiCalibration are closed", () => {
  const s = suspension();
  assert.deepEqual(parseBackupCiSuspension(wire(s)), s);
  const all = suspension({
    scope: "all",
    runnerIds: "all",
    reason: "operator",
  });
  assert.deepEqual(parseBackupCiSuspension(wire(all)), all);
  rejects(parseBackupCiSuspension, edited(s, (c) => (c.scope = "passport")));
  rejects(parseBackupCiSuspension, edited(s, (c) => (c.runnerIds = ["x"])));
  rejects(parseBackupCiSuspension, edited(s, (c) => (c.reason = "flaky")));
  const c = calibration();
  assert.deepEqual(parseBackupCiCalibration(wire(c)), c);
  rejects(
    parseBackupCiCalibration,
    edited(c, (copy) => {
      (copy.runners as unknown[]).push((copy.runners as unknown[])[0]);
    }),
  );
  rejects(
    parseBackupCiCalibration,
    edited(c, (copy) => {
      (copy.runners as Json[])[0].failureAgreements = 6;
    }),
  );
  rejects(
    parseBackupCiCalibration,
    edited(c, (copy) => {
      (copy.runners as Json[])[0].samples = [{
        commit: H,
        checkName: "deno",
        native: "success",
        backup: "skipped",
      }];
    }),
  );
});

Deno.test("the targets file requires every repository id", () => {
  assert.deepEqual(parseBackupCiTargets([{ repository: REPO, id: REPO_ID }]), [
    { repository: REPO, id: REPO_ID },
  ]);
  rejects(parseBackupCiTargets, [{ repository: REPO }]);
  rejects(parseBackupCiTargets, [{ repository: REPO, id: 0 }]);
  rejects(parseBackupCiTargets, [{ repository: "passport", id: 1 }]);
  rejects(parseBackupCiTargets, [
    { repository: REPO, id: REPO_ID },
    { repository: REPO, id: REPO_ID },
  ]);
  rejects(
    parseBackupCiTargets,
    Array.from(
      { length: 17 },
      (_, i) => ({ repository: `o/r${i}`, id: i + 1 }),
    ),
  );
});

Deno.test("isBackupCiCalibrated holds exactly at the calibration gate", () => {
  const at = (row: Partial<Json>) =>
    isBackupCiCalibrated({
      ...calibration(),
      runners: [{ ...calibration().runners[0], ...row }],
    }, RUNNER);
  assert.equal(at({}), true);
  assert.equal(at({ agreements: 4 }), false);
  assert.equal(at({ failureAgreements: 0 }), false);
  assert.equal(at({ falseGreens: 1 }), false);
  assert.equal(at({ falseReds: 1 }), true);
  assert.equal(at({ falseReds: 2 }), false);
  assert.equal(isBackupCiCalibrated(calibration(), "aaaaaaaaaaaaaaaa"), false);
  assert.equal(isBackupCiCalibrated(null, RUNNER), false);
  assert.equal(B.length, 40);
});
