/**
 * Delivery-line fairness (JAM J3, starvation; live ai.ubq.fi 2026-10-17/18).
 * The line was ordered by pull request number among every active contender
 * whose latest review was clean, so contenders that could not deliver (a red
 * head awaiting its CI fix, a CI-fixed head on the tip awaiting its CI before
 * its final review, a reviewed head whose CI was still pending) held it ahead
 * of green, reviewed heads whose rounds were spent: live 698 (PR 1112) and 879
 * (PR 1120) deferred behind them for hours.
 *
 * A head that is deliverable now is held only by a contender landing on the
 * tip or by a deliverable contender ahead of it in line; one record lands at a
 * time, so the launcher still merges at most one per pass and each merge moves
 * the base once (`src/repair/delivery-queue.ts`).
 *
 * The live replays read the REAL records of both states
 * (`tests/fixtures/repair/delivery-line-live.json`); the fleet drives the REAL
 * repair loop and the REAL launcher delivery pass (`delivery-queue-rig.ts`)
 * over more records than the line holds; the rollback case runs the installed
 * generation-80 runtime's own parser and line (R80, when its commit is in the
 * local object store: CI checkouts are shallow).
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import type { GitHubCheckV1 } from "../../src/contracts/ports.ts";
import {
  type ReviewReceiptV1,
  reviewTaskStatementDigest,
} from "../../src/contracts/review-receipt.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { OWNER_DEVELOPMENT_INSTALL_GEN80_REVISION } from "../../src/host/owner-install-runtime-pins.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import {
  type DeliveryLineStandingV1,
  deliveryQueueAhead,
  lineStanding,
} from "../../src/repair/delivery-queue.ts";
import {
  LEGACY_REVIEW_CUTOFF,
  MAX_REVIEW_ROUNDS,
} from "../../src/repair/review-round-cap.ts";
import {
  REPO,
  reservation,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import {
  APP,
  historicalDeliveryScenario,
  queueRig,
} from "./delivery-queue-rig.ts";
import type { HostedPolicyGraph } from "../host/hosted-supervisor-policy-fixture.ts";
import { completedReceipt } from "./loop-review-fixtures.ts";
import { sha } from "./review-round-cap-rig.ts";

type Snapshot = Parameters<typeof deliveryQueueAhead>[0];

interface LiveStateV1 {
  stateCommit: string;
  at: string;
  sequence: number;
  updatedAt: number;
  developmentTip: GitSha;
  work: WorkRecordV1[];
  reservations: BudgetReservationV1[];
  reviews: ReviewReceiptV1[];
  releaseRequests: unknown[];
}

const LIVE = JSON.parse(
  await Deno.readTextFile(
    new URL("../fixtures/repair/delivery-line-live.json", import.meta.url),
  ),
) as { snapshots: LiveStateV1[] };

/** The legacy cutoff every CI-first runtime run receives. */
const CUTOFF = LEGACY_REVIEW_CUTOFF.activatedNotBefore;

const LIVE_ID = (issue: number) => `issue-ubiquity-ai.ubq.fi-${issue}`;

type Ahead = typeof deliveryQueueAhead;

function live(at: string, line: Ahead = deliveryQueueAhead) {
  const state = LIVE.snapshots.find((row) => row.at === at)!;
  const snapshot = state as unknown as Snapshot;
  const record = (issue: number) =>
    state.work.find((row) => row.id === LIVE_ID(issue))!;
  const ahead = (issue: number, view: Snapshot = snapshot) =>
    line(view, record(issue), state.developmentTip, state.updatedAt, CUTOFF)
      ?.id ?? null;
  const replace = (view: Snapshot, next: WorkRecordV1): Snapshot => ({
    ...view,
    work: view.work.map((row) => row.id === next.id ? next : row),
  });
  /** `issue` after its step wrote the refresh intent of the tip. */
  const refreshing = (issue: number): WorkRecordV1 => {
    const row = record(issue);
    return {
      ...row,
      intent: {
        kind: "base_refresh",
        key:
          `base_refresh:${row.target.pr}:${row.target.head}:${state.developmentTip}`,
        startedAt: state.updatedAt,
        branch: row.target.branch,
        expectedHead: row.target.head,
        observedBase: state.developmentTip,
        pr: row.target.pr,
        requestId: null,
        resultId: null,
      },
      updatedAt: state.updatedAt,
    };
  };
  return { state, snapshot, record, ahead, replace, refreshing };
}

