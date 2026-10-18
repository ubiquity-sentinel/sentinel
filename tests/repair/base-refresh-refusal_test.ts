/**
 * JAM B11 (sentinel issue 157, PR 160), replayed from the REAL record shapes
 * through the real repair loop with fake ports.
 *
 * R79 (549c7a691) implemented and preserved the candidate 784e233ec for issue
 * 157 at base d5cc84402. It edits ops/hosted-autonomy-follow-ups.ts,
 * ops/hosted-autonomy-follow-up-pass.ts and ops/hosted-autonomy-github-issues.ts,
 * which R80 (e48e7e110) added to the owner-protected paths. When the base moved
 * to 614a4fa02, R80 regenerated the deterministic refresh merge 18cceb957 and
 * the trusted publication validator refused it — "a protected entry does not
 * match the trusted base tree", a deterministic `invalid` verdict on an
 * immutable merge. R80 counted that verdict as a transient failure, re-ran the
 * same doomed refresh twice more (70 minutes), dropped the reason and blocked
 * with markTerminalBlocked, which detached the still-open PR 160.
 *
 * Here the same verdict parks the record once, at the first refusal, as an
 * explicit owner-gated block that names the closed reason and keeps PR 160 as
 * `target.pr`. Nothing is pushed, charged, refunded or reviewed, and every
 * written snapshot parses under R80, whose own selection skips the park.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  DETERMINISTIC_PUBLICATION_DETAILS,
  PUBLICATION_BINARY_DETAIL,
  PUBLICATION_PROTECTED_DETAIL,
} from "../../src/github/snapshot-policy.ts";
import {
  BASE_REFRESH_REFUSED_PREFIX,
  isBaseRefreshRefusedPark,
} from "../../src/repair/loop-base-refresh.ts";
import { exactOpenPr } from "./loop-candidate-fixtures.ts";
import { makeRig, type RigV1, seededSnapshot } from "./loop-rig.ts";
import { r80Available, withR80 } from "./refresh-refusal-r80.ts";

const LIVE = JSON.parse(
  await Deno.readTextFile(
    new URL("../fixtures/host/refresh-refusal-157-live.json", import.meta.url),
  ),
) as {
  refreshing: WorkRecordV1;
  reservations: unknown[];
  observedBase: GitSha;
  preparedHead: GitSha;
};

/** The owner-gated park the runtime writes for a refused refresh. */
const PARK =
  "base refresh refused by trusted validation; owner action required (land the change by hand or close the issue): ";
const R80_GENERATION = 80;

/** The live instant of R80's first refusal (2026-10-17T18:35:57Z). */
const FIRST_REFUSAL_AT = 1792262157846;

interface Live {
  rig: RigV1;
  record: WorkRecordV1;
  written: RepairStateSnapshotV1[];
  prepares: number;
}

async function liveRig(detail: string, name: string): Promise<Live> {
  const record = structuredClone(LIVE.refreshing);
  const branch = record.target.branch!;
  const head = record.target.head!;
  const live: Live = {
    rig: undefined as never,
    record,
    written: [],
    prepares: 0,
  };
  live.rig = await makeRig(name, {
    summaries: false,
    localScope: true,
    github: {
      baseSha: LIVE.observedBase,
      candidateLifecycle: {
        refs: { [`refs/heads/${branch}`]: head },
        pullRequests: [exactOpenPr(160, head, branch, record.target.base)],
        prepareBaseRefresh: (request) => {
          live.prepares++;
          // The exact persisted prepared merge regenerates byte-identically.
          assert.equal(request.pullRequestNumber, 160);
          assert.equal(request.expectedHead, head);
          assert.equal(request.expectedBase, LIVE.observedBase);
          assert.equal(request.preparedHead, LIVE.preparedHead);
          return Promise.resolve(portOk(LIVE.preparedHead));
        },
        preserveCandidate: (request) => {
          assert.equal(request.candidate.head, LIVE.preparedHead);
          assert.equal(request.candidate.base, LIVE.observedBase);
          assert.equal(request.publishedHead, head);
          return Promise.resolve(portError("invalid", detail));
        },
      },
    },
  });
  const original = live.rig.store.writeRepair.bind(live.rig.store);
  live.rig.store.writeRepair = (next, expected) => {
    live.written.push(structuredClone(next));
    return original(next, expected);
  };
  const seeded = await original(
    seededSnapshot([record], {
      reservations: structuredClone(LIVE.reservations) as never,
    }),
    null,
  );
  assert.ok(seeded.ok && seeded.value.status === "applied");
  // The live pass: just past the record's own re-armed wait.
  live.rig.clock.advance(FIRST_REFUSAL_AT - live.rig.clock.now());
  return live;
}

