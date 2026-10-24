/**
 * The one-time legacy exception (owner decision 2026-10-16): ai.ubq.fi
 * records spent their review rounds under the old review-before-CI order and
 * are on a red head. Each gets CI fixes (at most three) and then exactly ONE
 * final current-head review on the green head, merging when that review has
 * no unresolved P0/P1.
 *
 * The class is a rule (`review-round-cap.ts`): records whose rounds were
 * admitted before the CI-first runtime's activation (the cutoff the launcher
 * pins and hands over). The fixture rows are the 28 records the round-1
 * table pinned at repair state 18369d9b9 (2026-10-17T09:07Z): blocked with
 * `CI checks failed: ...`, holding retries 0, no intent, a preserved
 * candidate equal to its published head and a completed review of that head
 * on its exact base with no P0/P1 (P2 only for 137, 638, 668 and 680). The
 * derivation cases re-read live state commits from the local object store
 * (ignored in a checkout without them): at that cut the rule yields exactly
 * the old table, and at the fresh state it also covers the records in flight
 * there (645, 646, 657, 663 and 1140, in review on red heads), which no
 * install-time table could pin.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { HostedRuntimeRecordV1 } from "../../src/contracts/hosted-supervisor.ts";
import { HOSTED_RUNTIME_ID } from "../../src/contracts/hosted-supervisor.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import { completedReceipt } from "./loop-review-fixtures.ts";
import { ciCorrectable } from "../../src/repair/ci-rejection.ts";
import {
  LEGACY_REVIEW_ROUND_CEILING,
  legacyFinalRoundOpen,
  legacyReviewRoundClassDrift,
  legacyReviewRoundPin,
} from "../../src/repair/review-round-cap.ts";
import {
  ciGreenHeadKey,
  HOSTED_AUTONOMY_CI_CORRECTION_RUNTIMES,
} from "../../ops/hosted-autonomy-ci-retries.ts";
import { planHostedRetries } from "../../ops/hosted-autonomy-retries.ts";
import { OWNER_DEVELOPMENT_INSTALL_GEN79_REVISION } from "../../src/host/owner-install-runtime-pins.ts";
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
/** The legacy cutoff of these cases: every seeded admission precedes it. */
const CUT = T0;

/** One old review admission (before the cutoff) per record, as live. */
function oldLedger(record: WorkRecordV1): {
  reservations: BudgetReservationV1[];
} {
  return {
    reservations: [
      reservation(`${record.id}-old-review`, {
        repository: record.repository,
        taskId: record.id,
        head: record.target.head,
        attempt: 1,
        purpose: "review_request",
        outcome: "submitted",
        createdAt: CUT - 60_000,
        settledAt: CUT - 59_000,
      }),
    ],
  };
}

/** A review admission charged after the cutoff (the final review). */
function lateReview(record: WorkRecordV1, attempt: number) {
  return reservation(`${record.id}-late-review-${attempt}`, {
    repository: record.repository,
    taskId: record.id,
    head: record.target.head,
    attempt,
    purpose: "review_request",
    outcome: "submitted",
    createdAt: CUT + 60_000,
    settledAt: CUT + 61_000,
  });
}

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
    583,
    1103,
    4,
    6,
    "60265837e538b78c2a20737a2c595e295aa03078",
    "973bb2f45230993da7896784f0ec4bf908bf3de9",
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
    615,
    1111,
    3,
    6,
    "618d7d7c002f5515db9d3b855611a5ed27f82848",
    "ded498ffbcd9f39d57f3da6e05425cf2f8059f50",
    [],
  ],
  [
    617,
    1108,
    3,
    6,
    "2cd8b0ba150afda971ac0b79d58ed3e90c78279a",
    "ded498ffbcd9f39d57f3da6e05425cf2f8059f50",
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
    629,
    998,
    3,
    6,
    "10cf428245f4eae73b62b3c15369aa2176d1aa5b",
    "ded498ffbcd9f39d57f3da6e05425cf2f8059f50",
    [],
  ],
  [
    633,
    1002,
    3,
    6,
    "66630816cf97ea6131143cd0ca9e9103a9d7c38a",
    "ded498ffbcd9f39d57f3da6e05425cf2f8059f50",
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
    650,
    1078,
    3,
    8,
    "9b24f02e0dbeccf96b2ec201297500503e7eec25",
    "9cdc76dc600246d96a0841ba7fca5039cbf34196",
    [],
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
  [
    1128,
    1142,
    5,
    3,
    "e3d3ad98b66ccfc9cfc4aa0072bd7e9438599b19",
    "9cdc76dc600246d96a0841ba7fca5039cbf34196",
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
        createdAt: CUT - 60_000,
        settledAt: CUT - 59_000,
      })
    ),
  });
}