const AT_0125 = "2026-10-18T01:25:55Z";
const AT_2036 = "2026-10-17T20:36:22Z";

Deno.test("delivery line (live 01:25Z): 698 and 879 are not held by CI-fixed heads on the tip awaiting their CI", () => {
  const { state, snapshot, record, ahead, replace, refreshing } = live(
    AT_0125,
  );
  // 698 is deliverable now and at the front; nothing it waits for is ahead.
  assert.equal(ahead(698), null);
  // So were 605 (PR 1054), 597 (PR 1089) and 602 (PR 1092), green, reviewed
  // and spent in `delivery` behind their stale merge intents: idle, so the
  // first of them its step reaches refreshes and the others wait behind it.
  for (const issue of [605, 597, 602]) {
    assert.equal(record(issue).intent?.kind, "merge", `${issue}`);
    assert.equal(
      lineStanding(
        snapshot,
        record(issue),
        state.developmentTip,
        state.updatedAt,
        CUTOFF,
      ),
      "ready",
      `${issue}`,
    );
    assert.equal(ahead(issue), null, `${issue}`);
    assert.equal(
      ahead(issue, replace(snapshot, refreshing(698))),
      LIVE_ID(698),
    );
  }
  // Once 698 writes its refresh (each step reloads the state, so the same
  // pass sees it), 879 waits behind 698 alone: one record lands at a time.
  assert.equal(ahead(879, replace(snapshot, refreshing(698))), LIVE_ID(698));
  // The five former holders: CI-fixed legacy heads refreshed onto the tip, at
  // work, waiting for their CI before their one final review.
  for (const issue of [672, 673, 693, 694, 754]) {
    const holder = record(issue);
    assert.equal(holder.nextStep, "work", `${issue}`);
    assert.equal(holder.target.base, state.developmentTip, `${issue}`);
    assert.equal(holder.wait?.reason, "ci_pending", `${issue}`);
    assert.equal(
      lineStanding(
        snapshot,
        holder,
        state.developmentTip,
        state.updatedAt,
        CUTOFF,
      ),
      "re_review",
      `${issue}`,
    );
  }
});

Deno.test("delivery line (live 20:36Z): red heads and heads awaiting their CI hold nobody; deliverable heads go in pull request order", () => {
  const { state, snapshot, record, ahead, replace } = live(AT_2036);
  const tip = state.developmentTip;
  // 595 (PR 1087): spent, reviewed clean, its stale merge intent on a moved
  // base, deliverable now and the lowest such pull request; then 698, 879.
  assert.equal(ahead(595), null);
  assert.equal(ahead(698), LIVE_ID(595));
  assert.equal(ahead(879), LIVE_ID(595));
  const standing = (issue: number) =>
    lineStanding(snapshot, record(issue), tip, state.updatedAt, CUTOFF);
  for (const issue of [595, 698, 879]) {
    assert.equal(standing(issue), "ready", `${issue}`);
  }
  // Red reviewed heads returned to work for their CI fix (629, 610, 615, 617)
  // and heads awaiting their CI or fix before a review on a moved base.
  for (
    const issue of [629, 610, 615, 617, 605, 662, 597, 602, 1128, 1130, 137]
  ) assert.equal(standing(issue), "waiting", `${issue}`);
  // Once 595 is booked (no contender any more), 698 is at the front, and its
  // carried refreshed head on the tip holds 879 until it lands.
  const booked = {
    ...snapshot,
    work: snapshot.work.filter((row) => row.id !== LIVE_ID(595)),
  } as Snapshot;
  assert.equal(ahead(698, booked), null);
  const refreshed: WorkRecordV1 = {
    ...record(698),
    nextStep: "work",
    wait: {
      reason: "ci_pending",
      since: state.updatedAt,
      until: state.updatedAt + 300_000,
    },
    target: { ...record(698).target, base: tip, head: sha(0x698) },
    updatedAt: state.updatedAt,
  };
  assert.equal(
    lineStanding(booked, refreshed, tip, state.updatedAt, CUTOFF),
    "landing",
  );
  assert.equal(ahead(879, replace(booked, refreshed)), LIVE_ID(698));
});

// ---- standings ------------------------------------------------------------

const NOW = T0 + 2000;
const TIP = SHA2;

