/**
 * Owner throughput t11b: a dead worker-local candidate (no PR, no published
 * head, no pending intent) is released to a fresh implementation start, while a
 * record that still owes a deterministic preservation step is never a model
 * start and the exact-published-head continuation rule stays closed.
 */
import assert from "node:assert/strict";
import type { GitHubCheckV1 } from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { runActionsMatrixHost } from "../../src/host/matrix-actions.ts";
import {
  existingHeadContinuationShape,
  isMatrixImplementationReadyV1,
  isModelStartAction,
  ownsPublishedArtifact,
  unpublishedLocalCandidateShape,
} from "../../src/repair/loop-eligibility.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { MemoryState } from "../repair/helpers.ts";
import { T0, workRecord } from "../state/helpers.ts";
import { repairConfigs } from "../repair/helpers.ts";
import { issue, rig } from "./matrix-actions-fixtures.ts";

const REPOSITORY = {
  owner: "ubiquity-sentinel",
  name: "sentinel",
  installationId: 0,
};

/** A distinct 40-hex SHA per role/number. */
function shaOf(tag: string, seed: number): GitSha {
  return (tag + String(seed)).padEnd(40, "0").slice(0, 40) as GitSha;
}

function greenCheck(head: GitSha): GitHubCheckV1 {
  return {
    name: "ci",
    status: "completed",
    conclusion: "success",
    head,
    startedAt: 1,
    completedAt: 2,
  };
}

async function seed(
  memory: MemoryState,
  records: ReturnType<typeof workRecord>[],
  now: number,
): Promise<void> {
  const written = await memory.writeRepair(
    parseRepairStateSnapshotV1({
      version: "v1",
      kind: "repair_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: now,
      incidents: [],
      evidence: [],
      work: records,
      reservations: [],
      reviews: [],
      replays: [],
      releaseRequests: [],
      githubCooldowns: [],
      attemptMemory: [],
      lessons: [],
    }),
    null,
  );
  assert.ok(written.ok && written.value.status === "applied");
}

function record(
  repositorySha: GitSha,
  issueNumber: number,
  target: {
    head: GitSha;
    pr: number | null;
    publishedHead: GitSha | null;
    wait?: { reason: "backoff"; since: number; until: number | null };
  },
) {
  const id = `issue-ubiquity-sentinel-${issueNumber}`;
  return workRecord(id, {
    repository: REPOSITORY,
    id,
    source: { kind: "issue", id: String(issueNumber), revision: repositorySha },
    related: { incidentId: null, issueNumber },
    controller: { sha: repositorySha },
    failingRevision: null,
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
    ...(target.wait === undefined ? {} : { wait: target.wait }),
    target: {
      base: repositorySha,
      branch: candidateBranch(asWorkItemId(id)),
      checkpoint: null,
      head: target.head,
      pr: target.pr,
      candidateState: {
        preserved: null,
        publishedHead: target.publishedHead,
      },
    },
  });
}

/** The planner cannot infer: any model call is a defect in these cases. */
const noModel = {
  modelId: "gpt-reserve",
  runModel: () => Promise.reject(new Error("planner cannot infer")),
};

Deno.test(
  "matrix planner: a dead worker-local candidate (no PR, no published head) plans a fresh implementation start",
  async () => {
    const r = await rig();
    try {
      const memory = new MemoryState();
      const release = await r.store.readRelease();
      assert.ok(release.ok && release.value.status === "found");
      memory.setRelease(release.value.snapshot);
      // The worker died after noting a local candidate that was never pushed:
      // no PR, publishedHead null, preserved null and no live branch.
      const deadHead = shaOf("d", 3);
      const seeded = record(r.sha, 3, {
        head: deadHead,
        pr: null,
        publishedHead: null,
      });
      await seed(memory, [seeded], r.clock.now());
      const source = r.github.get("ubiquity-sentinel/sentinel")!;
      source.listOpenIssues = () => Promise.resolve(portOk([]));
      source.readIssue = () => Promise.resolve(portOk(issue(3)));
      source.readChecks = (head) =>
        Promise.resolve(portOk({ head, checks: [greenCheck(head)] }));
      r.github.get("ubiquity/ai.ubq.fi")!.listOpenIssues = () =>
        Promise.resolve(portOk([]));
      const planned = await runActionsMatrixHost({
        ...await r.job("dead-candidate", "matrix_plan"),
        state: memory,
        model: noModel,
      });
      assert.ok("plan" in planned);
      assert.equal(
        planned.prepared,
        1,
        "a candidate with no publishable artifact is released to a fresh start",
      );
      const cell = planned.plan.cells[0]!;
      assert.equal(
        cell.request.checkoutBase,
        undefined,
        "nothing published exists to continue; the start is from the base",
      );
      assert.equal(cell.request.base, r.sha);
      assert.equal(cell.request.mergeBase, undefined);
      assert.equal(cell.expectedBase, r.sha);
      assert.equal(
        cell.request.reviewFindings,
        undefined,
        "a fresh start carries no correction findings",
      );
      const state = memory.repair!;
      assert.equal(state.reservations.length, 1);
      assert.equal(state.reservations[0]!.purpose, "retry");
      const intent = state.work[0]!.intent;
      assert.equal(intent?.kind, "implementation");
      assert.equal(
        intent?.expectedHead,
        null,
        "the fresh start claims no head of its own",
      );
    } finally {
      await r.cleanup();
    }
  },
);

