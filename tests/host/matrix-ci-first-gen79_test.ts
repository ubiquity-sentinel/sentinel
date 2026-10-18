/**
 * Matrix rollback safety of the CI-first route. A CI fix runs as a matrix
 * cell, and a cell planned in one run may be consumed by a later run that,
 * after a failed generation, runs the rollback target's own code:
 *
 * - generation 80 (this tree) plans only the legacy fix cell in hosted runs:
 *   a head reviewed clean (or P2-only) against the record's exact base, its
 *   live CI finding first. R79 (549c7a691), the rollback target of
 *   generation 80, authenticates that cell and isolates it as a runtime
 *   mismatch (the charge stays reserved, never refunded);
 * - the pre-review fix cell (no completed review of the head) stays closed in
 *   hosted generation-80 runs because R79 refuses it generically, which would
 *   fail every later repair run. Generation 80's consumer accepts it (CI
 *   finding first, the record's exact base, no completed review of the head,
 *   a charged CI fix in `counters.retries`), so generation 80 is a safe
 *   rollback target for the generation that opens it;
 * - generation 81 opens it in hosted runs (`HOSTED_PRE_REVIEW_CI_FIXES`):
 *   R80 (e48e7e110), its rollback target, isolates every pre-review fix cell
 *   generation 81 plans, a never-reviewed candidate's and a reviewed record's
 *   refreshed head's (reviews of earlier heads only) alike, with the charge
 *   kept reserved, and refuses nothing it already isolated.
 *
 * The R79 and R80 cases are ignored in a checkout without that revision.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { matrixDigestV1 } from "../../src/contracts/matrix.ts";
import { createActionsMatrixArtifactTransport } from "../../src/host/matrix-artifacts.ts";
import { MatrixHistoricalRuntimeMismatch } from "../../src/host/matrix-artifact-port.ts";
import { ciCorrectionFinding } from "../../src/repair/ci-rejection.ts";
import * as ThisFixtures from "./matrix-artifact-fixtures.ts";
import * as ThisHelpers from "../state/helpers.ts";
import { T0 } from "../state/helpers.ts";
import {
  gen79Available,
  gen80Available,
  loadGen79Modules,
  loadGen80Modules,
} from "./gen77-runtime-source.ts";

type Fixtures = typeof ThisFixtures;
type Helpers = typeof ThisHelpers;
type Rig = Awaited<ReturnType<Fixtures["fixture"]>>;
type Finding = { severity: string; path: string | null; message: string };

/** One consumer generation: its transport, mismatch class and fixtures. */
interface ConsumerV1 {
  factory: typeof createActionsMatrixArtifactTransport;
  Mismatch: typeof MatrixHistoricalRuntimeMismatch;
  digest: typeof matrixDigestV1;
  fixtures: Fixtures;
  helpers: Helpers;
  dispose(): Promise<void>;
}

const available = await gen79Available();
const available80 = await gen80Available();

function thisTree(): ConsumerV1 {
  return {
    factory: createActionsMatrixArtifactTransport,
    Mismatch: MatrixHistoricalRuntimeMismatch,
    digest: matrixDigestV1,
    fixtures: ThisFixtures,
    helpers: ThisHelpers,
    dispose: () => Promise.resolve(),
  };
}

function r79(): Promise<ConsumerV1> {
  return consumerOf(loadGen79Modules);
}

function r80(): Promise<ConsumerV1> {
  return consumerOf(loadGen80Modules);
}

async function consumerOf(
  load: typeof loadGen79Modules,
): Promise<ConsumerV1> {
  const loaded = await load([
    "src/host/matrix-artifacts.ts",
    "src/host/matrix-artifact-port.ts",
    "src/contracts/matrix.ts",
    "tests/host/matrix-artifact-fixtures.ts",
    "tests/state/helpers.ts",
  ]);
  const [artifacts, port, matrix, fixtures, helpers] = loaded.modules;
  return {
    factory: artifacts
      .createActionsMatrixArtifactTransport as ConsumerV1["factory"],
    Mismatch: port.MatrixHistoricalRuntimeMismatch as ConsumerV1["Mismatch"],
    digest: matrix.matrixDigestV1 as ConsumerV1["digest"],
    fixtures: fixtures as unknown as Fixtures,
    helpers: helpers as unknown as Helpers,
    dispose: loaded.dispose,
  };
}