Deno.test("legacy exception: each of the 28 live records may take a CI fix at its round pin", () => {
  for (const row of LIVE) {
    const record = legacyRecord(row);
    const ledger = oldLedger(record);
    assert.equal(legacyReviewRoundPin(ledger, record, CUT), row[2]);
    assert.equal(
      ciCorrectable(record, ledger, CUT),
      true,
      `issue ${row[0]} at its pin`,
    );
    // No cutoff (no CI-first runtime): nothing is legacy.
    assert.equal(ciCorrectable(record, ledger, null), false);
    // A review admitted after the cutoff spends the one final round.
    const spent = legacyRecord(row, {
      counters: { ...record.counters, reviewRounds: row[2] + 1 },
    });
    assert.equal(
      ciCorrectable(spent, {
        reservations: [...ledger.reservations, lateReview(spent, row[2] + 1)],
      }, CUT),
      false,
      `issue ${row[0]} past its pin`,
    );
    const exhausted = legacyRecord(row, {
      counters: { ...record.counters, attempts: 6, retries: 3 },
    });
    assert.equal(
      ciCorrectable(exhausted, ledger, CUT),
      false,
      `issue ${row[0]} fixed 3x`,
    );
  }
  // The same shape whose rounds were all admitted after the cutoff is new
  // under the CI-first runtime: nothing.
  const [, ...rest] = LIVE[0];
  const other = legacyRecord([1583, ...rest] as typeof LIVE[number]);
  assert.equal(
    ciCorrectable(other, {
      reservations: [1, 2, 3, 4, 5].map((attempt) =>
        lateReview(other, attempt)
      ),
    }, CUT),
    false,
    "1583 is new",
  );
  const foreign = legacyRecord(LIVE[0], {
    repository: { ...AIUBQ, installationId: 7 },
  });
  assert.equal(
    ciCorrectable(foreign, oldLedger(foreign), CUT),
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
  // The retry pass read every head's CI: all red.
  const options = {
    ciRuntime: installed(runtime, generation),
    ciAllowlist: new Set([runtime]),
    ciFirstAllowlist: new Set(ciFirst),
    ciRerunSettled: settled,
    ciReadHeads: settled,
    ciGreenHeads: new Set<string>(),
    // The launcher's own cutoff: the one pinned cutoff under a proven
    // CI-first runtime, none otherwise.
    legacyReviewCutoff: ciFirst.includes(runtime) ? CUT : null,
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

Deno.test("legacy exception: the launcher re-admits the 28 only under an allowlisted CI-first runtime", () => {
  // Under R79 (CI corrections, but no CI-first gate) a re-admitted legacy
  // record would spend its one final review on a still-red refreshed head.
  const r79 = OWNER_DEVELOPMENT_INSTALL_GEN79_REVISION;
  assert.ok(HOSTED_AUTONOMY_CI_CORRECTION_RUNTIMES.has(r79));
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

/** The repair state the round-1 table was pinned at (2026-10-17T09:07Z). */
const CUT_STATE = "18369d9b95da761ec5ca5c59ce7335ced6c429e0";
/** Fresh live repair state (sequence 39831, 2026-10-17T12:08Z). */
const FRESH_STATE = "3bbd4b9f500702319051bf537144a42c8fcee4d6";
const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname)
  .replace(/\/$/, "");
const GIT_ENV = {
  PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

async function stateAvailable(commit: string): Promise<boolean> {
  try {
    const probe = await new Deno.Command("git", {
      args: ["-C", ROOT, "cat-file", "-e", `${commit}^{commit}`],
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

/** One live state's rows, read-only from the object store. */
async function readState(commit: string): Promise<{
  updatedAt: number;
  work: WorkRecordV1[];
  reviews: RepairStateSnapshotV1["reviews"];
  reservations: BudgetReservationV1[];
}> {
  const dir = await Deno.makeTempDir({ dir: ROOT, prefix: "legacy-state-" });
  try {
    const archive = await new Deno.Command("git", {
      args: [
        "-C",
        ROOT,
        "archive",
        "--format=tar",
        commit,
        "manifest.json",
        "work",
        "reviews",
        "reservations",
      ],
      clearEnv: true,
      env: GIT_ENV,
      stdout: "piped",
      stderr: "null",
    }).output();
    assert.ok(archive.success, "live state readable");
    await Deno.writeFile(`${dir}/state.tar`, archive.stdout);
    const extracted = await new Deno.Command("tar", {
      args: ["-xf", `${dir}/state.tar`, "-C", dir],
      clearEnv: true,
      env: { PATH: GIT_ENV.PATH },
      stdout: "null",
      stderr: "null",
    }).output();
    assert.ok(extracted.success, "live state extracted");
    const rows = async <T>(name: string): Promise<T[]> => {
      const out: T[] = [];
      for await (const entry of Deno.readDir(`${dir}/${name}`)) {
        out.push(
          JSON.parse(await Deno.readTextFile(`${dir}/${name}/${entry.name}`)),
        );
      }
      return out;
    };
    const manifest = JSON.parse(
      await Deno.readTextFile(`${dir}/manifest.json`),
    ) as { updatedAt: number };
    return {
      updatedAt: manifest.updatedAt,
      work: await rows("work"),
      reviews: await rows("reviews"),
      reservations: await rows("reservations"),
    };
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test({
  name:
    "legacy exception: at the round-1 cut the rule yields exactly the table that was pinned there",
  ignore: !(await stateAvailable(CUT_STATE)),
  async fn() {
    const { updatedAt, work, reviews, reservations } = await readState(
      CUT_STATE,
    );
    const ledger = { reservations };
    // The owner's class shape at that state: parked on the merge gate's CI
    // failure after spending every ordinary round, nothing in flight, its
    // exact head reviewed on its exact base with no unresolved P0/P1.
    const members = work.filter((record) => {
      const blocker = record.blocker;
      const { head, pr, base } = record.target;
      return record.nextStep === "blocked" && blocker !== null &&
        blocker.kind === "other" &&
        blocker.message.startsWith("CI checks failed: ") &&
        record.counters.reviewRounds >= LEGACY_REVIEW_ROUND_CEILING &&
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
    // Had the CI-first runtime activated at that state, the rule pins each
    // member at exactly the pin the table carried, its final round open.
    assert.deepEqual(
      members.map((record) => [
        record.related.issueNumber!,
        legacyReviewRoundPin(ledger, record, updatedAt),
      ]).sort((a, b) => a[0]! - b[0]!),
      LIVE.map(([issue, , rounds]) => [issue, rounds]),
    );
    for (const record of members) {
      assert.equal(
        legacyFinalRoundOpen(ledger, record, updatedAt),
        true,
        record.id,
      );
    }
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

Deno.test({
  name:
    "legacy exception: the rule covers the records in flight at the fresh state, which no install-time table could pin",
  ignore: !(await stateAvailable(FRESH_STATE)),
  async fn() {
    const { updatedAt, work, reservations } = await readState(FRESH_STATE);
    const ledger = { reservations };
    const record = (issue: number) =>
      work.find((row) =>
        row.repository.name === "ai.ubq.fi" &&
        row.related.issueNumber === issue
      )!;
    // In review on red heads under R79's review-before-CI order at the
    // round-1 recheck (sequence 39670), parked CI-red since: each pinned at
    // every round it spent, its one final round open for its CI fix.
    for (
      const [issue, pin] of [[645, 6], [646, 6], [657, 6], [663, 5], [1140, 3]]
    ) {
      assert.equal(
        legacyReviewRoundPin(ledger, record(issue), updatedAt),
        pin,
        `${issue}`,
      );
      assert.equal(
        legacyFinalRoundOpen(ledger, record(issue), updatedAt),
        true,
        `${issue}`,
      );
      assert.equal(
        ciCorrectable(record(issue), ledger, updatedAt),
        true,
        `${issue} may take its CI fix`,
      );
    }
    // Every record of the owner's class shape there is covered by the rule.
    assert.deepEqual(
      legacyReviewRoundClassDrift({ work, reservations }, updatedAt),
      [],
    );
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
    legacyReviewCutoff: CUT,
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

Deno.test("legacy exception: an already-green legacy head spends no round: it is refreshed to carry its review and handed to the launcher's merge", async () => {
  // 618/698/879: green after their flake re-run; the base still moved. The
  // owner's exception is for red CI only: a green head is merged like every
  // spent record whose latest review authorizes it, through one mechanical
  // refresh that carries that review once its patch is proven identical and
  // the refreshed head is green. The runtime never merges it (its port
  // refuses every merge on live ai.ubq.fi): it waits for the launcher's
  // delivery pass, which merges the refreshed head at that exact tip.
  // Its latest review accepted the live task (the blanket fake issue text).
  const accepted = completedReceipt(7, SHA3, SHA1, {
    id: "review-receipt:618-latest",
    repository: AIUBQ,
    taskAcceptance: {
      issueNumber: 618,
      taskDigest: await reviewTaskStatementDigest({
        issueNumber: 618,
        title: "issue 618",
        body: "",
      }),
      verdict: "fulfilled",
      evidence: ["the exact reviewed change implements the source issue"],
    },
  });
  const { rig } = await ciFirstRig("cf-legacy-green", {
    identity: {
      repository: AIUBQ,
      id: "issue-ubiquity-ai.ubq.fi-618",
      issue: 618,
    },
    legacyReviewCutoff: CUT,
    reviews: [accepted],
    reviewRounds: 7,
    attempts: 3,
    nextStep: "delivery",
    baseTip: SHA2,
    refreshTo: { [SHA3]: PREP3 },
    checks: {},
  });
  const digest = "c".repeat(64);
  rig.github.proveCarriedPatch = (request) =>
    Promise.resolve(portOk({
      reviewedMergeBase: request.reviewedBase,
      reviewedPatch: digest,
      refreshedMergeBase: request.base,
      refreshedPatch: digest,
      refreshedFrom: request.head === PREP3 ? SHA3 : null,
      refreshes: request.head === PREP3 ? 1 : 0,
    }));
  try {
    let work = taskRecord(await rig.snapshot(), "issue-ubiquity-ai.ubq.fi-618");
    for (let run = 0; run < 6; run++) {
      await rig.run();
      work = taskRecord(await rig.snapshot(), "issue-ubiquity-ai.ubq.fi-618");
      if (work.wait?.reason === "backoff") break;
      rig.clock.advance(5 * 60_000 + 1);
    }
    assert.equal(rig.model.requests.length, 0, "no fix for a green head");
    assert.deepEqual(rig.github.reviewRequestIdentities, [], "no review");
    assert.equal(
      rig.github.calls.filter((call) => call === "merge").length,
      0,
      "the runtime never merges a carried head",
    );
    // The refreshed head waits at `work` for the launcher's carried merge.
    assert.equal(work.nextStep, "work");
    assert.equal(work.target.head, PREP3);
    assert.equal(work.target.base, SHA2);
    assert.equal(work.wait?.reason, "backoff");
    const snapshot = await rig.snapshot();
    assert.equal(work.counters.reviewRounds, 7, "no round spent");
    assert.equal(work.counters.retries, 0);
    assert.equal(
      snapshot.reservations.filter((charge) =>
        charge.taskId === work.id && charge.purpose === "review_request"
      ).length,
      7,
    );
  } finally {
    await rig.ctx.cleanup();
  }
});