/** A contender of REPO with `rounds` charges and its latest review. */
function contender(
  index: number,
  rounds: number,
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  return workRecord(`issue-${index}`, {
    repository: REPO,
    source: { kind: "issue", id: String(index), revision: SHA1 },
    related: { incidentId: null, issueNumber: index },
    target: {
      base: SHA1,
      branch: `sentinel/repair/issue-${index}`,
      checkpoint: null,
      head: SHA3,
      pr: 100 + index,
    },
    nextStep: "delivery",
    counters: { attempts: 1, retries: 0, reviewRounds: rounds },
    ...overrides,
  });
}

function line(work: WorkRecordV1[], reviewedHeads: Map<string, GitSha>) {
  return {
    work,
    reservations: work.flatMap((record) =>
      Array.from(
        { length: record.counters.reviewRounds },
        (_, index) =>
          reservation(`${record.id}-review-${index + 1}`, {
            repository: REPO,
            taskId: record.id,
            head: reviewedHeads.get(record.id) ?? record.target.head,
            attempt: index + 1,
            purpose: "review_request",
            outcome: "submitted",
            settledAt: T0 + index,
          }),
      )
    ),
    reviews: work.map((record) =>
      completedReceipt(
        record.target.pr!,
        reviewedHeads.get(record.id) ?? record.target.head!,
        SHA1,
        { id: `receipt-${record.id}`, repository: REPO },
      )
    ),
    releaseRequests: [],
  } as unknown as Snapshot;
}

const EARLIER = sha(0xeee);
const CI_WAIT = { reason: "ci_pending", since: T0, until: T0 + 300_000 };

/** Every shape the line distinguishes, with its standing against TIP. */
const SHAPES: [string, DeliveryLineStandingV1, WorkRecordV1, boolean][] = [
  [
    "spent, reviewed head in delivery on a moved base",
    "ready",
    contender(1, 3),
    false,
  ],
  [
    "spent, reviewed head's CI still pending",
    "waiting",
    contender(2, 3, { wait: CI_WAIT }),
    false,
  ],
  [
    "spent, reviewed red head back at work for its CI fix",
    "waiting",
    contender(3, 3, { nextStep: "work" }),
    false,
  ],
  [
    "spent, carried refreshed head whose base moved again",
    "ready",
    contender(4, 3, { nextStep: "work", wait: CI_WAIT }),
    true,
  ],
  [
    "spent, carried refreshed head on the tip",
    "landing",
    contender(5, 3, {
      nextStep: "work",
      wait: CI_WAIT,
      target: { ...contender(5, 3).target, base: TIP },
    }),
    true,
  ],
  [
    "reviewed on the tip, waiting to merge",
    "landing",
    contender(6, 1, { target: { ...contender(6, 1).target, base: TIP } }),
    false,
  ],
  [
    "CI-fixed head on the tip awaiting its CI before a review",
    "re_review",
    contender(7, 2, {
      nextStep: "work",
      wait: CI_WAIT,
      target: { ...contender(7, 2).target, base: TIP },
    }),
    true,
  ],
  [
    "review in flight on the tip",
    "re_review",
    contender(8, 2, {
      nextStep: "review",
      target: { ...contender(8, 2).target, base: TIP },
    }),
    true,
  ],
  [
    "head awaiting its CI before a review on a moved base",
    "waiting",
    contender(9, 2, { nextStep: "work", wait: CI_WAIT }),
    true,
  ],
  [
    "review in flight on a moved base",
    "waiting",
    contender(10, 2, { nextStep: "review" }),
    true,
  ],
  [
    "reviewed, a round left, in delivery on a moved base",
    "reviewed",
    contender(11, 1),
    false,
  ],
  [
    "reviewed red head with a round left on the tip, at work for its fix",
    "waiting",
    contender(12, 1, {
      nextStep: "work",
      target: { ...contender(12, 1).target, base: TIP },
    }),
    false,
  ],
];

function shapeLine(rows: typeof SHAPES) {
  const reviewedHeads = new Map<string, GitSha>();
  for (const [, , record, refreshed] of rows) {
    if (refreshed) reviewedHeads.set(record.id, EARLIER);
  }
  return line(rows.map(([, , record]) => record), reviewedHeads);
}

Deno.test("delivery line: every contender shape has its standing", () => {
  const snapshot = shapeLine(SHAPES);
  for (const [label, expected, record] of SHAPES) {
    assert.equal(
      lineStanding(snapshot, record, TIP, NOW, null),
      expected,
      label,
    );
  }
});

