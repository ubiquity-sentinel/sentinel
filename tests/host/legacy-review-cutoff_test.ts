/**
 * The legacy review class's cutoff is ONE instant (generation 80 round-2
 * recheck P2, `src/repair/review-round-cap.ts:129`): the first CI-first
 * activation bound, pinned once by the commit that pins generation 80's
 * install and handed unchanged to every allowlisted CI-first revision. A
 * later CI-first runtime joins the revision list and reuses that instant, so
 * a record new under generation 80 (its first review admitted after the
 * cutoff) is legacy under no later runtime and can never get a fourth round.
 * A pinned instant later than any recorded execution of ANY allowlisted
 * revision is provably not the first CI-first activation bound and is
 * refused for every revision.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import {
  HOSTED_RUNTIME_ID,
  type HostedRuntimeRecordV1,
} from "../../src/contracts/hosted-supervisor.ts";
import { buildChildEnvironment } from "../../src/host/hosted-runtime-child.ts";
import { HOSTED_RUNTIME_ROLLOUT } from "../../src/host/hosted-runtime-rollout.ts";
import {
  OWNER_DEVELOPMENT_INSTALL_GEN80_REVISION,
  OWNER_DEVELOPMENT_INSTALL_GEN81_REVISION,
} from "../../src/host/owner-install-runtime-pins.ts";
import {
  LEGACY_REVIEW_CUTOFF_ENV,
  legacyReviewCutoffForExecution,
  legacyReviewCutoffForRuntime,
  parseLegacyReviewCutoffEnv,
} from "../../src/host/legacy-review-cutoff-env.ts";
import {
  LEGACY_REVIEW_CUTOFF,
  legacyFinalRoundOpen,
  type LegacyReviewCutoffPinV1,
  legacyReviewRoundPin,
  reviewRoundCeiling,
  reviewRoundsLeft,
} from "../../src/repair/review-round-cap.ts";
import { reservation, T0, workRecord } from "../state/helpers.ts";
import { HOSTED_AUTONOMY_CONFLICT_RESOLUTION_RUNTIMES } from "../../ops/hosted-autonomy-conflict-retries.ts";
import { HOSTED_AUTONOMY_REFRESH_REARM_RUNTIMES } from "../../ops/hosted-autonomy-refresh-rearm.ts";
import { healthyProof, releaseSnapshot } from "./hosted-autonomy-rig.ts";

const HOUR = 60 * 60_000;
const R79 = "549c7a69186b3d2070aa4e69c92ee846d183ce8f" as GitSha;
const R80 = "8080808080808080808080808080808080808080" as GitSha;
const R81 = "8181818181818181818181818181818181818181" as GitSha;
/** Generation 80's install pin, and the instant a later pin would carry. */
const C80 = Date.parse("2026-10-18T00:00:00Z");
const C81 = Date.parse("2026-10-21T00:00:00Z");
const PIN: LegacyReviewCutoffPinV1 = {
  activatedNotBefore: C80,
  revisions: [R80, R81],
};
const GATEWAY = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
} as const;

/** A runtime record of `revision` holding one execution proof at `at`. */
function runtimeAt(
  revision: GitSha,
  generation: number,
  at: number,
  previous?: { revision: GitSha; generation: number; at: number },
): HostedRuntimeRecordV1 {
  const proof = (rev: GitSha, gen: number, created: number) => {
    const built = healthyProof(rev, gen, `release-${gen}`);
    return { ...built, execution: { ...built.execution, createdAt: created } };
  };
  return {
    version: "v1",
    kind: "hosted_runtime",
    id: HOSTED_RUNTIME_ID,
    activeRevision: revision,
    generation,
    lastHealthyProof: proof(revision, generation, at),
    lastExecutionProof: previous === undefined
      ? null
      : proof(previous.revision, previous.generation, previous.at),
    nextOrdinaryAt: at,
    execution: null,
    createdAt: at,
    updatedAt: at,
  } as HostedRuntimeRecordV1;
}

