/**
 * The receipt store's pure merge rules (docs/backup-ci-spec.md §7): a result
 * is final per (key, mode, runner id) and a conflicting one is dropped; a
 * result replaces the dispatched and non-final no-evidence entries of its
 * key and mode; no-evidence counts legs only when one ran and backs off
 * 15 min / 1 h / 4 h / 24 h (10 min when none ran); unsupported is final;
 * re-applying a pass changes nothing; eviction spares results; calibration
 * counts agreements, false greens and false reds once per sample; and
 * suspensions only ever widen. All synthetic.
 */
import assert from "node:assert/strict";
import {
  type BackupCiEntryV1,
  isBackupCiCalibrated,
} from "../../src/contracts/backup-ci.ts";
import {
  type BackupCiComparisonV1,
  type BackupCiFileChangesV1,
  type BackupCiNoEvidenceEventV1,
  isBackupCiSuspended,
  mergeBackupCiFile,
  mergeCalibration,
  mergeSuspension,
} from "../../src/github/backup-ci-store.ts";
import {
  calibration,
  CHECK,
  commitFile,
  coverage,
  DIGEST_A,
  dispatched,
  H,
  key,
  noEvidence,
  OTHER,
  REPO,
  REPOSITORY,
  result,
  RUNNER,
  RUNNER2,
  suspension,
  T0,
  unit,
} from "./backup-ci-fixtures.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

function merge(
  current: ReturnType<typeof commitFile> | null,
  changes: Omit<BackupCiFileChangesV1, "repository" | "commit" | "now">,
  now = T0,
) {
  return mergeBackupCiFile(current, {
    repository: REPOSITORY,
    commit: H,
    now,
    ...changes,
  });
}

function states(entries: readonly BackupCiEntryV1[]): string[] {
  return entries.map((e) =>
    `${e.state}:${e.key.context}:a${e.key.attempt}:${e.mode}:${e.runnerId}`
  );
}

function event(
  over: Partial<BackupCiNoEvidenceEventV1> = {},
): BackupCiNoEvidenceEventV1 {
  return {
    key: key(),
    mode: "evidence",
    runnerId: RUNNER,
    reason: "leg_failed",
    at: T0,
    unitDigest: null,
    ...over,
  };
}

