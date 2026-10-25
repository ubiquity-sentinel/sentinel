/**
 * The launcher's base-repair pass (2026-10-24 throughput redesign, stage 1;
 * reworked 2026-10-25 after its review). A foreign target whose base tip
 * fails a check that its held records' heads fail too gets exactly one
 * unlabelled base-repair issue per tip, marked with the branch and tip on
 * its first line and naming only those checks. A red check no held head
 * fails (Passport's dispatch-only deploy jobs), a record on an older base,
 * an App issue already marked for this tip (open or closed), a live older
 * marked issue, and any unreadable read file nothing. The pass writes no
 * state.
 */
import assert from "node:assert/strict";
import { baseRepairMarker } from "../../src/repair/base-repair.ts";
import {
  CANDIDATE_CONCLUSIONS,
  RED_BASE_CONCLUSIONS,
  UNTRUSTED_CHECK_NAME,
} from "../../src/repair/ci-rejection.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  BASE_REPAIR_FILING_ENABLED,
  BASE_REPAIR_HEAD_READS,
  baseRepairIssue,
  runHostedBaseRepairPass,
} from "../../ops/hosted-autonomy-base-repair.ts";
import type {
  HostedAppIssueV1,
  HostedAutonomyGitHubV1,
} from "../../ops/hosted-autonomy-types.ts";
import {
  liveRecord,
  liveRig,
  liveSnapshot,
  liveSurface,
  NOW,
  TIP,
} from "./hosted-autonomy-spent-fixtures.ts";

const TAG = "base-repair:ubiquity/ai.ubq.fi";
const HEAD = "1".repeat(40);
const OLD_TIP = "2".repeat(40);
const MARKER = baseRepairMarker("development", TIP);

/** The CI-first gate's red-base hold, as a live poll re-arms it. */
const HELD = { reason: "backoff", since: NOW - 60_000, until: NOW + 1_740_000 };

/** A record of ai.ubq.fi issue `issue` (the live #618 row, re-identified). */
function record(
  issue: number,
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  const template = liveRecord(618);
  return liveRecord(618, {
    id: `issue-ubiquity-ai.ubq.fi-${issue}`,
    source: { ...template.source, id: String(issue) },
    related: { ...template.related, issueNumber: issue },
    ...overrides,
  });
}

/** The live #618 target, published at `head` on `base`. */
function target(head: string, base: string) {
  const { branch, pr } = liveRecord(618).target;
  return { base, branch, checkpoint: null, head, pr };
}

/** A record held by its red base on `base` with published `head`. */
function held(issue: number, head = HEAD, base = TIP): WorkRecordV1 {
  return record(issue, {
    nextStep: "work",
    blocker: null,
    wait: HELD,
    target: target(head, base),
  });
}

function appIssue(
  number: number,
  firstLine: string,
  overrides: Partial<HostedAppIssueV1> = {},
): HostedAppIssueV1 {
  return { number, state: "open", pullRequest: false, firstLine, ...overrides };
}

interface PassOptions {
  /** Failed check names by commit (absent: none failed). */
  failed: Record<string, string[] | null>;
  issues?: readonly HostedAppIssueV1[] | null;
  work?: WorkRecordV1[];
  filing?: boolean;
}