/** Re-bind the fixture wave to one CI fix request of head SHA2 on PR 12. */
async function bindFix(
  c: ConsumerV1,
  rig: Rig,
  findings: Finding[],
  counters: { reviewRounds: number; retries: number },
) {
  const { bytes, ISO, zip } = c.fixtures;
  const work = rig.repair.work[0];
  work.target.head = c.helpers.SHA2;
  work.target.pr = 12;
  work.createdAt = T0 - 10_000;
  work.counters = {
    ...work.counters,
    attempts: Math.max(work.counters.attempts, counters.retries),
    reviewRounds: counters.reviewRounds,
    retries: counters.retries,
  };
  rig.cell.request.checkoutBase = c.helpers.SHA2;
  rig.cell.request.reviewFindings = findings;
  rig.cell.requestDigest = await c.digest(rig.cell.request);
  rig.result.requestDigest = rig.cell.requestDigest;
  rig.result.bundle!.head = c.helpers.SHA3;
  rig.result.receipt!.candidate!.head = c.helpers.SHA3;
  rig.plannerMarker.planDigest = await c.digest(rig.plan);
  rig.logs.set(401, ISO + " " + JSON.stringify(rig.plannerMarker) + "\n");
  rig.cellMarker.resultDigest = await c.digest(rig.result);
  rig.logs.set(402, ISO + " " + JSON.stringify(rig.cellMarker) + "\n");
  await rig.setArchive(
    501,
    rig.planName,
    await zip([{ name: "plan.json", content: bytes(rig.plan) }]),
  );
  await rig.setArchive(
    502,
    rig.cellName,
    await zip([
      { name: "result.json", content: bytes(rig.result) },
      { name: rig.result.bundle!.file, content: rig.bundle },
    ]),
  );
}

/** A completed review on PR 12 against `base` with `severities`. */
function review(
  c: ConsumerV1,
  base: GitSha,
  severities: string[],
  head: GitSha = c.helpers.SHA2,
) {
  return c.helpers.reviewReceipt(
    `review-${severities.join("")}${base}${head}`,
    {
      pullRequest: { number: 12, head, base },
      outcome: "completed",
      observedReviewer: "chatgpt-codex-connector[bot]",
      resultId: `result-${severities.join("")}`,
      findings: severities.map((severity, index) => ({
        id: `finding-${index}`,
        severity,
        path: `src/x${index}.ts`,
        message: `finding ${index}`,
        fingerprint: "e".repeat(64),
        resolved: false,
        resolutionEvidence: null,
      })),
      unresolvedSeverities: severities,
      submittedAt: T0 - 2_000,
      completedAt: T0 - 1_000,
      observedAt: T0 - 500,
    },
  );
}

/** A later consumer run (another runtime) over the producer's wave. */
async function consume(c: ConsumerV1, rig: Rig): Promise<unknown> {
  const transport = c.factory({
    state: rig.state,
    token: "fake-local-token",
    http: rig.http,
    clock: { now: () => T0 + 10_000 },
    artifactRoot: `${rig.tmp}/recovered`,
  });
  const cwd = Deno.cwd();
  Deno.chdir(`${rig.tmp}/checkout`);
  try {
    return await transport.recover({
      ...rig.input,
      currentRun: undefined,
      runtimeSha: c.helpers.SHA3,
      consumerRun: { ...c.fixtures.RUN, runId: 99, runAttempt: 1 },
    });
  } catch (error) {
    return error;
  } finally {
    Deno.chdir(cwd);
  }
}

type Verdict = "mismatch" | "generic";
interface CaseV1 {
  name: string;
  reviews: (c: ConsumerV1) => unknown[];
  reviewRounds: number;
  retries: number;
}

