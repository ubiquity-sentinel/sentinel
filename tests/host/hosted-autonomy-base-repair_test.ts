/**
 * The launcher's base-repair pass (2026-10-24 throughput redesign, stage 1;
 * reworked 2026-10-25 after its review; enabled for ai.ubq.fi only by the
 * owner decision of 2026-11-15). A listed foreign target whose base tip
 * fails a check that its held records' heads fail too gets exactly one
 * unlabelled base-repair issue per tip, marked with the branch and tip on
 * its first line and naming only those checks. A red check no held head
 * fails (Passport's dispatch-only deploy jobs), a record on an older base,
 * an App issue already marked for this tip (open or closed), any open
 * base-repair issue, a target outside the allowlist, and any unreadable read
 * file nothing. The pass writes no state.
 */
import { INACTIVE_CI_MINUTES } from "../../src/budget/ci-minutes.ts";
import assert from "node:assert/strict";
import { baseRepairMarker } from "../../src/repair/base-repair.ts";
import {
  CANDIDATE_CONCLUSIONS,
  RED_BASE_CONCLUSIONS,
  UNTRUSTED_CHECK_NAME,
} from "../../src/repair/ci-rejection.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  BASE_REPAIR_FILING_TARGETS,
  BASE_REPAIR_HEAD_READS,
  baseRepairFilingEnabled,
  baseRepairIssue,
  runHostedBaseRepairPass,
} from "../../ops/hosted-autonomy-base-repair.ts";
import { isBaseRepairListed } from "../../ops/hosted-autonomy-base-repair-bounds.ts";
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
import { checkoutSource } from "./hosted-autonomy-base-repair-fixtures.ts";

const TAG = "base-repair:ubiquity/ai.ubq.fi";
const DAY = 24 * 60 * 60_000;
const HEAD = "1".repeat(40);
const OLD_TIP = "2".repeat(40);
const MARKER = baseRepairMarker("development", TIP);

/** The CI-first gate's red-base hold, as a live poll re-arms it. */
const HELD = { reason: "backoff", since: NOW - 60_000, until: NOW + 1_740_000 };

/**
 * A record of issue `issue` of `name` (ai.ubq.fi unless named; the live #618
 * row, re-identified).
 */
