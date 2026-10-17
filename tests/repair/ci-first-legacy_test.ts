/**
 * The one-time legacy exception (owner decision 2026-10-16): ai.ubq.fi
 * records spent their review rounds under the old review-before-CI order and
 * are parked on a red head. Each gets CI fixes (at most three) and then
 * exactly ONE final current-head review on the green head, merging through
 * the delivery lane when that review has no unresolved P0/P1.
 *
 * The owner named twelve; R79 kept reviewing before CI, so the table is the
 * owner's class by rule at repair state 8c2ce497f (2026-10-17T01:27Z): 21
 * records blocked with `CI checks failed: ...`, holding retries 0, no intent,
 * a preserved candidate equal to its published head and a completed review
 * of that head on its exact base with no P0/P1 (P2 only for 137, 638, 668
 * and 680). The derivation case re-reads that state commit from the local
 * object store (ignored in a checkout without it) and proves the pinned
 * table is exactly what the rule yields there.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { HostedRuntimeRecordV1 } from "../../src/contracts/hosted-supervisor.ts";
import { HOSTED_RUNTIME_ID } from "../../src/contracts/hosted-supervisor.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { ciCorrectable } from "../../src/repair/ci-rejection.ts";
import { CI_FIRST_REVIEW_ROUNDS } from "../../src/repair/ci-first-policy.ts";
import { LEGACY_REVIEW_ROUND_PINS } from "../../src/repair/review-round-cap.ts";
import {
  ciGreenHeadKey,
  HOSTED_AUTONOMY_CI_CORRECTION_RUNTIMES,
} from "../../ops/hosted-autonomy-ci-retries.ts";
import { planHostedRetries } from "../../ops/hosted-autonomy-retries.ts";
import { hostedRepositoryKey } from "../../ops/hosted-autonomy-policy.ts";
import {
  reservation,
  reviewReceipt,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import { seededSnapshot } from "./loop-rig.ts";
import { healthyProof } from "../host/hosted-autonomy-rig.ts";
import { check, ciFirstRig, SHA4, taskRecord } from "./ci-first-rig.ts";

const AIUBQ = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
} as const;
const BLOCKER = "CI checks failed: verify-artifact(skipped), validate(failure)";
/** No review charge: the round count is the record's own counter. */
const NO_LEDGER = { reservations: [] } as const;