async function pass(options: PassOptions) {
  const { surface: base } = liveSurface({ tip: TIP });
  const filed: { title: string; body: string }[] = [];
  const reads: { commit: string; conclusions: readonly string[] }[] = [];
  let listings = 0;
  const surface: HostedAutonomyGitHubV1 = {
    ...base,
    failedChecks: (commit, conclusions) => {
      reads.push({ commit, conclusions });
      return Promise.resolve(
        commit in options.failed ? options.failed[commit] : [],
      );
    },
    baseRepairIssues: {
      listAppAuthored: () => {
        listings++;
        return Promise.resolve(
          options.issues === undefined ? [] : options.issues,
        );
      },
      create: (input) => {
        filed.push(input);
        return Promise.resolve(4242);
      },
    },
  };
  const work = options.work ?? [held(618)];
  const rig = await liveRig("base-repair", liveSnapshot(work, []), surface);
  try {
    const actions = await runHostedBaseRepairPass(
      {
        state: rig.state,
        githubFor: rig.githubFor,
        clock: { now: () => NOW },
      },
      undefined,
      options.filing === undefined ? {} : { filing: options.filing },
    );
    return { actions, filed, reads, listings, writes: rig.writes };
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
}

Deno.test("base repair pass: filing ships off until its re-review passes", () => {
  assert.equal(BASE_REPAIR_FILING_ENABLED, false);
});

Deno.test("base repair pass: a red tip files one unlabelled, tip-marked issue naming only the checks a held head fails", async () => {
  const { actions, filed, reads, writes } = await pass({
    failed: {
      [TIP]: ["validate", "docs", "deploy-standby", "Workers Standby Deploy"],
      [HEAD]: ["validate", "docs", "head-only"],
    },
  });
  assert.deepEqual(actions, [`${TAG}:filed=#4242`]);
  assert.equal(filed.length, 1);
  assert.equal("labels" in filed[0], false, "no label dependency");
  assert.equal(filed[0].title, "CI is failing on development");
  assert.equal(filed[0].body.split("\n")[0], MARKER);
  assert.ok(filed[0].body.includes(TIP));
  assert.ok(
    filed[0].body.includes("Failing checks:\n- `docs`\n- `validate`\n"),
  );
  for (const name of ["deploy-standby", "Workers Standby", "head-only"]) {
    assert.ok(!filed[0].body.includes(name), name);
  }
  // The tip by the runtime's red-base set, the head by its candidate set.
  assert.deepEqual(reads, [
    { commit: TIP, conclusions: RED_BASE_CONCLUSIONS },
    { commit: HEAD, conclusions: CANDIDATE_CONCLUSIONS },
  ]);
  assert.equal(writes, 0, "the pass writes no state");
});

Deno.test("base repair pass: a tip red only on checks no held head fails files nothing (Passport's dispatch-only deploys)", async () => {
  const { actions, filed, listings } = await pass({
    failed: {
      [TIP]: ["Workers Standby Deploy", "deploy-standby"],
      [HEAD]: ["validate"],
    },
  });
  assert.deepEqual(actions, [`${TAG}:no_held_check`]);
  assert.equal(filed.length, 0);
  assert.equal(listings, 0, "no issue listing is read");
});

Deno.test("base repair pass: no hold on the tip, a green tip and unreadable reads file nothing", async () => {
  const cases: [PassOptions, string[], number][] = [
    // A green tip reads no head.
    [{ failed: { [TIP]: [] } }, [], 1],
    [{ failed: { [TIP]: null } }, [`${TAG}:checks_unreadable`], 1],
    [{ failed: { [TIP]: ["validate"], [HEAD]: null } }, [
      `${TAG}:head_checks_unreadable`,
    ], 2],
    [{ failed: { [TIP]: ["validate"], [HEAD]: ["validate"] }, issues: null }, [
      `${TAG}:issues_unreadable`,
    ], 2],
    // A held record on an older base refreshes onto the tip first.
    [
      {
        failed: { [TIP]: ["validate"], [HEAD]: ["validate"] },
        work: [held(618, HEAD, OLD_TIP)],
      },
      [],
      0,
    ],
    // Parked, and live work that no red-base hold waits on.
    [{ failed: { [TIP]: ["validate"] }, work: [liveRecord(618)] }, [], 0],
    [
      {
        failed: { [TIP]: ["validate"] },
        work: [record(618, { nextStep: "work", blocker: null, wait: null })],
      },
      [],
      0,
    ],
    // A shorter backoff (the CI fix marker) is no red-base hold.
    [
      {
        failed: { [TIP]: ["validate"], [HEAD]: ["validate"] },
        work: [
          record(618, {
            nextStep: "work",
            blocker: null,
            wait: { reason: "backoff", since: NOW, until: NOW },
            target: target(HEAD, TIP),
          }),
        ],
      },
      [],
      0,
    ],
  ];
  for (const [options, expected, readCount] of cases) {
    const { actions, filed, reads } = await pass(options);
    assert.deepEqual(actions, expected, JSON.stringify(options.failed));
    assert.equal(filed.length, 0, JSON.stringify(options.failed));
    assert.equal(reads.length, readCount, JSON.stringify(options.failed));
  }
});

Deno.test("base repair pass: only the first held heads by record id are read", async () => {
  const heads = ["a", "b", "c", "d", "e"].map((c) => c.repeat(40));
  const { actions, reads } = await pass({
    failed: { [TIP]: ["validate"], [heads[4]]: ["validate"] },
    work: heads.map((head, index) => held(700 + index, head)).reverse(),
  });
  assert.deepEqual(
    reads.slice(1).map((read) => read.commit),
    heads.slice(0, BASE_REPAIR_HEAD_READS),
  );
  // The fifth head's failure is never read, so nothing holds on the tip.
  assert.deepEqual(actions, [`${TAG}:no_held_check`]);
});

Deno.test("base repair pass: an App issue already marked for this tip, open or closed, files nothing", async () => {
  const red = { [TIP]: ["validate"], [HEAD]: ["validate"] };
  for (const state of ["open", "closed"] as const) {
    const { actions, filed } = await pass({
      failed: red,
      issues: [appIssue(7, MARKER, { state })],
    });
    assert.deepEqual(actions, [`${TAG}:filed_before=#7`], state);
    assert.equal(filed.length, 0, state);
  }
  // A pull request is not the issue, and only the first line marks one.
  for (
    const issues of [
      [appIssue(7, MARKER, { pullRequest: true })],
      [appIssue(7, `quoted: ${MARKER}`)],
      [appIssue(7, baseRepairMarker("main", TIP), { state: "closed" })],
    ]
  ) {
    const { actions, filed } = await pass({ failed: red, issues });
    assert.deepEqual(actions, [`${TAG}:filed=#4242`], JSON.stringify(issues));
    assert.equal(filed.length, 1);
  }
});

Deno.test("base repair pass: an open issue marked for an older tip holds a new one only while its record is live", async () => {
  const red = { [TIP]: ["validate"], [HEAD]: ["validate"] };
  const older = appIssue(900, baseRepairMarker("development", OLD_TIP));
  const legacy = appIssue(900, "<!-- sentinel:base-repair:development -->");
  const live = record(900, {
    nextStep: "work",
    blocker: null,
    wait: null,
    target: target("3".repeat(40), OLD_TIP),
  });
  const done = record(900, {
    nextStep: "done",
    blocker: null,
    wait: null,
    intent: null,
  });
  const cases: [HostedAppIssueV1[], WorkRecordV1[], string][] = [
    [[older], [live], `${TAG}:open=#900`],
    [[legacy], [live], `${TAG}:open=#900`],
    // Not admitted yet: it is still the one open repair.
    [[older], [], `${TAG}:open=#900`],
    // Parked (the live #618 row is parked) or done: a new tip, a new issue.
    [[older], [record(900)], `${TAG}:filed=#4242`],
    [[older], [done], `${TAG}:filed=#4242`],
    [[{ ...older, state: "closed" }], [live], `${TAG}:filed=#4242`],
    [
      [appIssue(900, baseRepairMarker("main", OLD_TIP))],
      [live],
      `${TAG}:filed=#4242`,
    ],
  ];
  for (const [issues, others, expected] of cases) {
    const { actions, filed } = await pass({
      failed: red,
      issues,
      work: [held(618), ...others],
    });
    assert.deepEqual(actions, [expected], JSON.stringify(issues));
    assert.equal(filed.length, expected.endsWith("4242") ? 1 : 0);
  }
});

Deno.test("base repair pass: filing off reads nothing", async () => {
  const { actions, reads, listings } = await pass({
    failed: { [TIP]: ["validate"], [HEAD]: ["validate"] },
    filing: false,
  });
  assert.deepEqual(actions, []);
  assert.equal(reads.length, 0);
  assert.equal(listings, 0);
});

Deno.test("base repair pass: check names take the runtime's trusted shape and are bounded in the issue", () => {
  const { body } = baseRepairIssue("main", TIP, [
    "a`b\u0007c",
    "x".repeat(300),
    "validate",
    "validate",
  ]);
  assert.ok(body.includes(`- \`${UNTRUSTED_CHECK_NAME}\``));
  assert.ok(body.includes("- `validate`"));
  assert.equal(body.split("- `validate`").length, 2, "deduplicated");
  assert.ok(!body.includes("a`b") && !body.includes("xxxx"));
  const many = baseRepairIssue(
    "main",
    TIP,
    Array.from({ length: 25 }, (_, index) => `check-${index}`),
  ).body;
  assert.ok(many.includes("- and 5 more"));
});