function record(
  issue: number,
  overrides: Record<string, unknown> = {},
  name = "ai.ubq.fi",
): WorkRecordV1 {
  const template = liveRecord(618);
  return liveRecord(618, {
    id: `issue-ubiquity-${name}-${issue}`,
    repository: { ...template.repository, name },
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

/**
 * An App issue with a neutral title, filed before the hard bound's window
 * (so only its marker and state decide here).
 */
function appIssue(
  number: number,
  firstLine: string,
  overrides: Partial<HostedAppIssueV1> = {},
): HostedAppIssueV1 {
  return {
    number,
    state: "open",
    pullRequest: false,
    firstLine,
    title: `Issue ${number}`,
    createdAt: NOW - 30 * DAY,
    ...overrides,
  };
}

interface PassOptions {
  /** Failed check names by commit (absent: none failed). */
  failed: Record<string, string[] | null>;
  /** The App's issues; null: the listing is unreadable. */
  issues?: readonly HostedAppIssueV1[] | null;
  work?: WorkRecordV1[];
}

async function pass(options: PassOptions) {
  const { surface: base } = liveSurface({ tip: TIP });
  const filed: { title: string; body: string }[] = [];
  const reads: { commit: string; conclusions: readonly string[] }[] = [];
  let listings = 0;
  const work = options.work ?? [held(618)];
  // GitHub lists the App's pull requests too: the records' own, opened
  // before the open ceiling's window.
  const pulls = [...new Set(work.map((row) => row.target.pr))].flatMap((pr) =>
    pr === null
      ? []
      : [appIssue(pr, "", { pullRequest: true, createdAt: NOW - 30 * DAY })]
  );
  const items = [...pulls, ...(options.issues ?? [])];
  const surface: HostedAutonomyGitHubV1 = {
    ...base,
    // The rig routes every repository here, the Sentinel one too: the
    // installed runtime's source is this checkout's, which carries the cap.
    readFileAt: (path) => checkoutSource(path),
    failedChecks: (commit, conclusions) => {
      reads.push({ commit, conclusions });
      return Promise.resolve(
        commit in options.failed ? options.failed[commit] : [],
      );
    },
    baseRepairIssues: {
      listAppAuthored: () => {
        listings++;
        return Promise.resolve(options.issues === null ? null : items);
      },
      listCreatedSince: () =>
        Promise.resolve(
          [...items].sort((a, b) => b.createdAt - a.createdAt).map((item) => ({
            ...item,
            author: "ubiquity-sentinel[bot]",
          })),
        ),
      create: (input) => {
        filed.push(input);
        return Promise.resolve(4242);
      },
    },
  };
  const rig = await liveRig("base-repair", liveSnapshot(work, []), surface);
  try {
    const actions = await runHostedBaseRepairPass(
      {
        ciMinutes: INACTIVE_CI_MINUTES,
        state: rig.state,
        githubFor: rig.githubFor,
        clock: { now: () => NOW },
      },
    );
    return { actions, filed, reads, listings, writes: rig.writes };
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
}

Deno.test("base repair pass: filing is enabled for ubiquity/ai.ubq.fi only (owner decision 2026-11-15)", () => {
  assert.deepEqual([...BASE_REPAIR_FILING_TARGETS], ["ubiquity/ai.ubq.fi"]);
  assert.ok(Object.isFrozen(BASE_REPAIR_FILING_TARGETS));
  const repository = liveRecord(618).repository;
  assert.equal(baseRepairFilingEnabled(repository), true);
  for (
    const name of [
      "uusd.ubq.fi",
      "permit2-rpc-manager",
      "AI.UBQ.FI",
      "sentinel",
    ]
  ) assert.equal(baseRepairFilingEnabled({ ...repository, name }), false, name);
  assert.equal(
    baseRepairFilingEnabled({ ...repository, owner: "ubiquity-sentinel" }),
    false,
  );
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

Deno.test("base repair pass: any open base-repair issue holds a new one, whatever its records; a closed one does not", async () => {
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
    // One open base-repair issue per target at a time (2026-11-15): parked
    // (the live #618 row is parked) or done, another branch's, or two open.
    [[older], [record(900)], `${TAG}:open=#900`],
    [[older], [done], `${TAG}:open=#900`],
    [
      [appIssue(900, baseRepairMarker("main", OLD_TIP))],
      [live],
      `${TAG}:open=#900`,
    ],
    [[appIssue(901, older.firstLine), older], [], `${TAG}:open=#900`],
    // Closed, a pull request, or a marker elsewhere: not an open repair.
    [[{ ...older, state: "closed" }], [live], `${TAG}:filed=#4242`],
    [[{ ...older, pullRequest: true }], [live], `${TAG}:filed=#4242`],
    [[appIssue(900, `see ${older.firstLine}`)], [], `${TAG}:filed=#4242`],
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

Deno.test("base repair pass: a held target outside the allowlist reads nothing", async () => {
  for (const name of ["uusd.ubq.fi", "permit2-rpc-manager"]) {
    const { actions, reads, listings, filed } = await pass({
      failed: { [TIP]: ["validate"], [HEAD]: ["validate"] },
      work: [
        record(40, {
          nextStep: "work",
          blocker: null,
          wait: HELD,
          target: target(HEAD, TIP),
        }, name),
      ],
    });
    assert.deepEqual(actions, [], name);
    assert.equal(reads.length, 0, name);
    assert.equal(listings, 0, name);
    assert.equal(filed.length, 0, name);
  }
});

Deno.test("base repair pass: a default branch that is not a plain ref name files nothing", async () => {
  for (const branch of ["dev`x", "main <!--", "@{-1}", "-x", "a\nb"]) {
    const { surface: base } = liveSurface({ tip: TIP });
    let reads = 0;
    const filed: unknown[] = [];
    const rig = await liveRig(
      "base-repair-branch",
      liveSnapshot([held(618)], []),
      {
        ...base,
        readDefaultBranch: () => Promise.resolve(branch),
        failedChecks: () => {
          reads++;
          return Promise.resolve(["validate"]);
        },
        baseRepairIssues: {
          listAppAuthored: () => Promise.resolve([]),
          listCreatedSince: () => Promise.resolve([]),
          create: (input) => {
            filed.push(input);
            return Promise.resolve(4242);
          },
        },
      },
    );
    try {
      const actions = await runHostedBaseRepairPass({
        ciMinutes: INACTIVE_CI_MINUTES,
        state: rig.state,
        githubFor: rig.githubFor,
        clock: { now: () => NOW },
      });
      assert.deepEqual(actions, [`${TAG}:branch_unsupported`], branch);
      assert.equal(reads, 0, branch);
      assert.deepEqual(filed, [], branch);
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
    }
  }
});

Deno.test("base repair pass: recognizes the exact App issue title or first-line marker", () => {
  // The filed title is the recognised shape, on any plain branch.
  const { title } = baseRepairIssue("release/v2.1", TIP, ["validate"]);
  assert.equal(isBaseRepairListed(appIssue(1, "", { title })), true);
  for (
    const [issue, expected] of [
      [appIssue(1, MARKER), true],
      [appIssue(1, "<!-- sentinel:base-repair:main -->"), true],
      [appIssue(1, "edited", { title: "CI is failing on development" }), true],
      [appIssue(1, MARKER, { pullRequest: true }), false],
      [appIssue(1, "", { title: "CI is failing on development" }), true],
      [appIssue(1, "", { title: "CI is failing on development!" }), false],
      [appIssue(1, "", { title: "Re: CI is failing on development" }), false],
      [appIssue(1, `see ${MARKER}`), false],
    ] as const
  ) assert.equal(isBaseRepairListed(issue), expected, JSON.stringify(issue));
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