Deno.test("a result is final per key, mode and runner id", () => {
  const first = merge(null, { results: [result()] });
  assert.deepEqual(states(first.file.entries), [
    `result:push:a1:evidence:${RUNNER}`,
  ]);
  // The same result again changes nothing and logs nothing.
  const again = merge(first.file, { results: [result()] });
  assert.deepEqual(again.file, first.file);
  assert.deepEqual(again.log, []);
  // A different result for the same triple is dropped and logged.
  const conflict = merge(first.file, {
    results: [
      result(key(), { conclusion: "failure", resultDigest: "3".repeat(64) }),
    ],
  });
  assert.deepEqual(conflict.file.entries, first.file.entries);
  assert.equal(conflict.log.length, 1);
  assert.match(conflict.log[0], /^sentinel_backup_ci_conflict \{/);
  // Another runner, or the shadow mode, is another triple.
  const more = merge(first.file, {
    results: [
      result(key(), { runnerId: RUNNER2, conclusion: "failure" }),
      result(key(), { mode: "shadow" }),
    ],
  });
  assert.equal(more.file.entries.length, 3);
});

Deno.test("a result replaces dispatched and non-final no-evidence entries", () => {
  const RUNNER3 = "00000000000000aa";
  const current = commitFile([
    dispatched(unit()),
    // A non-final no-evidence entry of the same key and mode goes, whatever
    // its runner; a final (unsupported) one stays.
    noEvidence(key(), { runnerId: RUNNER2 }),
    noEvidence(key(), {
      runnerId: RUNNER3,
      reason: "unsupported:needs_or_job_if",
      final: true,
      nextAt: null,
    }),
    // Another key, and a shadow-mode dispatch, are not this result's.
    noEvidence(key({ attempt: 2 })),
    dispatched(unit(key(), { mode: "shadow" })),
  ]);
  const { file, log } = merge(current, { results: [result()] });
  assert.deepEqual(log, []);
  assert.deepEqual(states(file.entries).sort(), [
    `dispatched:push:a1:shadow:${RUNNER}`,
    `no_evidence:push:a1:evidence:${RUNNER3}`,
    `no_evidence:push:a2:evidence:${RUNNER}`,
    `result:push:a1:evidence:${RUNNER}`,
  ]);
});

Deno.test("no-evidence backs off by legs run and retries refusals", () => {
  const u = unit();
  let file = merge(null, { dispatched: [dispatched(u)] }).file;
  const unitDigest = file.entries[0].state === "dispatched"
    ? file.entries[0].unitDigest
    : "";
  const expected: [string, number, number][] = [];
  const steps: [BackupCiNoEvidenceEventV1["reason"], number, number][] = [
    ["leg_failed", 1, 15 * MIN],
    ["artifact_invalid", 2, HOUR],
    ["leg_missing", 2, 10 * MIN],
    ["runner_timeout", 3, 4 * HOUR],
    ["leg_stuck", 4, 24 * HOUR],
    ["act_internal", 5, 24 * HOUR],
  ];
  steps.forEach(([reason, legRuns, delay], i) => {
    const at = T0 + i * HOUR;
    if (i > 0) {
      file = merge(file, { dispatched: [dispatched(u)] }, at).file;
    }
    file = merge(file, {
      noEvidence: [event({ reason, at, unitDigest })],
    }, at).file;
    const entry = file.entries.find((e) => e.state === "no_evidence");
    assert.ok(entry?.state === "no_evidence");
    expected.push([reason, legRuns, at + delay]);
    assert.deepEqual(
      [entry.reason, entry.legRuns, entry.nextAt],
      expected[i],
      reason,
    );
    assert.equal(entry.firstAt, T0);
    assert.equal(entry.lastAt, at);
    assert.equal(entry.final, false);
    assert.equal(file.entries.some((e) => e.state === "dispatched"), false);
  });
});

Deno.test("re-applying a resolved no-evidence event counts nothing twice", () => {
  const u = unit();
  const start = merge(null, { dispatched: [dispatched(u)] }).file;
  const ev = event({ unitDigest: dispatched(u).unitDigest });
  const once = merge(start, { noEvidence: [ev] }).file;
  const twice = merge(once, { noEvidence: [ev] }).file;
  assert.deepEqual(twice.entries, once.entries);
  const entry = twice.entries[0];
  assert.ok(entry.state === "no_evidence");
  assert.equal(entry.legRuns, 1);
  // A refusal that dispatched nothing is not counted as a leg.
  const refusal = merge(null, {
    noEvidence: [event({ reason: "pr_moved" })],
  }).file.entries[0];
  assert.ok(refusal.state === "no_evidence");
  assert.deepEqual([refusal.legRuns, refusal.nextAt], [0, T0 + 10 * MIN]);
});

Deno.test("unsupported is final and later events and dispatches are ignored", () => {
  const unsupported = merge(null, {
    noEvidence: [event({ reason: "unsupported:needs_or_job_if" })],
  });
  const entry = unsupported.file.entries[0];
  assert.ok(entry.state === "no_evidence");
  assert.deepEqual([entry.final, entry.nextAt, entry.legRuns], [
    true,
    null,
    0,
  ]);
  const later = merge(unsupported.file, {
    noEvidence: [event({ reason: "leg_failed", at: T0 + HOUR })],
    dispatched: [dispatched()],
  }, T0 + HOUR);
  assert.deepEqual(later.file.entries, unsupported.file.entries);
  assert.match(later.log[0], /^sentinel_backup_ci_dispatch_ignored /);
  // An evidence result does not take a shadow no-evidence entry's place.
  const shadow = merge(null, {
    noEvidence: [event({ mode: "shadow" })],
    results: [result()],
  });
  assert.equal(shadow.file.entries.length, 2);
});

Deno.test("a dispatch for a key with its runner's result is ignored", () => {
  const withResult = merge(null, { results: [result()] }).file;
  const { file, log } = merge(withResult, { dispatched: [dispatched()] });
  assert.deepEqual(file.entries, withResult.entries);
  assert.equal(log.length, 1);
  // Another runner's dispatch for the same key is admitted.
  const other = merge(withResult, {
    dispatched: [dispatched(unit(key(), { runnerId: RUNNER2 }))],
  }).file;
  assert.equal(other.entries.length, 2);
});

Deno.test("eviction drops the oldest no-evidence, then dispatched, never results", () => {
  const names = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => key({ checkName: `${prefix} ${i}` }));
  const results = names(100, "r").map((k) => result(k));
  const old = names(20, "n").map((k, i) =>
    noEvidence(k, { lastAt: T0 + i, nextAt: T0 + i + 15 * MIN })
  );
  const pending = names(8, "d").map((k) => dispatched(unit(k)));
  const current = commitFile([...results, ...old, ...pending]);
  assert.equal(current.entries.length, 128);
  // Five new results: the five oldest no-evidence entries go.
  const added = names(5, "x").map((k) => result(k));
  const { file } = merge(current, { results: added });
  assert.equal(file.entries.length, 128);
  const kept = new Set(file.entries.map((e) => e.key.checkName));
  for (let i = 0; i < 5; i++) assert.equal(kept.has(`n ${i}`), false);
  for (let i = 5; i < 20; i++) assert.equal(kept.has(`n ${i}`), true);
  for (const r of [...results, ...added]) {
    assert.equal(kept.has(r.key.checkName), true);
  }
  // With only results and dispatches left, dispatches go before results.
  const full = commitFile([
    ...names(120, "r").map((k) => result(k)),
    ...pending,
  ]);
  const crowded = merge(full, {
    results: names(10, "y").map((k) => result(k)),
  });
  assert.equal(crowded.file.entries.length, 128);
  assert.equal(crowded.file.entries.every((e) => e.state === "result"), true);
  // Existing results are kept; the new results that do not fit are dropped.
  const kept2 = new Set(crowded.file.entries.map((e) => e.key.checkName));
  for (let i = 0; i < 120; i++) assert.equal(kept2.has(`r ${i}`), true);
  assert.equal(crowded.log.length, 2);
});

