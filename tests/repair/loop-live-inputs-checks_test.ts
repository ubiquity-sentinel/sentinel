/** Advisory fallback reads must not collect authoritative CI evidence (#416). */
import assert from "node:assert/strict";
import { INACTIVE_CI_MINUTES } from "../../src/budget/ci-minutes.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { PASS_SUMMARY_LINE_KIND } from "../../src/repair/pass-summary-line.ts";
import { repositoryConfig } from "../budget/helpers.ts";
import {
  checkRunWire,
  checksPageWire,
  FakeAuthProvider,
  FakeCooldownGate,
} from "../github/helpers.ts";
import { REPO, SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
} from "./helpers.ts";

/** Each fake API wave takes three seconds; no real timers or network. */
function network(clock: FakeClock) {
  const pending: (() => void)[] = [];
  let active = 0;
  let peak = 0;
  const read = async <T>(operation: () => Promise<T> | T): Promise<T> => {
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise<void>((resolve) => {
        if (pending.length === 0) {
          queueMicrotask(async () => {
            // Let ready port/HTTP continuations settle before advancing time;
            // additional promise wrappers are not extra network round trips.
            for (let i = 0; i < 100; i++) await Promise.resolve();
            clock.advance(3_000);
            for (const resume of pending.splice(0)) resume();
          });
        }
        pending.push(resolve);
      });
      return await operation();
    } finally {
      active--;
    }
  };
  return { read, stats: () => ({ active, peak }) };
}

function makeRig() {
  const clock = new FakeClock(T0);
  const net = network(clock);
  const state = new MemoryState();
  const work = Array.from({ length: 60 }, (_, index) => {
    const id = `issue-live-checks-${index}`;
    const branch = `sentinel/repair/${id}`;
    return workRecord(id, {
      source: { kind: "issue", id: String(100 + index), revision: SHA1 },
      related: { incidentId: null, issueNumber: 100 + index },
      target: {
        base: SHA1,
        branch,
        checkpoint: null,
        head: (index + 1).toString(16).padStart(40, "a") as GitSha,
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
  });
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
    work,
  };
  state.repairHead = SHA1;
  let jobReads = 0;
  let greenHead: GitSha | null = null;
  let unavailableHead: GitSha | null = null;
  const client = new GitHubApiClient({
    repository: REPO,
    apiBaseUrl: "https://api.github.com",
    auth: new FakeAuthProvider(),
    cooldownGate: new FakeCooldownGate(),
    clock,
    http: (request) =>
      net.read(() => {
        const path = new URL(request.url).pathname;
        const commit = path.match(
          /\/commits\/([a-f0-9]{40})\/(check-runs|statuses)$/,
        );
        let body: unknown;
        if (commit !== null) {
          const [, head, collection] = commit;
          if (head === unavailableHead) {
            return { status: 503, headers: new Headers(), bodyText: "" };
          }
          const index = work.findIndex((record) => record.target.head === head);
          assert.ok(index >= 0, "only the observed PR head may be read");
          body = collection === "statuses" ? [] : checksPageWire(
            Array.from({ length: 8 }, (_, job) =>
              checkRunWire({
                id: (index + 1) * 100 + job,
                name: `ci-${job}`,
                head_sha: head,
                conclusion: head === greenHead ? "success" : "failure",
                app: { slug: "github-actions" },
              })),
          );
        } else {
          const job = path.match(/\/actions\/jobs\/(\d+)$/);
          assert.ok(job !== null, `unexpected request: ${path}`);
          jobReads++;
          const id = Number(job[1]);
          body = {
            id,
            head_sha: work[Math.floor(id / 100) - 1].target.head,
            status: "completed",
            conclusion: "failure",
            steps: [],
            runner_id: 0,
          };
        }
        return {
          status: 200,
          headers: new Headers(),
          bodyText: JSON.stringify(body),
        };
      }),
  });
  const github = Object.assign(
    new FakeGithub({
      baseSha: SHA1,
      openIssues: [],
      pullRequest: { head: SHA2 },
    }),
    {
      readLiveInputs: () =>
        Promise.resolve(portError("unavailable", "batch unavailable")),
      readChecks: client.readChecks.bind(client),
    },
  );
  const readIssue = github.readIssue.bind(github);
  const readPull = github.readPullRequest.bind(github);
  const readRef = github.readRef.bind(github);
  github.readIssue = (number) => net.read(() => readIssue(number));
  github.readPullRequest = (number) =>
    net.read(async () => {
      const read = await readPull(number);
      return read.ok && read.value !== null
        ? portOk({
          ...read.value,
          number,
          head: work[number - 1_000].target.head!,
        })
        : read;
    });
  github.readRef = (ref) => net.read(() => readRef(ref));
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
  return {
    clock,
    state,
    work,
    client,
    net,
    pass,
    jobReads: () => jobReads,
    green: (head: GitSha) => greenHead = head,
    unavailable: (head: GitSha) => unavailableHead = head,
  };
}

Deno.test("repair fallback checks: 60 unchanged records do not collect CI job evidence", async () => {
  const rig = makeRig();
  const first = await rig.pass();
  assert.equal(first.stepped.length, 60);
  assert.equal(first.summary.recordsRead, 60);
  assert.equal(first.summary.batchUnavailable, 1);

  rig.clock.advance(5 * 60_000);
  const head = rig.state.repairHead;
  const start = rig.clock.now();
  const unchanged = await rig.pass();
  const elapsed = rig.clock.now() - start;
  assert.deepEqual(unchanged.stepped, []);
  assert.equal(unchanged.summary.recordsRead, 60);
  assert.equal(unchanged.summary.recordsSkipped, 60);
  assert.equal(rig.state.repairHead, head, "unchanged inputs cost no write");
  assert.ok(elapsed <= 140_000, `advisory fallback took ${elapsed} ms`);
  assert.equal(rig.jobReads(), 0, "fingerprints need no Actions job evidence");
  assert.deepEqual(rig.net.stats(), { active: 0, peak: 8 });

  // A native conclusion change still wakes exactly its record.
  rig.green(rig.work[0].target.head!);
  rig.clock.advance(5 * 60_000);
  const changed = await rig.pass();
  assert.deepEqual(changed.stepped, [rig.work[0].id]);
  assert.equal(changed.summary.recordsSkipped, 59);

  // Unreadable checks remain unavailable, never an unchanged empty result.
  rig.unavailable(rig.work[0].target.head!);
  rig.clock.advance(5 * 60_000);
  const failed = await rig.pass();
  assert.deepEqual(failed.stepped, [rig.work[0].id]);
  assert.equal(failed.summary.recordsRead, 59);
  assert.equal(failed.summary.recordsSkipped, 59);
  assert.deepEqual(rig.state.repair!.reservations, [], "no model charges");
  assert.equal(rig.jobReads(), 0);

  // Authoritative CI reads still prove never-started jobs as before.
  const authoritative = await rig.client.readChecks(rig.work[1].target.head!);
  assert.ok(authoritative.ok);
  assert.equal(rig.jobReads(), 8);
  assert.equal(authoritative.value.checks.length, 8);
  assert.ok(
    authoritative.value.checks.every((check) =>
      check.conclusion === "failure" && check.neverStarted === true
    ),
  );
});