Deno.test("delivery line: a deliverable head waits only for a landing or a deliverable head ahead of it", () => {
  const me = contender(20, 3);
  for (const [label, expected, other, refreshed] of SHAPES) {
    const snapshot = shapeLine([[label, expected, other, refreshed], [
      "me",
      "ready",
      me,
      false,
    ]]);
    const held = deliveryQueueAhead(snapshot, me, TIP, NOW, null)?.id ?? null;
    // Every `ready` shape has a lower pull request number than `me`.
    const holds = expected === "landing" || expected === "ready";
    assert.equal(held, holds ? other.id : null, label);
  }
  // A deliverable head with a lower number goes first; one with a higher
  // number waits behind it.
  const lower = contender(1, 3);
  const higher = contender(30, 3);
  const both = line([lower, me, higher], new Map());
  assert.equal(deliveryQueueAhead(both, me, TIP, NOW, null)?.id, lower.id);
  assert.equal(deliveryQueueAhead(both, lower, TIP, NOW, null), null);
});

Deno.test("delivery line: a head with a round left also waits for every deliverable head and for a re-review on the tip", () => {
  const me = contender(20, 1);
  for (const [label, expected, other, refreshed] of SHAPES) {
    const snapshot = shapeLine([[label, expected, other, refreshed], [
      "me",
      "reviewed",
      me,
      false,
    ]]);
    const held = deliveryQueueAhead(snapshot, me, TIP, NOW, null)?.id ?? null;
    const holds = expected !== "waiting";
    assert.equal(held, holds ? other.id : null, label);
  }
  // A deliverable head with a HIGHER number still goes first: its merge needs
  // no review, and a refreshed head racing it would lose its round.
  const deliverable = contender(30, 3);
  assert.equal(
    deliveryQueueAhead(line([me, deliverable], new Map()), me, TIP, NOW, null)
      ?.id,
    deliverable.id,
  );
});

// ---- fleet: the REAL loop and the REAL launcher ---------------------------

function charges(
  record: WorkRecordV1,
  rounds: number,
  head: GitSha,
): BudgetReservationV1[] {
  return Array.from(
    { length: rounds },
    (_, index) =>
      reservation(`${record.id}-review-${index + 1}`, {
        repository: REPO,
        taskId: record.id,
        attempt: index + 1,
        head,
        purpose: "review_request",
        outcome: "submitted",
        createdAt: T0 - 30 * 60_000 + index,
        settledAt: T0 - 30 * 60_000 + index + 1,
      }),
  );
}

async function clean(
  record: WorkRecordV1,
  head: GitSha,
): Promise<ReviewReceiptV1> {
  const issueNumber = record.related.issueNumber!;
  return completedReceipt(record.target.pr!, head, SHA1, {
    id: `review-receipt:${record.id}:latest`,
    repository: REPO,
    resultId: `result-${record.id}`,
    expectedReviewer: APP,
    observedReviewer: APP,
    taskAcceptance: {
      issueNumber,
      taskDigest: await reviewTaskStatementDigest({
        issueNumber,
        title: `issue ${issueNumber}`,
        body: "",
      }),
      verdict: "fulfilled",
      evidence: ["the exact reviewed change implements the source issue"],
    },
  });
}

function pending(head: GitSha): GitHubCheckV1[] {
  return [{
    name: "validate",
    status: "in_progress",
    conclusion: null,
    head,
    startedAt: T0,
    completedAt: null,
  }];
}

/** Spent, reviewed clean, green: deliverable from the first run. */
const DELIVERABLE = [104, 105, 106, 108, 109, 110];
/**
 * Two rounds spent on an earlier head, the CI fix published on the tip and
 * its CI still running (live 672, 673, 693, 694, 754): not deliverable until
 * its own review request refreshes it onto a moved tip and its last round
 * reviews it clean.
 */
const ON_TIP = [101, 102];
/** Spent, reviewed clean, the reviewed head's CI pending: 103 turns green. */
const CI_PENDING = [103, 107];