/** Release custody holding exactly `runtime`. */
function custody(runtime: HostedRuntimeRecordV1) {
  const base = releaseSnapshot([], runtime.activeRevision);
  return { ...base, hostedRuntimes: [runtime] };
}

Deno.test("legacy cutoff: the generation 80 install pin sets one instant for every CI-first revision", () => {
  // The launcher commit that pins generation 80's install sets the instant
  // (its own); generation 81 appends R81 without changing that instant.
  const pinned = Date.parse("2026-10-17T17:05:00Z");
  assert.deepEqual(LEGACY_REVIEW_CUTOFF, {
    activatedNotBefore: pinned,
    revisions: [
      ...new Set([
        OWNER_DEVELOPMENT_INSTALL_GEN80_REVISION,
        OWNER_DEVELOPMENT_INSTALL_GEN81_REVISION,
        ...HOSTED_RUNTIME_ROLLOUT.legacyReview,
      ]),
    ],
  });
  // Every R80 activation bound of the launcher is that same instant.
  for (
    const rows of [
      HOSTED_AUTONOMY_REFRESH_REARM_RUNTIMES,
      HOSTED_AUTONOMY_CONFLICT_RESOLUTION_RUNTIMES,
    ]
  ) {
    const row = rows.find((entry) =>
      entry.revision === OWNER_DEVELOPMENT_INSTALL_GEN80_REVISION
    );
    assert.equal(row?.activatedNotBefore, pinned);
  }
  assert.equal(
    legacyReviewCutoffForExecution({
      revision: OWNER_DEVELOPMENT_INSTALL_GEN81_REVISION,
      createdAt: 1792299493000,
    }),
    pinned,
  );
  // The pinned R80 receives it once it runs at or after the instant; an R80
  // execution before it, R79 and any unpinned revision receive none.
  assert.equal(
    legacyReviewCutoffForExecution({
      revision: OWNER_DEVELOPMENT_INSTALL_GEN80_REVISION,
      createdAt: pinned + HOUR,
    }),
    pinned,
  );
  for (
    const execution of [
      {
        revision: OWNER_DEVELOPMENT_INSTALL_GEN80_REVISION,
        createdAt: pinned - 1,
      },
      { revision: R79, createdAt: pinned + HOUR },
      { revision: R80, createdAt: C80 + HOUR },
    ]
  ) assert.equal(legacyReviewCutoffForExecution(execution), null);
  // Pinned: generation 80 and every later CI-first runtime receive the SAME
  // instant, whatever instant a later install commit carries.
  const r80 = runtimeAt(R80, 80, C80 + HOUR);
  const r81 = runtimeAt(R81, 81, C81 + HOUR, {
    revision: R80,
    generation: 80,
    at: C81 - HOUR,
  });
  assert.equal(
    legacyReviewCutoffForExecution(
      { revision: R80, createdAt: C80 + HOUR },
      custody(r80),
      PIN,
    ),
    C80,
  );
  assert.equal(
    legacyReviewCutoffForExecution(
      { revision: R81, createdAt: C81 + HOUR },
      custody(r81),
      PIN,
    ),
    C80,
  );
  assert.equal(legacyReviewCutoffForRuntime(r80, custody(r80), PIN), C80);
  assert.equal(legacyReviewCutoffForRuntime(r81, custody(r81), PIN), C80);
  // The rollback target and any other revision receive none.
  assert.equal(
    legacyReviewCutoffForExecution(
      { revision: R79, createdAt: C81 },
      null,
      PIN,
    ),
    null,
  );
});