const PRE_REVIEW: CaseV1 = {
  name: "pre-review fix: no review of the head, one CI fix charged",
  reviews: () => [],
  reviewRounds: 0,
  retries: 1,
};
/** The head reviewed clean before the base moved (the refresh's parent). */
const EARLIER_HEAD = "9".repeat(40) as GitSha;
const REFRESHED: CaseV1 = {
  name:
    "pre-review fix of a reviewed record's refreshed head: an earlier head reviewed clean, none of this one",
  reviews: (c) => [review(c, c.helpers.SHA1, [], EARLIER_HEAD)],
  reviewRounds: 1,
  retries: 1,
};
const LEGACY_CLEAN: CaseV1 = {
  name: "legacy fix: clean review on the exact base at round 4 (595)",
  reviews: (c) => [review(c, c.helpers.SHA1, [])],
  reviewRounds: 4,
  retries: 1,
};
const LEGACY_P2: CaseV1 = {
  name: "legacy fix: P2-only review on the exact base at round 4 (668/680)",
  reviews: (c) => [review(c, c.helpers.SHA1, ["P2"])],
  reviewRounds: 4,
  retries: 1,
};
const UNCHARGED: CaseV1 = {
  name: "pre-review fix without a charged CI fix",
  reviews: () => [],
  reviewRounds: 0,
  retries: 0,
};
const OTHER_BASE: CaseV1 = {
  name: "fix of a head reviewed clean against another base",
  reviews: (c) => [review(c, c.helpers.SHA3, [])],
  reviewRounds: 3,
  retries: 1,
};

async function verdicts(
  c: ConsumerV1,
  t: Deno.TestContext,
  cases: [CaseV1, Verdict][],
) {
  const finding = ciCorrectionFinding(c.helpers.SHA1, [{
    name: "validate",
    status: "completed",
    conclusion: "failure",
    head: c.helpers.SHA2,
    startedAt: T0,
    completedAt: T0 + 1,
  }]);
  for (const [item, expected] of cases) {
    await t.step(`${item.name} -> ${expected}`, async () => {
      const rig = await c.fixtures.fixture();
      try {
        rig.repair.reviews.push(...item.reviews(c) as never[]);
        await bindFix(c, rig, [finding], {
          reviewRounds: item.reviewRounds,
          retries: item.retries,
        });
        const outcome = await consume(c, rig);
        if (expected === "mismatch") {
          assert.ok(outcome instanceof c.Mismatch, String(outcome));
          const affected = outcome.evidence.affected;
          assert.equal(affected.length, 1);
          assert.equal(
            affected[0].reservation.outcome,
            "reserved",
            "the charge stays reserved: never refunded",
          );
        } else {
          assert.ok(outcome instanceof Error, String(outcome));
          assert.ok(!(outcome instanceof c.Mismatch), String(outcome));
          assert.match(
            String(outcome),
            /provenance unavailable or conflicting/,
          );
        }
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
}

Deno.test({
  name:
    "rollback to generation 79: R79 isolates the legacy CI fix cell and refuses the pre-review cell",
  ignore: !available,
  async fn(t) {
    const c = await r79();
    try {
      await verdicts(c, t, [
        [LEGACY_CLEAN, "mismatch"],
        [LEGACY_P2, "mismatch"],
        // Why the hosted pre-review route stays closed in generation 80.
        [PRE_REVIEW, "generic"],
      ]);
    } finally {
      await c.dispose();
    }
  },
});

Deno.test({
  name:
    "rollback to generation 80: R80 isolates every pre-review CI fix cell generation 81 plans",
  ignore: !available80,
  async fn(t) {
    const c = await r80();
    try {
      await verdicts(c, t, [
        // Why the hosted pre-review route opens in generation 81.
        [PRE_REVIEW, "mismatch"],
        [REFRESHED, "mismatch"],
        [LEGACY_CLEAN, "mismatch"],
        [LEGACY_P2, "mismatch"],
        // Shapes no planner grants keep the generic refusal.
        [UNCHARGED, "generic"],
        [OTHER_BASE, "generic"],
      ]);
    } finally {
      await c.dispose();
    }
  },
});

Deno.test("this tree's consumer isolates the pre-review CI fix cell it plans in hosted runs", async (t) => {
  await verdicts(thisTree(), t, [
    [PRE_REVIEW, "mismatch"],
    [REFRESHED, "mismatch"],
    [LEGACY_CLEAN, "mismatch"],
    [LEGACY_P2, "mismatch"],
    // Shapes no planner grants keep the generic refusal.
    [UNCHARGED, "generic"],
    [OTHER_BASE, "generic"],
  ]);
});
