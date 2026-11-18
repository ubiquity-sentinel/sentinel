/**
 * Review MUST 2 (comparison half): a calibration comparison binds the native
 * run's event and, for pull_request, the merge parents its own checkout
 * logged; a red agreement needs a genuine failure at the same workflow step
 * on both sides; a false green counts unless the event or base provably
 * differs. The Passport false green had a pull_request peer compared with
 * whichever native run of the group came last, with no base check. Fakes.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { BackupCiUnitV1 } from "../../src/contracts/backup-ci.ts";
import {
  type BackupCiCompareInputV1,
  backupCiInfraExcerpt,
  backupCiNativeJob,
  backupCiNativeMergeParents,
  classifyBackupCiComparison,
  readBackupCiNativeEvidence,
} from "../../ops/backup-ci-compare.ts";
import type { BackupCiTargetReadsV1 } from "../../ops/backup-ci-plan-reads.ts";
import { B, H, key, unit } from "../github/backup-ci-fixtures.ts";

const OTHER_BASE = "c".repeat(40) as GitSha;
const ts = (s: string) => `2026-11-01T23:20:0${s}.0000000Z`;

function log(lines: string[]): string {
  return lines.map((line, i) => `${ts(String(i % 10))} ${line}`).join("\n");
}

const CHECKOUT_LOG = [
  "##[group]Runner Image Provisioner",
  "Hosted Compute Agent",
  "##[endgroup]",
  "##[group]Run actions/checkout@v4",
  "with:",
  "##[group]Checking out the ref",
  "/usr/bin/git checkout --progress --force refs/remotes/pull/7/merge",
  `HEAD is now at 1a2b3c4 Merge ${H} into ${B}`,
  "##[endgroup]",
  "##[group]Run deno test",
  "deno test",
];

Deno.test("the merge parents come only from a first-step checkout section", () => {
  assert.deepEqual(backupCiNativeMergeParents(log(CHECKOUT_LOG)), {
    head: H,
    base: B,
  });
  // A target step cannot forge the binding: only the first section counts.
  const forged = [
    "##[group]Run ./prepare.sh",
    `HEAD is now at 1a2b3c4 Merge ${H} into ${OTHER_BASE}`,
    ...CHECKOUT_LOG.slice(3),
  ];
  assert.equal(backupCiNativeMergeParents(log(forged)), "unbound");
  const twice = [
    ...CHECKOUT_LOG.slice(0, 8),
    `HEAD is now at 1a2b3c4 Merge ${H} into ${OTHER_BASE}`,
    ...CHECKOUT_LOG.slice(8),
  ];
  assert.equal(backupCiNativeMergeParents(log(twice)), "unbound");
  // The section must end inside the read prefix.
  assert.equal(
    backupCiNativeMergeParents(log(CHECKOUT_LOG.slice(0, 8))),
    "unbound",
  );
  // "##[group]Runner Image" is set-up, not a step header.
  assert.equal(
    backupCiNativeMergeParents(log(CHECKOUT_LOG.slice(0, 3))),
    "unbound",
  );
});

const STEPS = unit().steps;

function job(over: Record<string, unknown> = {}) {
  return {
    id: 501,
    head_sha: H,
    status: "completed",
    conclusion: "failure",
    runner_id: 9,
    steps: [
      { name: "Set up job", number: 1, conclusion: "success" },
      { name: "Pre Run actions/cache@v4", number: 2, conclusion: "success" },
      { name: "Run actions/checkout@v6", number: 3, conclusion: "success" },
      { name: "Run deno test", number: 4, conclusion: "failure" },
      {
        name: "Post Run actions/checkout@v6",
        number: 5,
        conclusion: "success",
      },
      { name: "Complete job", number: 6, conclusion: "success" },
    ],
    ...over,
  };
}

Deno.test("a native job maps its failing step onto the unit's workflow steps", () => {
  assert.deepEqual(backupCiNativeJob(job(), 501, H, STEPS), {
    conclusion: "failure",
    neverStarted: false,
    failingStep: 1,
  });
  // A step count that does not match the unit maps nothing.
  const extra = job();
  extra.steps = [...extra.steps, {
    name: "Run extra",
    number: 7,
    conclusion: "success",
  }];
  assert.equal(backupCiNativeJob(extra, 501, H, STEPS)?.failingStep, null);
  // A never-started job (no steps, no runner).
  assert.deepEqual(
    backupCiNativeJob(job({ steps: [], runner_id: 0 }), 501, H, STEPS),
    { conclusion: "failure", neverStarted: true, failingStep: null },
  );
  // Bound to the id and head it was read for.
  assert.equal(backupCiNativeJob(job(), 502, H, STEPS), null);
});

function compare(
  over: Partial<BackupCiCompareInputV1> = {},
): ReturnType<typeof classifyBackupCiComparison> {
  return classifyBackupCiComparison({
    nativeEvent: "pull_request",
    native: { conclusion: "failure", neverStarted: false, failingStep: 1 },
    nativeMerge: { head: H, base: B },
    context: "pull_request",
    commit: H,
    base: B,
    backup: { conclusion: "failure", failingStep: 1, excerpt: "assert" },
    ...over,
  });
}

Deno.test("a red agreement needs a genuine failure at the same step on both sides", () => {
  assert.deepEqual(compare(), { kind: "comparable", class: "red" });
  assert.deepEqual(
    compare({
      backup: { conclusion: "failure", failingStep: 0, excerpt: "x" },
    }),
    { kind: "incomparable", reason: "step_mismatch" },
  );
  assert.deepEqual(
    compare({
      native: { conclusion: "timed_out", neverStarted: false, failingStep: 1 },
    }),
    { kind: "incomparable", reason: "native_not_genuine" },
  );
  assert.deepEqual(
    compare({
      backup: {
        conclusion: "failure",
        failingStep: 1,
        excerpt: "bun: command not found",
      },
    }),
    { kind: "incomparable", reason: "backup_not_genuine" },
  );
  assert.deepEqual(
    compare({
      backup: { conclusion: "timed_out", failingStep: 1, excerpt: null },
    }),
    { kind: "incomparable", reason: "backup_not_genuine" },
  );
  assert.deepEqual(
    compare({
      native: { conclusion: "failure", neverStarted: false, failingStep: null },
    }),
    { kind: "incomparable", reason: "native_not_genuine" },
  );
  assert.equal(
    backupCiInfraExcerpt("Process completed with exit code 127."),
    true,
  );
  assert.equal(backupCiInfraExcerpt("1 test failed"), false);
});

Deno.test("agreements need a proven binding; a false green counts unless disproven", () => {
  const green = {
    native: { conclusion: "success", neverStarted: false, failingStep: null },
    backup: {
      conclusion: "success" as const,
      failingStep: null,
      excerpt: null,
    },
  };
  assert.deepEqual(compare(green), { kind: "comparable", class: "green" });
  // Unbound (the native log was unreadable): no agreement…
  assert.deepEqual(compare({ ...green, nativeMerge: "unbound" }), {
    kind: "incomparable",
    reason: "native_unbound",
  });
  // …but a native red against a backup green still counts as a false green.
  const falseGreen = {
    backup: {
      conclusion: "success" as const,
      failingStep: null,
      excerpt: null,
    },
  };
  assert.deepEqual(compare({ ...falseGreen, nativeMerge: "unbound" }), {
    kind: "comparable",
    class: "false_green",
  });
  // Provably different code is never compared, in either direction.
  assert.deepEqual(
    compare({ ...falseGreen, nativeMerge: { head: H, base: OTHER_BASE } }),
    { kind: "incomparable", reason: "native_base" },
  );
  assert.deepEqual(compare({ ...falseGreen, nativeEvent: "push" }), {
    kind: "incomparable",
    reason: "native_event",
  });
  assert.deepEqual(
    compare({
      ...falseGreen,
      native: { conclusion: "failure", neverStarted: true, failingStep: null },
    }),
    { kind: "incomparable", reason: "native_not_started" },
  );
  // Push context binds by event alone.
  assert.deepEqual(
    compare({
      ...green,
      context: "push",
      base: null,
      nativeEvent: "push",
      nativeMerge: null,
    }),
    { kind: "comparable", class: "green" },
  );
});

function reads(
  runs: Record<string, unknown>[],
  events: Record<number, string>,
  logs: Record<number, string> = {},
): BackupCiTargetReadsV1 {
  return {
    checkRuns: () => Promise.resolve(runs),
    suites: () =>
      Promise.resolve(
        Object.entries(events).map(([suiteId, event]) => ({
          suiteId: Number(suiteId),
          runId: Number(suiteId) + 1000,
          workflowPath: ".github/workflows/ci.yml",
          event,
        })),
      ),
    job: (id: number) =>
      Promise.resolve(job({
        id,
        conclusion: runs.find((r) => r.id === id)?.conclusion,
      })),
    jobLogPrefix: (id: number) => Promise.resolve(logs[id] ?? null),
  } as unknown as BackupCiTargetReadsV1;
}

function run(id: number, suite: number, conclusion: string, at: string) {
  return {
    id,
    name: "deno",
    head_sha: H,
    status: "completed",
    conclusion,
    started_at: at,
    app: { slug: "github-actions" },
    check_suite: { id: suite },
  };
}

Deno.test("the Passport shape: a pull_request peer is never compared with a push run", async () => {
  // The planned native of the peer was the push run (suite 11); before, the
  // comparison counted it as a false green against a pull_request leg.
  const peer: BackupCiUnitV1 = {
    ...unit(key({ context: "pull_request" })),
    purpose: "peer",
    native: { checkRunId: 501, conclusion: "failure" },
  };
  const fake = reads(
    [run(501, 11, "failure", ts("1")), run(502, 12, "success", ts("2"))],
    { 11: "push", 12: "pull_request" },
  );
  const evidence = await readBackupCiNativeEvidence(fake, peer);
  assert.equal(evidence?.event, "push");
  assert.deepEqual(
    classifyBackupCiComparison({
      nativeEvent: evidence!.event,
      native: evidence!.job,
      nativeMerge: evidence!.merge,
      context: "pull_request",
      commit: H,
      base: B,
      backup: { conclusion: "success", failingStep: null, excerpt: null },
    }),
    { kind: "incomparable", reason: "native_event" },
  );
});

Deno.test("a stand-in's native run is the newest started one of its own event", async () => {
  const standIn = unit(key({ context: "pull_request" }));
  const fake = reads(
    [
      run(501, 11, "failure", ts("3")),
      run(502, 12, "failure", ts("2")),
      run(503, 12, "success", ts("1")),
    ],
    { 11: "push", 12: "pull_request" },
    { 502: log(CHECKOUT_LOG) },
  );
  const evidence = await readBackupCiNativeEvidence(fake, standIn);
  assert.equal(evidence?.checkRunId, 502);
  assert.equal(evidence?.event, "pull_request");
  assert.deepEqual(evidence?.merge, { head: H, base: B });
  assert.equal(evidence?.job?.failingStep, 1);
});