/** issue, PR, round pin, attempts, head, reviewed base, review severities. */
const LIVE: readonly [
  number,
  number,
  number,
  number,
  string,
  string,
  string[],
][] = [
  [
    137,
    1086,
    5,
    7,
    "68df90cfdc564b0062187345f237c621f1d97e5b",
    "430b203c9e26cacd10914d6cc4af584d4a249ada",
    ["P2"],
  ],
  [
    575,
    1101,
    3,
    6,
    "fedfacca9b8553aa3fbbd220ff73ff7d130ff2e0",
    "b479053254d6114ecaf202be6ee5d24c144918f7",
    [],
  ],
  [
    595,
    1087,
    4,
    3,
    "91e37288980dd6e6002137cc08eb942b9503fa6a",
    "8ea3def4b7a995086a8b92a80cc77bc781b00b85",
    [],
  ],
  [
    597,
    1089,
    5,
    3,
    "e667676f3b729c8a9199b1793474c2908e31543a",
    "8ea3def4b7a995086a8b92a80cc77bc781b00b85",
    [],
  ],
  [
    602,
    1092,
    6,
    5,
    "182ae7fbab91ea8ae30753ed382cb5fa789acf14",
    "9fc845d4b8185bfb4c19fa07296ea9ed8c0305da",
    [],
  ],
  [
    605,
    1054,
    3,
    2,
    "9f8d3f5657d81cf865cdeaf9f543bb1d56b7fa51",
    "a4e3ac2c6fd52f2a2f39778c2eeea17128edb93c",
    [],
  ],
  [
    610,
    1106,
    3,
    5,
    "b5c284f316774aaf7e0adacfb91fd77d6fe6aebf",
    "f9b310abbd4f71595356f498c50245913c07dcb7",
    [],
  ],
  [
    618,
    1071,
    7,
    3,
    "31f7ea943216526840a0328573d3c227ff498472",
    "8a99ecbeaf8fd5f845fd6be034e284dd370f332c",
    [],
  ],
  [
    634,
    1003,
    4,
    6,
    "70734a05ea6f1730b9a1f3862659903ba35cbcb6",
    "9fc845d4b8185bfb4c19fa07296ea9ed8c0305da",
    [],
  ],
  [
    638,
    1005,
    5,
    7,
    "7f0c1b6ef25d525c3de5668636cf4cfe13409349",
    "9fc845d4b8185bfb4c19fa07296ea9ed8c0305da",
    ["P2"],
  ],
  [
    668,
    1056,
    4,
    2,
    "e93cffffc1392e85615387b80837b769f4eaf1c4",
    "a4e3ac2c6fd52f2a2f39778c2eeea17128edb93c",
    ["P2"],
  ],
  [
    672,
    1094,
    3,
    3,
    "f9cc2aa8065afc8ca4859fbd9e5a679c59c81321",
    "8ea3def4b7a995086a8b92a80cc77bc781b00b85",
    [],
  ],
  [
    673,
    1095,
    7,
    3,
    "4ca2fe2fa64432d86b2f45fcc30a892d87e228ff",
    "8ea3def4b7a995086a8b92a80cc77bc781b00b85",
    [],
  ],
  [
    678,
    1097,
    6,
    4,
    "d9732e8a9989599c0842e4b653daa062ce46a563",
    "9fc845d4b8185bfb4c19fa07296ea9ed8c0305da",
    [],
  ],
  [
    679,
    1098,
    6,
    4,
    "234b7d58beb018abe06dcf6c29be57a61fcf5041",
    "9fc845d4b8185bfb4c19fa07296ea9ed8c0305da",
    [],
  ],
  [
    680,
    1099,
    4,
    3,
    "feb3483951bb9d1c831cb8cd09bf675f1c6a4132",
    "8ea3def4b7a995086a8b92a80cc77bc781b00b85",
    ["P2"],
  ],
  [
    693,
    1117,
    3,
    5,
    "d1459edb6ec7a815e9ea2b1baa503d05ad009624",
    "430b203c9e26cacd10914d6cc4af584d4a249ada",
    [],
  ],
  [
    694,
    1118,
    3,
    5,
    "e5dbc90f589247e5473f819ed1998959b9e4806c",
    "c208779cc3f3d05113b3a9b2406f056438448650",
    [],
  ],
  [
    698,
    1112,
    9,
    2,
    "5b6ed9b468fa8409e7509ca3b5392c2f686624d5",
    "c208779cc3f3d05113b3a9b2406f056438448650",
    [],
  ],
  [
    754,
    1119,
    3,
    5,
    "d42b191b6916010a9753a4b38bafedcc8b861e77",
    "430b203c9e26cacd10914d6cc4af584d4a249ada",
    [],
  ],
  [
    879,
    1120,
    3,
    2,
    "b055f21163ae0c265d96836ce733e9e720c84d79",
    "8a99ecbeaf8fd5f845fd6be034e284dd370f332c",
    [],
  ],
];

/** Development tip at 23:50Z: every reviewed base is behind it. */
const TIP = "9fc845d4a1b2c3d4e5f60718293a4b5c6d7e8f90" as GitSha;

function legacyRecord(
  [issue, pr, rounds, attempts, head, base]: typeof LIVE[number],
  overrides: Partial<WorkRecordV1> = {},
): WorkRecordV1 {
  const id = `issue-ubiquity-ai.ubq.fi-${issue}`;
  return workRecord(id, {
    repository: AIUBQ,
    source: { kind: "issue", id: String(issue), revision: SHA1 },
    related: { incidentId: null, issueNumber: issue },
    failingRevision: null,
    target: {
      base,
      branch: `sentinel/repair/${id}`,
      checkpoint: null,
      head,
      pr,
      candidateState: {
        preserved: {
          base,
          head,
          operationKey: `base_refresh:${pr}:${"b".repeat(40)}:${base}`,
          ref: `refs/heads/sentinel-candidates/${"e".repeat(64)}`,
        },
        publishedHead: head,
      },
    },
    nextStep: "blocked",
    blocker: { kind: "other", message: BLOCKER, since: T0 + 5000 },
    counters: { attempts, retries: 0, reviewRounds: rounds },
    ...overrides,
  });
}

function legacyReview(row: typeof LIVE[number]) {
  const [issue, pr, , , head, base, severities] = row;
  return reviewReceipt(`review-legacy-${issue}`, {
    repository: AIUBQ,
    pullRequest: { number: pr, head, base },
    outcome: "completed",
    observedReviewer: "chatgpt-codex-connector[bot]",
    resultId: `result-legacy-${issue}`,
    findings: severities.map((severity, index) => ({
      id: `finding-${issue}-${index}`,
      severity,
      path: "src/x.ts",
      message: "deferred tech debt",
      fingerprint: "e".repeat(64),
      resolved: false,
      resolutionEvidence: null,
    })),
    unresolvedSeverities: severities,
    submittedAt: T0 - 2_000,
    completedAt: T0 - 1_000,
    observedAt: T0 - 500,
  });
}