Deno.test("legacy cutoff: a pinned instant later than any recorded execution of ANY CI-first revision is refused for every revision", () => {
  // A later install commit that moved the instant to its own (C81) while
  // generation 80 ran before it: custody still holds an R80 execution before
  // C81, so C81 is provably not the first CI-first activation bound.
  const moved: LegacyReviewCutoffPinV1 = {
    activatedNotBefore: C81,
    revisions: [R80, R81],
  };
  const r81 = runtimeAt(R81, 81, C81 + HOUR, {
    revision: R80,
    generation: 80,
    at: C81 - HOUR,
  });
  assert.equal(
    legacyReviewCutoffForExecution(
      { revision: R81, createdAt: C81 + HOUR },
      custody(r81),
      moved,
    ),
    null,
  );
  assert.equal(legacyReviewCutoffForRuntime(r81, custody(r81), moved), null);
  // The current execution itself before the instant refuses too.
  assert.equal(
    legacyReviewCutoffForExecution(
      { revision: R80, createdAt: C80 - 1 },
      null,
      PIN,
    ),
    null,
  );
  // A malformed instant is no cutoff.
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.equal(
      legacyReviewCutoffForExecution(
        { revision: R80, createdAt: C80 },
        null,
        { activatedNotBefore: bad, revisions: [R80] },
      ),
      null,
    );
  }
});

Deno.test("legacy cutoff: a record whose first review admission is after generation 80's cutoff is never legacy under any CI-first runtime", () => {
  const id = "issue-ubiquity-ai.ubq.fi-2000";
  const record = workRecord(id, {
    repository: GATEWAY,
    source: { kind: "issue", id: "2000", revision: R79 },
    related: { incidentId: null, issueNumber: 2000 },
    counters: { attempts: 1, retries: 0, reviewRounds: 3 },
    target: {
      base: R79,
      branch: "sentinel/repair/x",
      checkpoint: null,
      head: R81,
      pr: 3000,
    },
  });
  const charge = (
    purpose: BudgetReservationV1["purpose"],
    at: number,
    attempt: number,
  ) =>
    reservation(`${purpose}-${attempt}`, {
      repository: GATEWAY,
      taskId: id,
      attempt,
      head: R80,
      purpose,
      outcome: "submitted",
      createdAt: at,
      settledAt: at + 1,
    });
  // Three CI-first rounds under generation 80, then a CI fix under 81.
  const reviews = [1, 2, 3].map((n) =>
    charge("review_request", C80 + n * HOUR, n)
  );
  const before = { reservations: reviews };
  const after = {
    reservations: [...reviews, charge("retry", C81 + HOUR, 1)],
  };
  for (const revision of PIN.revisions) {
    const cutoff = legacyReviewCutoffForExecution(
      { revision: revision as GitSha, createdAt: C81 + 2 * HOUR },
      null,
      PIN,
    );
    assert.equal(cutoff, C80, revision);
    assert.equal(legacyReviewRoundPin(before, record, cutoff), null);
    assert.equal(legacyFinalRoundOpen(before, record, cutoff), false);
    assert.equal(reviewRoundsLeft(after, record, cutoff), 0, revision);
    assert.equal(reviewRoundCeiling(after, record, cutoff), 3, revision);
  }
});

Deno.test("legacy cutoff hand-over: the child key carries the launcher's value only, and the runtime parses it strictly", () => {
  const host = {
    PATH: "/usr/bin",
    GITHUB_TOKEN: "native-token",
    UOS_AI_TOKEN: "model-token",
    // A value in the launcher's own environment never crosses.
    [LEGACY_REVIEW_CUTOFF_ENV]: "1",
  };
  const identity = {
    runId: 1,
    runAttempt: 1,
    launcherSha: "a".repeat(40) as GitSha,
    job: "repair" as const,
  };
  const dirs = { home: "/h", tmp: "/t", denoDir: "/d" };
  const none = buildChildEnvironment(host, identity, dirs, T0);
  assert.equal(Object.hasOwn(none, LEGACY_REVIEW_CUTOFF_ENV), false);
  const handed = buildChildEnvironment(host, identity, dirs, T0, T0);
  assert.equal(handed[LEGACY_REVIEW_CUTOFF_ENV], String(T0));
  assert.equal(
    parseLegacyReviewCutoffEnv(handed[LEGACY_REVIEW_CUTOFF_ENV]),
    T0,
  );
  for (
    const value of [
      undefined,
      "",
      "0",
      "-1",
      "01",
      " 1",
      "1e12",
      "1.5",
      "0x10",
      "99999999999999999",
    ]
  ) {
    assert.equal(parseLegacyReviewCutoffEnv(value), null, String(value));
  }
});