Deno.test("refresh refusal (live 157): the trusted validator's protected-path verdict parks the record once for the owner and keeps PR 160", async () => {
  const live = await liveRig(PUBLICATION_PROTECTED_DETAIL, "refusal-157");
  const { rig, record } = live;
  try {
    const outcome = await rig.run();
    assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
    let state = await rig.snapshot();
    let work = state.work[0]!;
    assert.equal(work.nextStep, "blocked", JSON.stringify(work));
    assert.deepEqual(work.blocker, {
      kind: "other",
      message: `${PARK}candidate touches a protected path`,
      since: FIRST_REFUSAL_AT,
    });
    assert.equal(work.target.pr, 160, "the open PR stays bound to its record");
    assert.equal(work.intent, null, "the refused refresh is closed at once");
    assert.equal(work.wait, null, "no wait is re-armed for a verdict");
    assert.deepEqual(work.target, { ...record.target }, "target untouched");
    assert.deepEqual(work.counters, record.counters);
    assert.deepEqual(state.reservations, LIVE.reservations, "nothing charged");
    assert.deepEqual(rig.github.pushes, [], "nothing is pushed");
    assert.equal(rig.model.requests.length, 0, "no model start");
    assert.equal(rig.github.preservationRequests.length, 1);

    // A later run never rewrites the park and never retries the refresh.
    rig.clock.advance(60 * 60_000);
    const sequence = state.sequence;
    await rig.run();
    state = await rig.snapshot();
    work = state.work[0]!;
    assert.equal(state.sequence, sequence, "no further write");
    assert.equal(rig.github.preservationRequests.length, 1);
    assert.equal(live.prepares, 1);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("refresh refusal: the park text is the exported owner-gated prefix, distinct from every refresh failure class", () => {
  assert.equal(BASE_REFRESH_REFUSED_PREFIX, PARK);
  assert.ok(
    isBaseRefreshRefusedPark(`${PARK}candidate touches a protected path`),
  );
  assert.ok(!isBaseRefreshRefusedPark(PARK), "a reason is required");
  for (
    const message of [
      "base refresh failed 3 consecutive times: invalid candidate could not be preserved",
      "base refresh has conflicts",
      "candidate touches a protected path",
    ]
  ) {
    assert.ok(!isBaseRefreshRefusedPark(message), message);
  }
  assert.ok(!/^base refresh failed [1-9][0-9]* consecutive times: /.test(PARK));
  assert.ok(!/^base refresh has conflicts( at [0-9a-f]{40})?$/.test(PARK));
});

Deno.test("refresh refusal: every other deterministic verdict parks with its own closed detail", async () => {
  const live = await liveRig(PUBLICATION_BINARY_DETAIL, "refusal-binary");
  try {
    await live.rig.run();
    const work = (await live.rig.snapshot()).work[0]!;
    assert.equal(work.blocker?.message, `${PARK}${PUBLICATION_BINARY_DETAIL}`);
    assert.equal(work.target.pr, 160);
    assert.ok(
      DETERMINISTIC_PUBLICATION_DETAILS.includes(PUBLICATION_BINARY_DETAIL),
    );
  } finally {
    await live.rig.ctx.cleanup();
  }
});

Deno.test("refresh refusal: an invalid answer outside the closed verdict set stays a bounded failure", async () => {
  // A malformed request (STATIC_PRESERVE_INPUT) is not a verdict on the
  // candidate: the bounded failure record keeps counting it.
  const live = await liveRig(
    "candidate preservation request is invalid",
    "refusal-input",
  );
  try {
    await live.rig.run();
    const work = (await live.rig.snapshot()).work[0]!;
    assert.equal(work.nextStep, "work");
    assert.equal(work.intent?.kind, "base_refresh");
    assert.equal(work.intent?.failure?.kind, "invalid");
    assert.equal(work.intent?.failure?.attempts, 1);
    assert.equal(work.target.pr, 160);
  } finally {
    await live.rig.ctx.cleanup();
  }
});

Deno.test({
  name:
    "rollback: R80 parses every snapshot the refusal park writes and its own selection skips the park",
  ignore: !(await r80Available()),
  fn: async () => {
    const live = await liveRig(PUBLICATION_PROTECTED_DETAIL, "refusal-r80");
    try {
      await live.rig.run();
      assert.ok(live.written.length >= 1);
      const last = live.written.at(-1)!;
      assert.equal(last.work[0]!.target.pr, 160);
      assert.ok(last.work[0]!.blocker?.message.startsWith(PARK));
      await withR80((r80) => {
        for (const snapshot of live.written) r80.parse(snapshot);
        assert.equal(
          r80.skipReason(last, live.record.id, FIRST_REFUSAL_AT),
          "blocked",
          `R80 (generation ${R80_GENERATION}) never acts on the park`,
        );
      });
    } finally {
      await live.rig.ctx.cleanup();
    }
  },
});