function liveSnapshot(): RepairStateSnapshotV1 {
  return seededSnapshot(LIVE.map((row) => legacyRecord(row)), {
    reviews: LIVE.map(legacyReview),
    reservations: LIVE.map(([issue, , , , head]) =>
      reservation(`legacy-review-${issue}`, {
        repository: AIUBQ,
        taskId: `issue-ubiquity-ai.ubq.fi-${issue}`,
        head,
        attempt: 1,
        purpose: "review_request",
        outcome: "submitted",
        settledAt: T0 + 900,
      })
    ),
  });
}

Deno.test("legacy exception: each of the 21 live records may take a CI fix at its round pin", () => {
  for (const row of LIVE) {
    const record = legacyRecord(row);
    assert.equal(
      ciCorrectable(record, NO_LEDGER),
      true,
      `issue ${row[0]} at its pin`,
    );
    const spent = legacyRecord(row, {
      counters: { ...record.counters, reviewRounds: row[2] + 1 },
    });
    assert.equal(
      ciCorrectable(spent, NO_LEDGER),
      false,
      `issue ${row[0]} past its pin`,
    );
    const exhausted = legacyRecord(row, {
      counters: { ...record.counters, attempts: 6, retries: 3 },
    });
    assert.equal(
      ciCorrectable(exhausted, NO_LEDGER),
      false,
      `issue ${row[0]} fixed 3x`,
    );
  }
  // The exception is exactly the pinned class: the same shape on another
  // record, repository or task identity gets nothing.
  const [, ...rest] = LIVE[0];
  const other = legacyRecord([583, ...rest] as typeof LIVE[number]);
  assert.equal(ciCorrectable(other, NO_LEDGER), false, "583 is not listed");
  assert.deepEqual(
    [...LEGACY_REVIEW_ROUND_PINS].sort((a, b) => a[0] - b[0]),
    LIVE.map(([issue, , rounds]) => [issue, rounds]),
    "the fixture rows are the pinned table",
  );
  const foreign = legacyRecord(LIVE[0], {
    repository: { ...AIUBQ, installationId: 7 },
  });
  assert.equal(
    ciCorrectable(foreign, NO_LEDGER),
    false,
    "another installation",
  );
});

/** An installed CI-correction runtime at generation 80 with its own proof. */
const R80 = "8080808080808080808080808080808080808080" as GitSha;
function installed(
  revision: string,
  generation: number,
): HostedRuntimeRecordV1 {
  return {
    version: "v1",
    kind: "hosted_runtime",
    id: HOSTED_RUNTIME_ID,
    activeRevision: revision,
    generation,
    lastHealthyProof: healthyProof(revision, generation, "ci-first-release"),
    lastExecutionProof: null,
    nextOrdinaryAt: T0,
    execution: null,
    createdAt: T0,
    updatedAt: T0,
  } as HostedRuntimeRecordV1;
}

function plan(runtime: string, generation: number, ciFirst: string[]) {
  const snapshot = liveSnapshot();
  const tips = new Map([[hostedRepositoryKey(AIUBQ), TIP]]);
  const settled = new Set(
    LIVE.map(([, , , , head]) => ciGreenHeadKey(AIUBQ, head)),
  );
  const options = {
    ciRuntime: installed(runtime, generation),
    ciAllowlist: new Set([runtime]),
    ciFirstAllowlist: new Set(ciFirst),
    ciRerunSettled: settled,
  } as Parameters<typeof planHostedRetries>[6];
  return planHostedRetries(
    snapshot,
    T0 + 9000,
    runtime as GitSha,
    tips,
    new Set(),
    undefined,
    options,
  );
}

Deno.test("legacy exception: the launcher re-admits the 21 only under an allowlisted CI-first runtime", () => {
  // Under R79 (CI corrections, but no CI-first gate) a re-admitted legacy
  // record would spend its one final review on a still-red refreshed head.
  const r79 = [...HOSTED_AUTONOMY_CI_CORRECTION_RUNTIMES].at(-1)!;
  assert.deepEqual(plan(r79, 79, []), [], "inert under R79");
  assert.deepEqual(plan(R80, 80, []), [], "inert until R80 is pinned");
  const plans = plan(R80, 80, [R80]);
  assert.deepEqual(
    plans.map((p) => p.id).sort(),
    LIVE.map(([issue]) => `issue-ubiquity-ai.ubq.fi-${issue}`).sort(),
  );
  for (const item of plans) {
    assert.equal(item.nextStep, "delivery");
    assert.equal(item.advanceBase, false, "the runtime refreshes, not this");
    assert.equal(item.reviewRounds, null, "no counter is touched");
  }
});

