/**
 * Base-refresh credential failures through the REAL GitHub REST client error
 * mapping: only a genuine authentication failure of this job's credential (a
 * 401, or a refused/unavailable credential from the auth provider) is a
 * per-job deferral that persists nothing. Every other `auth_failed` — notably
 * a 403 permission refusal, which the client also classifies `auth_failed` —
 * is a failed execution that counts toward the bounded terminal block, and
 * that block is never re-admitted by the launcher's credential-expiry rule
 * (an uncharged block/re-admit loop otherwise). No network, no credentials.
 */
import assert from "node:assert/strict";

import { planBaseRefreshReadmissions } from "../../ops/hosted-autonomy.ts";
import { asWorkItemId, type GitSha } from "../../src/contracts/brands.ts";
import type {
  GitHubPullRequestV1,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { GitHubAuthProviderV1 } from "../../src/github/auth.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import { createGitHubAuthProvider } from "../../src/host/providers.ts";
import {
  baseRefreshIntentKey,
  candidateBranch,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import { FakeAuthProvider, FakeCooldownGate } from "../github/helpers.ts";
import { REPO, SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";
import {
  assertGen76Parses,
  assertGen76Shape,
  gen76Available,
} from "../state/gen76-contracts.ts";
import { FakeClock, FakeGithub } from "./helpers.ts";
import { makeMemoryRig } from "./loop-rig.ts";
import { CANDIDATE_REF, CHECK_POLL_MS } from "./loop-candidate-fixtures.ts";

const ID = asWorkItemId("issue-1");
const BRANCH = candidateBranch(ID);
const OLD_HEAD = "7f0b28dc5c6f8a1a2b3c4d5e6f7a8b9c0d1e2f3a" as GitSha;
const PRODUCER = "b".repeat(64);

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
      candidateState: {
        preserved: {
          operationKey: implementationIntentKey(PRODUCER),
          base: SHA1,
          head: OLD_HEAD,
          ref: CANDIDATE_REF,
        },
        publishedHead: OLD_HEAD,
      },
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

/** Raw GitHub answer for every request: one fixed status, no rate limit. */
function statusTransport(status: number): HttpTransportV1 {
  return () =>
    Promise.resolve({
      status,
      headers: new Headers({ "x-ratelimit-remaining": "4000" }),
      bodyText: JSON.stringify({ message: "refused" }),
    });
}

/**
 * The own-PR observation goes through the REAL GitHub REST client, so the
 * error kind/detail is the client's own mapping of the raw response.
 */
class RealClientGithub extends FakeGithub {
  constructor(private readonly client: GitHubApiClient) {
    super({ baseSha: SHA2 });
    this.prepareBaseRefresh = () => {
      throw new Error("no preparation against an unobserved own PR");
    };
  }
  override readPullRequest(
    number: number,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>> {
    return this.client.readPullRequest(number);
  }
}

function clientWith(
  http: HttpTransportV1,
  auth: GitHubAuthProviderV1 = new FakeAuthProvider(),
): GitHubApiClient {
  return new GitHubApiClient({
    repository: { ...REPO },
    apiBaseUrl: "https://api.github.com",
    http,
    auth,
    cooldownGate: new FakeCooldownGate(),
    clock: new FakeClock(T0),
  });
}

async function runTimes(
  client: GitHubApiClient,
  runs: number,
): Promise<{
  records: WorkRecordV1[];
  snapshots: RepairStateSnapshotV1[];
  last: RepairStateSnapshotV1;
}> {
  const rig = makeMemoryRig(new RealClientGithub(client));
  await rig.state.writeRepair(snapshotOf([refreshingRecord()]), null);
  const records: WorkRecordV1[] = [];
  const snapshots: RepairStateSnapshotV1[] = [];
  let last = await rig.snapshot();
  for (let run = 0; run < runs; run++) {
    const outcome = await rig.run();
    assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
    last = await rig.snapshot();
    assertGen76Shape(last);
    snapshots.push(last);
    records.push(last.work[0]);
    rig.clock.advance(CHECK_POLL_MS + 1000);
  }
  return { records, snapshots, last };
}

for (
  const [name, client] of [
    ["a 401 (expired job token)", () => clientWith(statusTransport(401))],
    [
      "an auth-provider credential failure",
      () =>
        clientWith(
          statusTransport(200),
          createGitHubAuthProvider(() => {
            throw new Error("token source unavailable");
          }),
        ),
    ],
  ] as const
) {
  Deno.test(
    `base refresh credential: ${name} defers without persisting a failure attempt`,
    async () => {
      const { records } = await runTimes(client(), 4);
      for (const work of records) {
        assert.equal(work.nextStep, "delivery", "never blocked");
        assert.equal(work.blocker, null);
        assert.equal(work.target.pr, 7, "the open PR identity is retained");
        assert.equal(work.intent?.kind, "base_refresh");
        assert.equal(work.intent?.failure, undefined, "nothing counted");
        assert.equal(work.wait, null, "no wait is re-armed");
      }
    },
  );
}

Deno.test(
  "base refresh credential: a 403 permission refusal counts toward the terminal block and is never re-admitted as a credential expiry",
  async () => {
    const { records, snapshots, last } = await runTimes(
      clientWith(statusTransport(403)),
      3,
    );
    // The counted failure (suffixed detail) and the terminal block both
    // parse under the generation-76 rollback runtime.
    if (await gen76Available()) {
      for (const snapshot of snapshots) await assertGen76Parses(snapshot);
    }
    const detail =
      "own pull request could not be observed (permission refused)";
    assert.deepEqual(
      records.slice(0, 2).map((work) => work.intent?.failure?.attempts),
      [1, 2],
      "each refused observation is one counted failure",
    );
    assert.equal(records[0].intent?.failure?.kind, "auth_failed");
    assert.equal(records[0].intent?.failure?.detail, detail);
    assert.notEqual(records[0].wait, null, "bounded wait between attempts");
    const blocked = records[2];
    assert.equal(blocked.nextStep, "blocked");
    assert.equal(
      blocked.blocker?.message,
      `base refresh failed 3 consecutive times: auth_failed ${detail}`,
    );
    assert.equal(blocked.intent, null);
    assert.equal(blocked.target.pr, null);
    // The launcher's credential-expiry rule re-admits only the exact legacy
    // expiry messages; a permission refusal stays a visible terminal block.
    const denials: string[] = [];
    const candidates = planBaseRefreshReadmissions(
      { ...last, sequence: last.sequence + 1 },
      SHA1,
      new Set(),
      (denial) => denials.push(denial.reason),
    );
    assert.deepEqual(candidates, []);
    assert.deepEqual(denials, []);
    // The same record under the exact legacy (generation <= 76) expiry
    // message is the class the launcher does re-admit, so the refusal above
    // is decided by the message alone.
    const legacy = {
      ...last,
      sequence: last.sequence + 1,
      work: [{
        ...blocked,
        blocker: {
          kind: "other" as const,
          message:
            "base refresh failed 3 consecutive times: auth_failed own pull request could not be observed",
          since: blocked.blocker?.since ?? T0,
        },
      }],
    };
    assert.deepEqual(
      planBaseRefreshReadmissions(legacy, SHA1, new Set()).map((candidate) =>
        candidate.id
      ),
      [ID],
    );
  },
);