/** Ten records of one repository, one line. */
async function fleet(historicalLauncher?: HostedPolicyGraph) {
  const base = await queueRig(10);
  const shaped: WorkRecordV1[] = [];
  const reservations: BudgetReservationV1[] = [];
  const reviews: ReviewReceiptV1[] = [];
  for (const record of base.records) {
    const pr = record.target.pr!;
    const head = record.target.head!;
    if (ON_TIP.includes(pr)) {
      const earlier = sha(0x300 + pr);
      shaped.push(workRecord(record.id, {
        ...record,
        nextStep: "work",
        target: { ...record.target, base: SHA2 },
        wait: { reason: "ci_pending", since: T0, until: T0 + 5 * 60_000 },
        counters: { attempts: 2, retries: 1, reviewRounds: 2 },
      }));
      reservations.push(...charges(record, 2, earlier));
      reviews.push(await clean(record, earlier));
      continue;
    }
    shaped.push(workRecord(record.id, {
      ...record,
      nextStep: "delivery",
      counters: { attempts: 1, retries: 0, reviewRounds: MAX_REVIEW_ROUNDS },
    }));
    reservations.push(...charges(record, MAX_REVIEW_ROUNDS, head));
    reviews.push(await clean(record, head));
  }
  const rig = await queueRig(10, {
    historicalLauncher,
    tip: SHA2,
    shape: () => shaped,
    reservations,
    reviews,
    reviewer: APP,
    livePolicy: true,
  });
  for (const record of rig.records) {
    const pr = record.target.pr!;
    const head = record.target.head!;
    if (ON_TIP.includes(pr) || CI_PENDING.includes(pr)) {
      rig.github.checksByHead.set(head, pending(head));
    }
  }
  return rig;
}

/** The pass (0-based) whose launcher merged each pull request. */
async function driveFleet(rig: Awaited<ReturnType<typeof fleet>>) {
  const mergedAt = new Map<number, number>();
  for (let run = 0; run < 16; run++) {
    const before = rig.github.launcherMerges.length;
    await rig.launcher();
    assert.ok(
      rig.github.launcherMerges.length - before <= 1,
      `at most one merge per pass (pass ${run})`,
    );
    for (const merge of rig.github.launcherMerges.slice(before)) {
      mergedAt.set(merge.pr, run);
    }
    // 103's reviewed head turns green before the third pass's runtime run.
    if (run === 2) {
      const head = rig.records.find((row) => row.target.pr === 103)!.target
        .head!;
      rig.github.checksByHead.delete(head);
    }
    await runRepairCycle(rig.deps, {
      deadline: rig.clock.now() + 60 * 60_000,
      stepLimit: 16,
    });
    rig.clock.advance(16 * 60_000);
  }
  return mergedAt;
}

Deno.test(
  "delivery line fairness: over a fleet larger than the line every deliverable head takes the line as soon as it is deliverable, one merge per pass",
  historicalDeliveryScenario(async (graph) => {
    const rig = await fleet(graph);
    const before = await rig.snapshot();
    const mergedAt = await driveFleet(rig);
    const order = [...mergedAt.entries()].sort((a, b) => a[1] - b[1]).map((
      [pr],
    ) => pr);
    const trace = JSON.stringify([...mergedAt]);
    // Every head that was or became deliverable merged; 107, whose CI never
    // finished, did not.
    assert.deepEqual(
      [...order].sort(),
      [...DELIVERABLE, ...ON_TIP, 103].sort(),
      trace,
    );
    // The line never idles while a deliverable head waits: the first lands on
    // the second pass and every pass after it merges one, so ten records merge
    // in nine passes with nothing held behind a head that could not deliver.
    assert.equal(mergedAt.get(order[0]), 1, trace);
    for (let index = 1; index < order.length; index++) {
      assert.equal(
        mergedAt.get(order[index]),
        mergedAt.get(order[index - 1])! + 1,
        trace,
      );
    }
    // Deliverable heads go in pull request order. 103 takes the line once its
    // CI is green: behind the landing it found and the lower numbers that
    // became deliverable with it (101, 102), ahead of every higher number
    // still waiting.
    assert.deepEqual(
      order.filter((pr) => DELIVERABLE.includes(pr)),
      DELIVERABLE,
    );
    assert.ok(order.indexOf(101) < order.indexOf(102), trace);
    assert.ok(order.indexOf(102) < order.indexOf(103), trace);
    for (const pr of [108, 109, 110]) {
      assert.ok(order.indexOf(103) < order.indexOf(pr), `${pr}: ${trace}`);
    }
    // Nothing was charged or refreshed for a head that could not deliver, and
    // no round past the ceiling: only 101's and 102's own last rounds.
    const after = await rig.snapshot();
    assert.equal(
      after.reservations.length,
      before.reservations.length + ON_TIP.length,
    );
    for (const record of after.work) {
      assert.ok(record.counters.reviewRounds <= MAX_REVIEW_ROUNDS, record.id);
    }
    assert.deepEqual(
      rig.github.reviewed.map((review) => review.pr).sort(),
      ON_TIP,
    );
    assert.equal(
      rig.github.preparedKeys.some((key) => key.startsWith("107:")),
      false,
    );
    assert.equal(rig.github.calls.filter((call) => call === "merge").length, 0);
    // 103 waited its turn with one write: the clear of its stale CI wait once
    // its head read green, then nothing until its refresh (no per-pass write).
    const versions = rig.writes.map((written) =>
      JSON.stringify(written.work.find((row) => row.id === "issue-3"))
    );
    const green = versions.findIndex((row) =>
      !row.includes('"ci_pending"') && !row.includes('"base_refresh"')
    );
    const refresh = versions.findIndex((row) => row.includes('"base_refresh"'));
    assert.ok(green > 0 && refresh > green, `${green} ${refresh}`);
    assert.equal(new Set(versions.slice(green, refresh)).size, 1);
    assert.equal(JSON.parse(versions[green]).wait, null);
  }),
);

