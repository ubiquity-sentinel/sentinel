/** Exercise recovered GraphQL batches through the real repair pass (#395). */
import assert from "node:assert/strict";
import { INACTIVE_CI_MINUTES } from "../../src/budget/ci-minutes.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { PASS_SUMMARY_LINE_KIND } from "../../src/repair/pass-summary-line.ts";
import { repositoryConfig } from "../budget/helpers.ts";
import { FakeAuthProvider, FakeCooldownGate } from "../github/helpers.ts";
import { REPO, SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
} from "./helpers.ts";

Deno.test("repair live inputs retry: one gateway fault does not fan out over 60 unchanged records", async () => {
  const clock = new FakeClock(T0);
  const state = new MemoryState();
  state.repair = {
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
    work: Array.from({ length: 60 }, (_, index) => {
      const id = `issue-retry-${index}`;
      const branch = `sentinel/repair/${id}`;
      return workRecord(id, {
        source: { kind: "issue", id: String(100 + index), revision: SHA1 },
        related: { incidentId: null, issueNumber: 100 + index },
        target: {
          base: SHA1,
          branch,
          checkpoint: null,
          head: SHA2,
          pr: 1_000 + index,
        },
        counters: { attempts: 1, retries: 0, reviewRounds: 0 },
        intent: {
          kind: "implementation",
          key: `impl:${index.toString(16).padStart(64, "0")}`,
          startedAt: T0,
          branch,
          expectedHead: null,
          observedBase: SHA1,
          pr: null,
          requestId: index.toString(16).padStart(64, "0"),
          resultId: null,
        },
      });
    }),
  };
  state.repairHead = SHA1;
  let requests = 0;
  let reviewId = 901;
  let failRequest = -1;
  const client = new GitHubApiClient({
    repository: REPO,
    apiBaseUrl: "https://api.github.com",
    auth: new FakeAuthProvider(),
    cooldownGate: new FakeCooldownGate(),
    clock,
    http: (request) => {
      requests++;
      clock.advance(1_000);
      if (requests === failRequest) {
        return Promise.resolve({
          status: 502,
          headers: new Headers(),
          bodyText: "",
        });
      }
      const { query } = JSON.parse(request.body ?? "{}");
      const repository: Record<string, unknown> = {};
      for (
        const [, alias, number] of query.matchAll(
          /(i\d+): issue\(number: (\d+)\)/g,
        )
      ) {
        repository[alias] = { number: Number(number), state: "OPEN" };
      }
      for (
        const [, alias, number] of query.matchAll(
          /(p\d+): pullRequest\(number: (\d+)\)/g,
        )
      ) {
        repository[alias] = {
          number: Number(number),
          state: "OPEN",
          headRefOid: SHA2,
          baseRefOid: SHA1,
          baseRefName: "development",
          commits: {
            nodes: [{
              commit: { oid: SHA2, statusCheckRollup: { state: "SUCCESS" } },
            }],
          },
          reviews: { nodes: [{ fullDatabaseId: String(reviewId) }] },
        };
      }
      for (const [, alias] of query.matchAll(/(b\d+): ref\(/g)) {
        repository[alias] = { target: { oid: SHA1 } };
      }
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        bodyText: JSON.stringify({ data: { repository } }),
      });
    },
  });
  const github = Object.assign(
    new FakeGithub({ baseSha: SHA1, openIssues: [] }),
    {
      readLiveInputs: client.readLiveInputs.bind(client),
    },
  );
  const configs = [repositoryConfig()];
  const deps = {
    ciMinutes: INACTIVE_CI_MINUTES,
    clock,
    state,
    configs,
    controllerSha: SHA1,
    github,
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
    incidents: new FakeIncidents({ summaries: [], evidence: null }),
    replay: new FakeReplay(),
    model: new FakeModel({ head: SHA2, changedPaths: ["src/app.ts"] }),
    budget: new RollingStartBudget({ clock, state, configs }),
    externalImplementations: true,
  };
  const pass = async () => {
    const lines: string[] = [];
    const stepped: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) =>
      lines.push(args.map(String).join(" "));
    try {
      await runRepairCycle(deps, {
        deadline: clock.now() + 90 * 60_000,
        stepLimit: 1_000,
        modelStartsEnabled: true,
        onStep: (id) => stepped.push(id),
      });
    } finally {
      console.log = original;
    }
    const summaries = lines.map((line) => JSON.parse(line)).filter((line) =>
      line.kind === PASS_SUMMARY_LINE_KIND
    );
    assert.equal(summaries.length, 1);
    return { stepped, summary: summaries[0] };
  };

  const first = await pass();
  assert.equal(first.stepped.length, 60);
  assert.equal(first.summary.batchReads, 1);
  assert.equal(requests, 2, "121 items use two exhaustive chunks");
  assert.equal(
    state.repair!.work.filter((record) => record.stepInputs !== undefined)
      .length,
    60,
  );

  clock.advance(5 * 60_000);
  failRequest = requests + 2; // The last chunk fails; the first must not be replayed.
  const head = state.repairHead;
  const start = clock.now();
  const unchanged = await pass();
  assert.deepEqual(unchanged.stepped, []);
  assert.equal(unchanged.summary.recordsRead, 60);
  assert.equal(unchanged.summary.recordsSkipped, 60);
  assert.deepEqual(unchanged.summary.skipReasons, {
    unchanged_inputs: 60,
    waiting: 0,
  });
  assert.equal(unchanged.summary.batchReads, 1);
  assert.equal(unchanged.summary.batchUnavailable, 0);
  assert.equal(
    requests,
    5,
    "only one extra GraphQL request, not fleet-wide REST fallback",
  );
  assert.equal(
    clock.now() - start,
    3_000,
    "three injected network round trips",
  );
  assert.equal(state.repairHead, head, "unchanged inputs cost no write");
  assert.equal(
    github.calls.filter((call) =>
      /^(readIssue|readPullRequest|readChecks|readRef):/.test(call)
    ).length,
    0,
  );

  // Recovery must not hide a subsequent real input change or charge a model.
  reviewId++;
  clock.advance(5 * 60_000);
  const changed = await pass();
  assert.equal(changed.stepped.length, 60);
  assert.equal(changed.summary.recordsSkipped, 0);
  assert.equal(requests, 7);
  assert.deepEqual(state.repair!.reservations, []);
});
