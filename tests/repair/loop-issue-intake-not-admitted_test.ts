// Live 2026-11-05 (run 42097043887): the throughput watchdog filed #359 and
// #360 as the Sentinel App with `priority:2`, a plain first line and the
// `<!-- sentinel:throughput-watchdog:<id> -->` marker on the second line. The
// run summary read `admitted: 0, skippedIssues: []`, which looked like a
// silent non-admission; both issues had in fact been admitted by earlier runs
// (their records were created at 18:22 and 19:08 UTC). These tests pin that
// such an App-authored issue is admitted like an owner-filed one, and that
// every open issue intake leaves without a record is reported with a reason.
import assert from "node:assert/strict";
import { portOk } from "../../src/contracts/ports.ts";
import type { GitHubIssueV1 } from "../../src/contracts/ports.ts";
import { sanitizeSkippedIssue } from "../../src/github/client-response.ts";
import { scopeLocalRepairIssues } from "../../src/host/local-github.ts";
import { ciOutageMarker } from "../../src/repair/ci-outage-notice.ts";
import { throughputWatchdogMarkerV1 } from "../../src/host/throughput-watchdog-issue.ts";
import { issueRecord, makeMemoryRig, RelationsFakeGithub } from "./loop-rig.ts";
import { SHA1 } from "../state/helpers.ts";

const APP = "ubiquity-sentinel[bot]";

async function intake(
  github: RelationsFakeGithub,
): Promise<
  {
    rig: ReturnType<typeof makeMemoryRig>;
    line: Record<string, unknown> | undefined;
  }
> {
  const rig = makeMemoryRig(github);
  const logs: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (line: unknown) => logs.push(String(line));
    await rig.run();
  } finally {
    console.log = originalLog;
  }
  const line = logs.flatMap((text) => {
    try {
      return [JSON.parse(text)];
    } catch {
      return [];
    }
  }).find((row) => row.kind === "sentinel_issue_intake");
  return { rig, line };
}

function watchdogIssue(number: number): GitHubIssueV1 {
  return issueRecord(number, {
    title: "Throughput: repair phase median at >= 60 live records missed",
    author: APP,
    labels: ["priority:2"],
    body: [
      "Sentinel throughput watchdog: `repair_median` is missed.",
      throughputWatchdogMarkerV1("repair_median"),
      "",
      "- Thresholds live in `src/host/throughput-watchdog-thresholds.ts`.",
    ].join("\n"),
  });
}

Deno.test("issue intake: an App-authored throughput watchdog issue is admitted like an owner-filed one", async () => {
  const github = new RelationsFakeGithub({ baseSha: SHA1 });
  github.listed = [
    watchdogIssue(360),
    issueRecord(297, { author: "0x4007" }),
  ];
  // The production opt-out scope the hosted port is wrapped in.
  scopeLocalRepairIssues(github as never);
  const { rig, line } = await intake(github);
  const state = await rig.snapshot();
  const admitted = state.work.find((row) => row.related.issueNumber === 360);
  assert.ok(admitted, "the watchdog issue has a work record");
  assert.equal(admitted.source.kind, "issue");
  assert.equal(admitted.classification.priority, 2);
  assert.ok(
    state.work.some((row) => row.related.issueNumber === 297),
    "the owner-filed neighbour is admitted the same way",
  );
  assert.deepEqual(line?.skippedIssues, []);
  assert.equal(line?.openIssues, 2);

  // The next poll finds the existing records: nothing is admitted twice and
  // an already recorded issue is not a non-admission.
  const again = await intake(github);
  const after = await again.rig.snapshot();
  assert.equal(
    after.work.filter((row) => row.related.issueNumber === 360).length,
    1,
  );
});

Deno.test("issue intake: every open issue left without a record names its reason", async () => {
  const github = new RelationsFakeGithub({ baseSha: SHA1 });
  github.listed = [
    issueRecord(10, {
      author: APP,
      body: `${ciOutageMarker({ owner: "ubiquity", name: "ai.ubq.fi" })}\n`,
    }),
    issueRecord(11, {
      relations: { subIssueCount: 2, openBlockers: [] },
    }),
    issueRecord(12, {
      relations: {
        subIssueCount: 0,
        openBlockers: [{ owner: "ubiquity", name: "ai.ubq.fi", number: 9 }],
      },
    }),
    issueRecord(13),
  ];
  const { rig, line } = await intake(github);
  const state = await rig.snapshot();
  assert.deepEqual(
    state.work.map((row) => row.related.issueNumber),
    [13],
  );
  const rows = [
    { number: 10, code: "not_admitted", reason: "ci_outage_notice" },
    { number: 11, code: "not_admitted", reason: "native_parent" },
    { number: 12, code: "not_admitted", reason: "native_open_blockers" },
  ];
  assert.deepEqual(line?.skippedIssues, rows);
  assert.equal(line?.openIssues, 4);
  // The launcher's summary reader accepts every row, so the reason reaches
  // `hosted_runtime_summary.targets[].skippedIssues`.
  for (const row of rows) {
    assert.deepEqual(sanitizeSkippedIssue(row, "ubiquity/ai.ubq.fi"), row);
  }
  assert.equal(
    sanitizeSkippedIssue(
      { number: 10, code: "not_admitted", reason: "anything" },
      "ubiquity/ai.ubq.fi",
    ),
    null,
  );
});

Deno.test("issue intake: an unreadable base names every issue it left unadmitted", async () => {
  const github = new RelationsFakeGithub({ baseSha: SHA1 });
  github.listed = [issueRecord(21), issueRecord(22)];
  github.readRef = () => Promise.resolve(portOk(null));
  const { rig, line } = await intake(github);
  const state = await rig.snapshot();
  assert.deepEqual(state.work, []);
  assert.deepEqual(line?.skippedIssues, [
    { number: 21, code: "not_admitted", reason: "base_unavailable" },
    { number: 22, code: "not_admitted", reason: "base_unavailable" },
  ]);
});