// ---- rollback: generation 80 ---------------------------------------------

const R80 = OWNER_DEVELOPMENT_INSTALL_GEN80_REVISION;
const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname)
  .replace(/\/$/, "");
const GIT_ENV = {
  PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

async function r80Available(): Promise<boolean> {
  try {
    return (await new Deno.Command("git", {
      args: ["-C", ROOT, "cat-file", "-e", `${R80}^{commit}`],
      clearEnv: true,
      env: GIT_ENV,
      stdout: "null",
      stderr: "null",
    }).output()).success;
  } catch {
    return false;
  }
}

/** R80's own `src/` modules, extracted read-only under the repository. */
async function loadR80(paths: readonly string[]) {
  const dir = await Deno.makeTempDir({ dir: ROOT, prefix: "sentinel-r80-" });
  const dispose = () => Deno.remove(dir, { recursive: true }).catch(() => {});
  try {
    const archive = await new Deno.Command("git", {
      args: ["-C", ROOT, "archive", "--format=tar", R80, "src"],
      clearEnv: true,
      env: GIT_ENV,
      stdout: "piped",
      stderr: "null",
    }).output();
    assert.ok(archive.success, "R80 source");
    await Deno.writeFile(`${dir}/src.tar`, archive.stdout);
    const extracted = await new Deno.Command("tar", {
      args: ["-xf", `${dir}/src.tar`, "-C", dir],
      clearEnv: true,
      env: { PATH: GIT_ENV.PATH },
      stdout: "null",
      stderr: "null",
    }).output();
    assert.ok(extracted.success, "R80 source extracted");
    const modules: Record<string, unknown>[] = [];
    for (const path of paths) {
      modules.push(await import(new URL(`file://${dir}/${path}`).href));
    }
    return { modules, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

Deno.test({
  name:
    "delivery line rollback: R80 parses every state the fleet wrote and holds every other record behind a refresh this line admitted",
  ignore: !await r80Available(),
  fn: historicalDeliveryScenario(async (graph) => {
    const { modules, dispose } = await loadR80([
      "src/contracts/state-snapshots.ts",
      "src/repair/delivery-queue.ts",
    ]);
    try {
      const parse = modules[0].parseRepairStateSnapshotV1 as (
        value: unknown,
      ) => RepairStateSnapshotV1;
      const r80Ahead = modules[1].deliveryQueueAhead as Ahead;
      const rig = await fleet(graph);
      await driveFleet(rig);
      assert.ok(rig.writes.length > 0);
      for (const written of rig.writes) {
        parse(JSON.parse(JSON.stringify(written)));
      }
      // Live 01:25Z: once this line let 698 refresh (a base-refresh intent,
      // a shape R80 writes itself), R80's own line holds 879 behind exactly
      // that refresh, so a rollback mid-landing never lands two at once.
      const { snapshot, record, ahead, refreshing } = live(AT_0125, r80Ahead);
      const pair = {
        ...snapshot,
        work: [refreshing(698), record(879)],
      } as Snapshot;
      assert.equal(ahead(879, pair), LIVE_ID(698));
      assert.equal(
        ahead(879, { ...pair, work: [record(698), record(879)] } as Snapshot),
        null,
        "698 idle and not refreshing holds nobody under R80 either",
      );
    } finally {
      await dispose();
    }
  }),
});