Deno.test("coverage is upserted per path and event", () => {
  const first = merge(null, { coverage: [coverage()] }).file;
  const second = merge(first, {
    coverage: [
      coverage({ observedAt: T0 + 1, expected: [CHECK, "lint"] }),
      coverage({ event: "pull_request" }),
    ],
  }).file;
  assert.deepEqual(
    second.workflows.map((w) => [w.event, w.expected.length]),
    [["pull_request", 1], ["push", 2]],
  );
  assert.throws(() =>
    mergeBackupCiFile(first, {
      repository: REPOSITORY,
      commit: OTHER,
      now: T0,
    })
  );
});

function comparison(
  commit: string,
  native: string,
  backup: "success" | "failure",
  runnerId = RUNNER,
): BackupCiComparisonV1 {
  return {
    runnerId,
    sample: {
      commit: commit.repeat(40) as never,
      checkName: CHECK,
      native,
      backup,
    },
    nativeCheckRunId: 42,
    receipt: "bci1:ubiquity/passport.ubq.fi@aaaaaaaaaaaa:x#deno:push:a1",
  };
}

Deno.test("calibration counts agreements once and reports disagreements", () => {
  const agreeing = ["1", "2", "3", "4"].map((c) =>
    comparison(c, "success", "success")
  );
  const { calibration: four } = mergeCalibration(
    null,
    REPOSITORY,
    [...agreeing, comparison("1", "success", "success")],
    T0,
  );
  assert.equal(four.runners[0].agreements, 4);
  assert.equal(isBackupCiCalibrated(four, RUNNER), false);
  // A red agreement completes the gate; a native skip is not comparable.
  const { calibration: five } = mergeCalibration(four, REPOSITORY, [
    comparison("5", "timed_out", "failure"),
    comparison("6", "skipped", "success"),
  ], T0);
  assert.deepEqual(
    [five.runners[0].agreements, five.runners[0].failureAgreements],
    [5, 1],
  );
  assert.equal(five.runners[0].samples.length, 5);
  assert.equal(isBackupCiCalibrated(five, RUNNER), true);
  // One false red is tolerated; a second one, and any false green, report.
  const red1 = mergeCalibration(five, REPOSITORY, [
    comparison("7", "success", "failure"),
  ], T0);
  assert.deepEqual(red1.disagreements, []);
  assert.equal(isBackupCiCalibrated(red1.calibration, RUNNER), true);
  const red2 = mergeCalibration(red1.calibration, REPOSITORY, [
    comparison("8", "success", "failure"),
  ], T0);
  assert.deepEqual(red2.disagreements.map((d) => d.kind), ["false_red"]);
  assert.equal(isBackupCiCalibrated(red2.calibration, RUNNER), false);
  const green = mergeCalibration(five, REPOSITORY, [
    comparison("9", "failure", "success"),
  ], T0);
  assert.deepEqual(green.disagreements.map((d) => d.kind), ["false_green"]);
  assert.equal(isBackupCiCalibrated(green.calibration, RUNNER), false);
  // Runners are counted separately.
  const other = mergeCalibration(five, REPOSITORY, [
    comparison("1", "success", "success", RUNNER2),
  ], T0);
  assert.equal(other.calibration.runners.length, 2);
  assert.equal(isBackupCiCalibrated(other.calibration, RUNNER2), false);
  assert.throws(() =>
    mergeCalibration(
      calibration(),
      { ...REPOSITORY, id: REPOSITORY.id + 1 },
      [],
      T0,
    )
  );
});