Deno.test(
  "matrix planner: a released dead candidate with a live branch is refused uncharged",
  async () => {
    const r = await rig();
    try {
      const memory = new MemoryState();
      const release = await r.store.readRelease();
      assert.ok(release.ok && release.value.status === "found");
      memory.setRelease(release.value.snapshot);
      // A worker pushed the candidate but died before recording it: the
      // deterministic branch exists while publishedHead is still null.
      const liveHead = shaOf("9", 3);
      const seeded = record(r.sha, 3, {
        head: liveHead,
        pr: null,
        publishedHead: null,
      });
      await seed(memory, [seeded], r.clock.now());
      const source = r.github.get("ubiquity-sentinel/sentinel")!;
      source.listOpenIssues = () => Promise.resolve(portOk([]));
      source.readIssue = () => Promise.resolve(portOk(issue(3)));
      source.candidateRefs.set(
        `refs/heads/${candidateBranch(asWorkItemId(seeded.id))}`,
        liveHead,
      );
      r.github.get("ubiquity/ai.ubq.fi")!.listOpenIssues = () =>
        Promise.resolve(portOk([]));
      const planned = await runActionsMatrixHost({
        ...await r.job("dead-candidate-live", "matrix_plan"),
        state: memory,
        model: noModel,
      });
      assert.ok("plan" in planned);
      assert.equal(planned.prepared, 0);
      assert.equal(planned.plan.cells.length, 0);
      const state = memory.repair!;
      assert.equal(state.reservations.length, 0, "nothing charged");
      assert.equal(state.work[0]!.intent, null, "nothing written");
      assert.equal(state.work[0]!.target.head, liveHead);
    } finally {
      await r.cleanup();
    }
  },
);

/** A parsed snapshot holding exactly `records`, for eligibility unit checks. */
function snapshotOf(records: ReturnType<typeof workRecord>[]) {
  const parsed = parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: records,
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
  return parsed;
}

Deno.test(
  "eligibility: a record still owing its deterministic candidate_preservation is not a model start",
  () => {
    const deadHead = shaOf("e", 4);
    const dead = record(shaOf("f", 4), 4, {
      head: deadHead,
      pr: null,
      publishedHead: null,
    });
    assert.equal(
      unpublishedLocalCandidateShape(dead),
      true,
      "the released shape itself",
    );
    // The ordinary post-receipt state: a candidate was noted and the pending
    // candidate_preservation intent still has to run. That next action is
    // deterministic, so it is never reported as a model start.
    const preserving = workRecord(dead.id, {
      ...dead,
      intent: {
        kind: "candidate_preservation",
        key: "impl:" + "ab".repeat(32),
        startedAt: T0,
        branch: "refs/heads/sentinel-candidates/" + "cd".repeat(32),
        expectedHead: deadHead,
        observedBase: dead.target.base,
        pr: null,
        requestId: "ab".repeat(32),
        resultId: null,
      },
    });
    assert.equal(preserving.target.head, deadHead);
    assert.equal(preserving.target.pr, null);
    assert.equal(preserving.target.candidateState?.preserved, null);
    assert.equal(preserving.target.candidateState?.publishedHead, null);
    assert.equal(
      unpublishedLocalCandidateShape(preserving),
      false,
      "a pending intent of any kind is never the released shape",
    );
    assert.equal(
      isModelStartAction(snapshotOf([preserving]), preserving),
      false,
      "the deterministic preservation step must not be deferred as a model start",
    );
    assert.equal(
      isModelStartAction(snapshotOf([dead]), dead),
      true,
      "the released dead candidate is a model start",
    );
  },
);

Deno.test(
  "eligibility: an open PR whose target head is an unpushed candidate is not a continuation",
  () => {
    const candidateHead = shaOf("a", 5);
    const publishedHead = shaOf("b", 5);
    assert.notEqual(candidateHead, publishedHead);
    const seeded = record(shaOf("c", 5), 5, {
      head: candidateHead,
      pr: 905,
      publishedHead,
    });
    assert.equal(
      existingHeadContinuationShape(seeded),
      false,
      "the continuation still requires publishedHead === target.head",
    );
    assert.equal(ownsPublishedArtifact(seeded), true);
    assert.equal(
      unpublishedLocalCandidateShape(seeded),
      false,
      "an owned artifact is never released as a dead local candidate",
    );
    const snapshot = snapshotOf([seeded]);
    assert.equal(isModelStartAction(snapshot, seeded), false);
    assert.equal(
      isMatrixImplementationReadyV1(
        seeded,
        snapshot,
        repairConfigs({
          // The gateway config needs a real App installation id; eligibility
          // reads only `sessionBound` from it.
          repository: { ...REPOSITORY, installationId: 155687488 },
          sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
        })[0],
        T0,
      ),
      false,
      "the row stays refused, so no cell can bind a non-target checkoutBase",
    );
  },
);