/** Repair state the table is pinned at (2026-10-17T01:27Z). */
const PINNED_STATE = "8c2ce497f567ef61e29f3c063c09e1d9f806860e";
const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname)
  .replace(/\/$/, "");
const GIT_ENV = {
  PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

async function pinnedStateAvailable(): Promise<boolean> {
  try {
    const probe = await new Deno.Command("git", {
      args: ["-C", ROOT, "cat-file", "-e", `${PINNED_STATE}^{commit}`],
      clearEnv: true,
      env: GIT_ENV,
      stdout: "null",
      stderr: "null",
    }).output();
    return probe.success;
  } catch {
    return false;
  }
}

/** The pinned state's work and review rows, read-only from the object store. */
async function readPinnedState(): Promise<{
  work: WorkRecordV1[];
  reviews: RepairStateSnapshotV1["reviews"];
}> {
  const dir = await Deno.makeTempDir({ dir: ROOT, prefix: "legacy-pins-" });
  try {
    const archive = await new Deno.Command("git", {
      args: [
        "-C",
        ROOT,
        "archive",
        "--format=tar",
        PINNED_STATE,
        "work",
        "reviews",
      ],
      clearEnv: true,
      env: GIT_ENV,
      stdout: "piped",
      stderr: "null",
    }).output();
    assert.ok(archive.success, "pinned state readable");
    await Deno.writeFile(`${dir}/state.tar`, archive.stdout);
    const extracted = await new Deno.Command("tar", {
      args: ["-xf", `${dir}/state.tar`, "-C", dir],
      clearEnv: true,
      env: { PATH: GIT_ENV.PATH },
      stdout: "null",
      stderr: "null",
    }).output();
    assert.ok(extracted.success, "pinned state extracted");
    const rows = async <T>(name: string): Promise<T[]> => {
      const out: T[] = [];
      for await (const entry of Deno.readDir(`${dir}/${name}`)) {
        out.push(
          JSON.parse(await Deno.readTextFile(`${dir}/${name}/${entry.name}`)),
        );
      }
      return out;
    };
    return { work: await rows("work"), reviews: await rows("reviews") };
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test({
  name:
    "legacy exception: the pinned table is exactly the owner's class by rule at the pinned live state",
  ignore: !(await pinnedStateAvailable()),
  async fn() {
    const { work, reviews } = await readPinnedState();
    // The class: parked on the merge gate's CI failure after spending every
    // ordinary round, nothing in flight, its exact head reviewed on its exact
    // base with no unresolved P0/P1. In every repository, not only ai.ubq.fi.
    const members = work.filter((record) => {
      const blocker = record.blocker;
      const { head, pr, base } = record.target;
      return record.nextStep === "blocked" && blocker !== null &&
        blocker.kind === "other" &&
        blocker.message.startsWith("CI checks failed: ") &&
        record.counters.reviewRounds >= CI_FIRST_REVIEW_ROUNDS &&
        record.intent === null && record.source.kind === "issue" &&
        record.related.issueNumber !== null &&
        reviews.some((review) =>
          review.repository.owner === record.repository.owner &&
          review.repository.name === record.repository.name &&
          review.repository.installationId ===
            record.repository.installationId &&
          review.pullRequest.number === pr &&
          review.pullRequest.head === head &&
          review.pullRequest.base === base &&
          review.outcome === "completed" &&
          !review.unresolvedSeverities.some((severity) =>
            severity === "P0" || severity === "P1"
          )
        );
    });
    for (const record of members) {
      assert.deepEqual(record.repository, AIUBQ, record.id);
      assert.equal(
        record.id,
        `issue-ubiquity-ai.ubq.fi-${record.related.issueNumber}`,
      );
    }
    assert.deepEqual(
      members.map((record) => [
        record.related.issueNumber!,
        record.counters.reviewRounds,
      ]).sort((a, b) => a[0] - b[0]),
      [...LEGACY_REVIEW_ROUND_PINS].sort((a, b) => a[0] - b[0]),
    );
    // The fixture rows are the live rows.
    for (const [issue, pr, rounds, attempts, head, base, severities] of LIVE) {
      const record = members.find((row) => row.related.issueNumber === issue)!;
      assert.deepEqual(
        [
          record.target.pr,
          record.counters.reviewRounds,
          record.counters.attempts,
          record.target.head,
          record.target.base,
          record.counters.retries,
        ],
        [pr, rounds, attempts, head, base, 0],
        `issue ${issue}`,
      );
      assert.ok(
        reviews.some((review) =>
          review.pullRequest.number === pr &&
          review.pullRequest.head === head &&
          review.pullRequest.base === base &&
          JSON.stringify(review.unresolvedSeverities) ===
            JSON.stringify(severities)
        ),
        `issue ${issue} review`,
      );
    }
  },
});

const LEGACY_595 = {
  repository: AIUBQ,
  id: "issue-ubiquity-ai.ubq.fi-595",
  issue: 595,
};
const PREP3 = "3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a" as GitSha;
const PREP4 = "4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b" as GitSha;

Deno.test("legacy exception: a red legacy head is fixed, refreshed and reviewed exactly once, then merges", async () => {
  // 595 as the launcher re-admits it: its reviewed base (SHA1) is behind the
  // tip (SHA2), its head SHA3 is red, and every review round up to its pin
  // (4) is spent.
  const { rig } = await ciFirstRig("cf-legacy-red", {
    identity: LEGACY_595,
    reviewed: true,
    reviewRounds: 4,
    attempts: 3,
    nextStep: "delivery",
    baseTip: SHA2,
    refreshTo: { [SHA3]: PREP3, [SHA4]: PREP4 },
    checks: {
      [SHA3]: [check("validate", SHA3, "failure")],
      [PREP3]: [check("validate", PREP3, "failure")],
      [SHA1]: [check("validate", SHA1, "success")],
      [SHA2]: [check("validate", SHA2, "success")],
    },
  });
  try {
    for (let run = 0; run < 4; run++) {
      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      if (rig.github.reviewRequestIdentities.length > 0) break;
      rig.clock.advance(5 * 60_000 + 1);
    }
    assert.equal(rig.model.requests.length, 1, "one CI fix, no other model");
    assert.equal(rig.model.requests[0].checkoutBase, SHA3);
    assert.equal(
      rig.model.requests[0].base,
      SHA1,
      "fixed on its reviewed base",
    );
    assert.deepEqual(
      rig.github.reviewRequestIdentities.map((r) => r.expectedHead),
      [PREP4],
      "exactly one final review, of the green refreshed fix",
    );
    let work = taskRecord(await rig.snapshot(), LEGACY_595.id);
    assert.equal(work.counters.reviewRounds, 5, "pin + 1");
    assert.equal(work.counters.retries, 1);
    assert.equal(work.target.base, SHA2);

    rig.clock.advance(100_000_000 + 1);
    rig.github.completeReview([], rig.clock.now());
    await rig.run();
    assert.equal(
      rig.github.calls.filter((call) => call === "merge").length,
      1,
      "the green, finally reviewed head merges",
    );
    work = taskRecord(await rig.snapshot(), LEGACY_595.id);
    assert.equal(work.counters.reviewRounds, 5);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("legacy exception: an already-green legacy head needs no fix and gets its one review", async () => {
  // 618/698/879: green after their flake re-run; the base still moved.
  const { rig } = await ciFirstRig("cf-legacy-green", {
    identity: {
      repository: AIUBQ,
      id: "issue-ubiquity-ai.ubq.fi-618",
      issue: 618,
    },
    reviewed: true,
    reviewRounds: 7,
    attempts: 3,
    nextStep: "delivery",
    baseTip: SHA2,
    refreshTo: { [SHA3]: PREP3 },
    checks: {},
  });
  try {
    for (let run = 0; run < 4; run++) {
      await rig.run();
      if (rig.github.reviewRequestIdentities.length > 0) break;
      rig.clock.advance(5 * 60_000 + 1);
    }
    assert.equal(rig.model.requests.length, 0, "no fix for a green head");
    assert.deepEqual(
      rig.github.reviewRequestIdentities.map((r) => r.expectedHead),
      [PREP3],
    );
    const work = taskRecord(
      await rig.snapshot(),
      "issue-ubiquity-ai.ubq.fi-618",
    );
    assert.equal(work.counters.reviewRounds, 8, "pin + 1");
    assert.equal(work.counters.retries, 0);
  } finally {
    await rig.ctx.cleanup();
  }
});
