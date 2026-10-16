/**
 * Base-refresh terminal outcomes through the REAL repair loop with fake ports:
 * a per-job credential expiry (`auth_failed`) is a bounded deferral that never
 * persists a failure attempt, and a known conflict records the exact
 * conflicting base in the existing blocker message and stays a terminal block
 * (a published head without a preservation descriptor is never a model
 * start). Every snapshot these paths write is parsed by the generation-76
 * rollback parsers. No network, no model call, no credentials.
 */
import assert from "node:assert/strict";

import { asWorkItemId, type GitSha } from "../../src/contracts/brands.ts";
import {
  BASE_REFRESH_CONFLICT_DETAIL,
  type GitHubPullRequestV1,
  portError,
  portOk,
  type PortResultV1,
} from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  baseRefreshIntentKey,
  candidateBranch,
} from "../../src/repair/keys.ts";
import {
  isMatrixImplementationReadyV1,
  isModelStartAction,
} from "../../src/repair/loop-eligibility.ts";
import { REPO, SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";
import {
  assertGen76Parses,
  assertGen76Shape,
  gen76Available,
} from "../state/gen76-contracts.ts";
import {
  FakeGithub,
  type FakeGithubOptionsV1,
  repairConfigs,
} from "./helpers.ts";
import { makeMemoryRig } from "./loop-rig.ts";
import { CHECK_POLL_MS, exactOpenPr } from "./loop-candidate-fixtures.ts";

const ID = asWorkItemId("issue-1");
const BRANCH = candidateBranch(ID);
const OLD_HEAD = "7f0b28dc5c6f8a1a2b3c4d5e6f7a8b9c0d1e2f3a" as GitSha;
const PREPARED = "abcdefabcdefabcdefabcdefabcdefabcdefabcd" as GitSha;

/** Every snapshot a rig writes, captured for the rollback parse proof. */
function captureWrites(state: {
  writeRepair(
    next: RepairStateSnapshotV1,
    expected: GitSha | null,
  ): Promise<unknown>;
}): RepairStateSnapshotV1[] {
  const written: RepairStateSnapshotV1[] = [];
  const original = state.writeRepair.bind(state);
  state.writeRepair = (next, expected) => {
    written.push(structuredClone(next));
    return original(next, expected);
  };
  return written;
}

function snapshotOf(work: WorkRecordV1[]): RepairStateSnapshotV1 {
  return {
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work,
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  };
}

/** Delivery record carrying the exact unprepared base-refresh intent. */
function refreshingRecord(): WorkRecordV1 {
  return workRecord("issue-1", {
    repository: REPO,
    source: { kind: "issue", id: "1", revision: SHA1 },
    related: { incidentId: null, issueNumber: 1 },
    target: {
      base: SHA1,
      branch: BRANCH,
      checkpoint: null,
      head: OLD_HEAD,
      pr: 7,
    },
    nextStep: "delivery",
    counters: { attempts: 2, retries: 1, reviewRounds: 1 },
    intent: {
      kind: "base_refresh",
      key: baseRefreshIntentKey(7, OLD_HEAD, SHA2),
      startedAt: T0,
      branch: BRANCH,
      expectedHead: OLD_HEAD,
      observedBase: SHA2,
      pr: 7,
      requestId: null,
      resultId: null,
    },
    firstSeenAt: T0 - 5000,
    createdAt: T0 - 4000,
    updatedAt: T0,
  });
}

/**
 * Port whose installation token expired mid-job: the own-PR observation (or
 * the candidate push) answers with the typed `auth_failed` kind.
 */
class ExpiredTokenGithub extends FakeGithub {
  prAuthFails = true;
  pushAuthFails = false;
  branchHead: GitSha = OLD_HEAD;
  readonly pushCalls: { sha: GitSha; expected: GitSha | null }[] = [];
  constructor(options: FakeGithubOptionsV1 = {}) {
    super({ baseSha: SHA2, ...options });
  }
  override readPullRequest(
    number: number,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>> {
    this.calls.push(`readPr:${number}`);
    if (this.prAuthFails) {
      return Promise.resolve(
        portError("auth_failed", "GitHub API authentication failed"),
      );
    }
    return Promise.resolve(portOk(exactOpenPr(7, this.branchHead, BRANCH)));
  }
  override readRef(ref: string) {
    if (ref === `refs/heads/${BRANCH}`) {
      this.calls.push(`readRef:${ref}`);
      return Promise.resolve(portOk({ ref, sha: this.branchHead }));
    }
    return super.readRef(ref);
  }
  override pushHead(
    ref: string,
    sha: GitSha,
    expected: GitSha | null,
  ): Promise<PortResultV1<"applied" | "ambiguous">> {
    this.pushCalls.push({ sha, expected });
    if (this.pushAuthFails) {
      return Promise.resolve(
        portError("auth_failed", "GitHub API authentication failed"),
      );
    }
    if (expected !== this.branchHead) {
      return Promise.resolve(portError("conflict", "ref moved"));
    }
    this.calls.push(`push:${ref}:${sha.slice(0, 8)}`);
    this.branchHead = sha;
    return Promise.resolve(portOk("applied"));
  }
}

Deno.test(
  "base refresh: an expired job credential defers without persisting a failure attempt",
  async () => {
    const github = new ExpiredTokenGithub();
    github.prepareBaseRefresh = () => {
      throw new Error("no preparation against an unobserved own PR");
    };
    const rig = makeMemoryRig(github);
    const written = captureWrites(rig.state);
    await rig.state.writeRepair(snapshotOf([refreshingRecord()]), null);

    // Three consecutive credential failures used to exhaust the bounded
    // failure record and block the record terminally (clearing target.pr).
    for (let run = 0; run < 3; run++) {
      const outcome = await rig.run();
      assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
      const work = (await rig.snapshot()).work[0];
      assert.equal(work.nextStep, "delivery", `run ${run}: never blocked`);
      assert.equal(work.blocker, null);
      assert.equal(work.target.pr, 7, "the open PR identity is retained");
      assert.equal(work.intent?.kind, "base_refresh");
      assert.equal(
        work.intent?.failure,
        undefined,
        "no failure attempt is persisted for a per-job credential",
      );
      assert.equal(work.wait, null, "no wait is re-armed");
      rig.clock.advance(CHECK_POLL_MS + 1000);
    }

    // A fresh job token resumes the SAME intent: the refresh completes.
    github.prAuthFails = false;
    github.prepareBaseRefresh = () => Promise.resolve(portOk(PREPARED));
    await rig.run();
    const done = (await rig.snapshot()).work[0];
    assert.equal(done.target.base, SHA2, "the refreshed base is the target");
    assert.equal(done.target.head, PREPARED);
    assert.deepEqual(github.pushCalls.at(0), {
      sha: PREPARED,
      expected: OLD_HEAD,
    });
    for (const snapshot of written) assertGen76Shape(snapshot);
  },
);

Deno.test(
  "base refresh: an expired credential at the push keeps the prepared intent with no failure attempt",
  async () => {
    const github = new ExpiredTokenGithub();
    github.prAuthFails = false;
    github.pushAuthFails = true;
    let prepares = 0;
    github.prepareBaseRefresh = () => {
      prepares++;
      return Promise.resolve(portOk(PREPARED));
    };
    const rig = makeMemoryRig(github);
    await rig.state.writeRepair(snapshotOf([refreshingRecord()]), null);

    await rig.run();
    const work = (await rig.snapshot()).work[0];
    assert.equal(work.nextStep, "delivery");
    assert.equal(work.intent?.kind, "base_refresh");
    assert.equal(work.intent?.resultId, PREPARED, "the prepared SHA is kept");
    assert.equal(work.intent?.failure, undefined);
    assert.equal(work.wait, null);
    assert.equal(work.target.head, OLD_HEAD, "the old candidate stays");
    assert.ok(prepares >= 1);
  },
);

Deno.test(
  "base refresh: a known conflict records the exact conflicting base in the blocker",
  async () => {
    const github = new ExpiredTokenGithub();
    github.prAuthFails = false;
    github.prepareBaseRefresh = () =>
      Promise.resolve(portError("conflict", BASE_REFRESH_CONFLICT_DETAIL));
    const rig = makeMemoryRig(github);
    const written = captureWrites(rig.state);
    await rig.state.writeRepair(snapshotOf([refreshingRecord()]), null);

    await rig.run();
    const work = (await rig.snapshot()).work[0];
    assert.equal(work.nextStep, "blocked");
    assert.equal(work.blocker?.kind, "other");
    assert.equal(
      work.blocker?.message,
      `base refresh has conflicts at ${SHA2}`,
      "the exact conflicting base is recorded in the existing message",
    );
    assert.equal(work.target.head, OLD_HEAD, "the candidate is retained");
    assert.equal(work.target.base, SHA1);
    assert.equal(work.target.pr, null);
    assert.equal(github.pushCalls.length, 0);
    assert.equal(rig.model.requests.length, 0);
    for (const snapshot of written) assertGen76Shape(snapshot);
  },
);

Deno.test(
  "base refresh: a descriptor-less published head is never a model start and stays parked with no charge",
  async () => {
    // A published head kept with no preservation descriptor and no PR
    // identity at a newer base is no continuation the runtime routes: it is
    // never regenerated, published or charged, and stays parked.
    const parked = workRecord("issue-1", {
      repository: REPO,
      source: { kind: "issue", id: "1", revision: SHA1 },
      related: { incidentId: null, issueNumber: 1 },
      target: {
        base: SHA2,
        branch: BRANCH,
        checkpoint: null,
        head: OLD_HEAD,
        pr: null,
        candidateState: { preserved: null, publishedHead: OLD_HEAD },
      },
      nextStep: "work",
      counters: { attempts: 4, retries: 0, reviewRounds: 1 },
      firstSeenAt: T0 - 5000,
      createdAt: T0 - 4000,
      updatedAt: T0,
    });
    const snapshot = snapshotOf([parked]);
    const config = repairConfigs({
      sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
    })[0];
    assert.ok(!isMatrixImplementationReadyV1(parked, snapshot, config, T0));
    assert.ok(!isModelStartAction(snapshot, parked));
    const github = new ExpiredTokenGithub();
    github.prAuthFails = false;
    const rig = makeMemoryRig(github);
    await rig.state.writeRepair(snapshot, null);
    const outcome = await rig.run();
    assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.equal(rig.model.requests.length, 0, "no model start");
    assert.deepEqual(state.reservations, [], "nothing is charged");
    assert.deepEqual(state.work[0], parked, "record untouched");
    assert.deepEqual(github.pushCalls, []);
  },
);

Deno.test({
  name:
    "rollback: every snapshot the base-refresh conflict and credential paths write parses under the generation-76 runtime",
  ignore: !(await gen76Available()),
  fn: async () => {
    const snapshots: RepairStateSnapshotV1[] = [];
    // Conflict blocker with the recorded base.
    {
      const github = new ExpiredTokenGithub();
      github.prAuthFails = false;
      github.prepareBaseRefresh = () =>
        Promise.resolve(portError("conflict", BASE_REFRESH_CONFLICT_DETAIL));
      const rig = makeMemoryRig(github);
      const written = captureWrites(rig.state);
      await rig.state.writeRepair(snapshotOf([refreshingRecord()]), null);
      await rig.run();
      snapshots.push(...written);
    }
    // Credential deferral followed by the resumed refresh.
    {
      const github = new ExpiredTokenGithub();
      github.prepareBaseRefresh = () => Promise.resolve(portOk(PREPARED));
      const rig = makeMemoryRig(github);
      const written = captureWrites(rig.state);
      await rig.state.writeRepair(snapshotOf([refreshingRecord()]), null);
      await rig.run();
      github.prAuthFails = false;
      rig.clock.advance(CHECK_POLL_MS + 1000);
      await rig.run();
      snapshots.push(...written);
    }
    assert.ok(
      snapshots.some((snapshot) =>
        snapshot.work[0].blocker?.message ===
          `base refresh has conflicts at ${SHA2}`
      ),
      "the conflict block is covered",
    );
    assert.ok(
      snapshots.some((snapshot) => snapshot.work[0].target.head === PREPARED),
      "the resumed refresh is covered",
    );
    for (const snapshot of snapshots) await assertGen76Parses(snapshot);
  },
});