Deno.test("suspensions only widen and keep the most severe evidence", () => {
  const evidence = {
    commit: H,
    checkName: CHECK,
    nativeCheckRunId: 42,
    receipt: "bci1:ubiquity/passport.ubq.fi@aaaaaaaaaaaa:x#deno:push:a1",
  };
  const operator = mergeSuspension(null, {
    scope: REPO,
    runnerIds: [RUNNER2],
    reason: "operator",
    since: T0 + 10,
    evidence: null,
  });
  const green = mergeSuspension(operator, {
    scope: REPO,
    runnerIds: [RUNNER, RUNNER2],
    reason: "false_green",
    since: T0 + 20,
    evidence,
  });
  assert.deepEqual(green.runnerIds, [RUNNER, RUNNER2].sort());
  assert.deepEqual([green.reason, green.since, green.evidence], [
    "false_green",
    T0 + 10,
    evidence,
  ]);
  const red = mergeSuspension(green, {
    scope: REPO,
    runnerIds: [RUNNER],
    reason: "false_red",
    since: T0,
    evidence: null,
  });
  assert.deepEqual([red.reason, red.since, red.evidence], [
    "false_green",
    T0,
    evidence,
  ]);
  const all = mergeSuspension(red, {
    scope: REPO,
    runnerIds: "all",
    reason: "operator",
    since: T0,
    evidence: null,
  });
  assert.equal(all.runnerIds, "all");
  assert.throws(() =>
    mergeSuspension(all, {
      scope: "all",
      runnerIds: "all",
      reason: "operator",
      since: T0,
      evidence: null,
    })
  );
});

Deno.test("a suspension covers its scope and runner ids only", () => {
  assert.equal(isBackupCiSuspended([suspension()], REPO, RUNNER), true);
  assert.equal(isBackupCiSuspended([suspension()], REPO, RUNNER2), false);
  assert.equal(
    isBackupCiSuspended([suspension()], "ubiquity/ai.ubq.fi", RUNNER),
    false,
  );
  assert.equal(
    isBackupCiSuspended(
      [suspension({ scope: "all" })],
      "ubiquity/ai.ubq.fi",
      RUNNER,
    ),
    true,
  );
  assert.equal(
    isBackupCiSuspended([suspension({ runnerIds: "all" })], REPO, RUNNER2),
    true,
  );
  assert.equal(isBackupCiSuspended([], REPO, RUNNER), false);
  assert.equal(DIGEST_A.length, 64);
});
