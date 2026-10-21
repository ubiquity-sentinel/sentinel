/** Real process custody: losing the repair publisher must settle its reviewer. */
import assert from "node:assert/strict";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import {
  ReviewOwnerCustodyBroker,
  runRepairOwnerWithReviewCustody,
} from "../../src/host/review-owner-custody.ts";
import { reviewOwnerRegistration } from "../../src/github/review-owner-evidence.ts";
import { renderReviewJournalBody } from "../../src/github/review-journal.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { GitHubCodexReviewTransport } from "../../src/github/codex-review-transport.ts";
import { parseReviewJournalBody } from "../../src/github/review-journal.ts";
import type {
  HostedReviewOwnerSettlementV1,
  ReviewOwnerSettlementResolverV1,
} from "../../src/github/review-owner-evidence.ts";
import {
  DurableReviewStore,
  makeClient,
  makeReviewer,
  RecordingSession,
  withRealGitRange,
} from "../github/codex-review-transport-helpers.ts";
import type { StoredReviewV1 } from "../github/codex-review-transport-helpers.ts";
import { FakeClock, REPO, REVIEWER } from "../github/helpers.ts";
import {
  attemptBody,
  intent,
  iso,
  jobBody,
  jobsBody,
  logText,
  makeRig,
  runtimeStep,
  scriptAttemptAndJobs,
  scriptLog,
} from "../github/hosted-execution-helpers.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const TRANSPORT =
  new URL("../../src/repair/codex-transport.ts", import.meta.url).href;

function alive(pid: number): boolean {
  try {
    Deno.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function interruptedReviewer(
  runOwner?: (
    input: { root: string; server: string; driver: string; pidFile: string },
  ) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({
    dir: ROOT,
    prefix: "sentinel-review-custody-",
  });
  const pidFile = root + "/reviewer.pid";
  const server = root + "/fake-reviewer.ts";
  const driver = root + "/repair.ts";
  let pid: number | null = null;
  try {
    await Deno.writeTextFile(
      server,
      `
await Deno.writeTextFile(Deno.args[0], String(Deno.pid));
setInterval(() => {}, 1000);
let text = "";
for await (const part of Deno.stdin.readable) {
  text += new TextDecoder().decode(part);
  let end;
  while ((end = text.indexOf("\\n")) >= 0) {
    const frame = JSON.parse(text.slice(0, end)); text = text.slice(end + 1);
    if (frame.id !== undefined) {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { userAgent: "fake-reviewer" } }));
    }
  }
}
// The publisher disappearing must not be assumed to kill a detached session.
await new Promise(() => {});
`,
    );
    await Deno.writeTextFile(
      driver,
      `
import { CodexSubprocessSession } from ${JSON.stringify(TRANSPORT)};
const session = new CodexSubprocessSession({
  command: [Deno.execPath(), "run", "--allow-read", "--allow-write", ${
        JSON.stringify(server)
      }, ${JSON.stringify(pidFile)}],
  cwd: ${JSON.stringify(root)}, env: {}, operationDeadlineMs: 60000,
});
session.open();
await session.send("initialize", {});
console.log("reviewer opened");
await new Promise(() => {});
`,
    );
    if (runOwner === undefined) {
      const result = await new DenoReplayRuntime(Deno.execPath()).run({
        executable: Deno.execPath(),
        args: ["run", "--allow-read", "--allow-write", "--allow-run", driver],
        cwd: root,
        env: {},
        maxDurationMs: 1000,
        maxOutputBytes: 8192,
      });
      assert.equal(
        result.settled,
        true,
        "the actual outer owner group settled",
      );
      assert.match(new TextDecoder().decode(result.stdout), /reviewer opened/);
    } else {
      await runOwner({ root, server, driver, pidFile });
    }
    pid = Number(await Deno.readTextFile(pidFile));
    assert.equal(
      alive(pid),
      false,
      "the separate reviewer group must be proved closed after repair death",
    );
  } finally {
    if (pid === null) {
      try {
        pid = Number(await Deno.readTextFile(pidFile));
      } catch { /* No session spawned. */ }
    }
    if (pid !== null && Number.isSafeInteger(pid) && pid > 1 && alive(pid)) {
      // This is the exact fake reviewer spawned by this test, never a guessed process.
      try {
        Deno.kill(-pid, "SIGKILL");
      } catch {
        Deno.kill(pid, "SIGKILL");
      }
    }
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("review custody: interrupted repair owner settles its separately spawned reviewer", async () => {
  await interruptedReviewer(async ({ root, server, driver, pidFile }) => {
    const execution = {
      id: "7:2:repair",
      runId: 7,
      runAttempt: 2,
      launcherSha: "a".repeat(40) as GitSha,
      revision: "b".repeat(40) as GitSha,
      generation: 74,
      purpose: "ordinary" as const,
      releaseId: null,
      createdAt: Date.now() - 1000,
    };
    const repository = {
      owner: "ubiquity",
      name: "sentinel",
      installationId: 0,
    };
    const journal = {
      version: "v1" as const,
      phase: "intent" as const,
      repository: { owner: repository.owner, name: repository.name },
      prNumber: 1,
      expectedHead: "c".repeat(40) as GitSha,
      expectedBase: "d".repeat(40) as GitSha,
      operationKey: "review:task:round1",
      publisher: "ubiquity-sentinel[bot]",
      requestId: "review-review:task:round1",
      requestedAt: Date.now(),
      ownerExecution: execution,
    };
    const registration = await reviewOwnerRegistration(
      repository,
      100,
      journal,
      renderReviewJournalBody(journal),
    );
    const broker = new ReviewOwnerCustodyBroker(execution, [{
      repository,
      provider: "uos",
      model: "codex-auto-review",
      permissionProfile: "sentinel-review",
      session: {
        command: [
          Deno.execPath(),
          "run",
          "--allow-read",
          "--allow-write",
          server,
          pidFile,
        ],
        cwd: root,
        env: {},
        operationDeadlineMs: 60_000,
      },
    }]);
    const descriptor = await broker.start(root);
    const channel =
      new URL("../../src/host/review-owner-channel.ts", import.meta.url).href;
    await Deno.writeTextFile(
      driver,
      `
import { ReviewOwnerChannelClient } from ${JSON.stringify(channel)};
const client = new ReviewOwnerChannelClient(${JSON.stringify(descriptor)});
await client.register(${JSON.stringify(registration)});
const session = client.openSession({ cwd: ${JSON.stringify(root)}, requestId: ${
        JSON.stringify(journal.requestId)
      }, invocationId: "review-invocation-review:task:round1", ownerRunId: ${
        JSON.stringify(execution.id)
      }, nativeReviewTargetDigest: "d".repeat(64) });
session.open(); await session.send("initialize", {}); console.log("reviewer opened");
await new Promise(() => {});
`,
    );
    try {
      const result = await runRepairOwnerWithReviewCustody(
        broker,
        new DenoReplayRuntime(Deno.execPath()),
        {
          executable: Deno.execPath(),
          args: ["run", "--allow-read", "--allow-write", driver],
          cwd: root,
          env: {},
          maxDurationMs: 1000,
          maxOutputBytes: 8192,
        },
      );
      assert.equal(result.run.settled, true);
      assert.match(
        new TextDecoder().decode(result.run.stdout),
        /reviewer opened/,
      );
      assert.equal(result.settlements.length, 1);
      assert.equal(result.settlements[0]!.carrier.processSettled, true);
      assert.equal(
        result.settlements[0]!.carrier.journal.requestId,
        journal.requestId,
      );
    } finally {
      await broker.dispose();
    }
  });
});

Deno.test("review custody: real interrupted owner and native carrier unblock a fresh host without adopting the old process", async (test) => {
  await withRealGitRange(async ({ base, head, snapshot }) => {
    let record: HostedReviewOwnerSettlementV1 | null = null;
    let stored: Array<Record<string, unknown>> = [];
    await interruptedReviewer(async ({ root, server, driver, pidFile }) => {
      const execution = intent({ createdAt: Date.now() - 1000 });
      const captured = await snapshot.capture({ base, head });
      assert.equal(captured.ok, true);
      if (!captured.ok) assert.fail("real Git snapshot unavailable");
      await Deno.writeTextFile(
        server,
        `
await Deno.writeTextFile(Deno.args[0], String(Deno.pid));
setInterval(() => {}, 1000);
let text = "";
for await (const part of Deno.stdin.readable) {
  text += new TextDecoder().decode(part);
  let end;
  while ((end = text.indexOf("\\n")) >= 0) {
    const frame = JSON.parse(text.slice(0, end)); text = text.slice(end + 1);
    if (frame.id === undefined) continue;
    const p = frame.params ?? {};
    const result = frame.method === "thread/start" ? { thread: { id: "real-fake-review-thread" }, model: "codex-resolved", modelProvider: "uos", reasoningEffort: null, activePermissionProfile: { id: p.permissions } } : frame.method === "review/start" ? { turn: { id: "real-fake-review-turn", status: "inProgress" }, reviewThreadId: "real-fake-review-thread" } : { userAgent: "fake-reviewer" };
    console.log(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
  }
}
await new Promise(() => {});
`,
      );
      const broker = new ReviewOwnerCustodyBroker(execution, [{
        repository: REPO,
        provider: "uos",
        model: "codex-auto-review",
        permissionProfile: "sentinel-review",
        session: {
          command: [
            Deno.execPath(),
            "run",
            "--allow-read",
            "--allow-write",
            server,
            pidFile,
          ],
          cwd: root,
          env: {},
          operationDeadlineMs: 60_000,
        },
      }]);
      const descriptor = await broker.start(root);
      const modules = {
        channel:
          new URL("../../src/host/review-owner-channel.ts", import.meta.url)
            .href,
        transport:
          new URL("../../src/github/codex-review-transport.ts", import.meta.url)
            .href,
        reviewer:
          new URL("../../src/github/codex-reviewer.ts", import.meta.url).href,
        helpers: new URL(
          "../github/codex-review-transport-helpers.ts",
          import.meta.url,
        ).href,
        clock: new URL("../github/helpers.ts", import.meta.url).href,
        ports: new URL("../../src/contracts/ports.ts", import.meta.url).href,
      };
      const storeFile = root + "/journal.json";
      await Deno.writeTextFile(
        driver,
        `
import { ReviewOwnerChannelClient } from ${JSON.stringify(modules.channel)};
import { GitHubCodexReviewTransport, REVIEW_TRANSPORT_TOTAL_MS } from ${
          JSON.stringify(modules.transport)
        };
import { CodexStructuredReviewer } from ${JSON.stringify(modules.reviewer)};
import { DurableReviewStore, makeClient } from ${
          JSON.stringify(modules.helpers)
        };
import { FakeClock } from ${JSON.stringify(modules.clock)};
import { portOk } from ${JSON.stringify(modules.ports)};
const clock = new FakeClock(Date.now()); const store = new DurableReviewStore();
const original = store.handle; store.handle = async request => { const result = await original(request); await Deno.writeTextFile(${
          JSON.stringify(storeFile)
        }, JSON.stringify([...store.reviews.values()])); return result; };
const channel = new ReviewOwnerChannelClient(${JSON.stringify(descriptor)});
const transport = new GitHubCodexReviewTransport({ client: makeClient(store, clock), repository: ${
          JSON.stringify(REPO)
        }, publisher: ${JSON.stringify(REVIEWER)}, clock, ownerRunId: ${
          JSON.stringify(execution.id)
        }, ownerExecution: ${
          JSON.stringify(execution)
        }, ownerCustody: channel, snapshot: { capture: async () => portOk(${
          JSON.stringify(captured.value)
        }) }, reviewer: new CodexStructuredReviewer({ provider: "uos", model: "codex-auto-review", permissionProfile: "sentinel-review", sessionCwd: ${
          JSON.stringify(root)
        }, now: () => clock.now(), openSession: input => channel.openSession(input) }) });
const result = await transport.submitReview({ operationKey: "review:real-owner:1", prNumber: 1, expectedHead: ${
          JSON.stringify(head)
        }, expectedBase: ${JSON.stringify(base)}, expectedReviewer: ${
          JSON.stringify(REVIEWER)
        }, latestStartAt: clock.now()+60000, settleBy: clock.now()+REVIEW_TRANSPORT_TOTAL_MS });
if (!result.ok || result.value.status !== "submitted") throw new Error("real owner submission failed");
console.log("reviewer opened"); await new Promise(() => {});
`,
      );
      try {
        const result = await runRepairOwnerWithReviewCustody(
          broker,
          new DenoReplayRuntime(Deno.execPath()),
          {
            executable: Deno.execPath(),
            args: [
              "run",
              "--allow-read",
              "--allow-write",
              "--allow-env=PATH",
              driver,
            ],
            cwd: root,
            env: {},
            maxDurationMs: 1500,
            maxOutputBytes: 8192,
          },
        );
        assert.match(
          new TextDecoder().decode(result.run.stdout),
          /reviewer opened/,
          new TextDecoder().decode(result.run.stderr),
        );
        assert.equal(result.settlements.length, 1);
        record = result.settlements[0]!;
        stored = JSON.parse(await Deno.readTextFile(storeFile));
        assert.equal(record.carrier.journal.phase, "running");
      } finally {
        await broker.dispose();
      }
    });
    if (record === null) assert.fail("real custody proof missing");
    const actual: HostedReviewOwnerSettlementV1 = record;
    const finish = actual.carrier.settledAt + 1000;
    const observed = finish + 1000;
    const fixture = (
      options: { text?: string; active?: boolean; wrongAttempt?: boolean } = {},
    ) => {
      const rig = makeRig(observed);
      const begun = actual.execution.createdAt;
      scriptAttemptAndJobs(
        rig,
        attemptBody({
          updatedAt: finish,
          attempt: options.wrongAttempt ? 99 : actual.execution.runAttempt,
        }),
        jobsBody([
          jobBody({
            status: options.active ? "in_progress" : "completed",
            startedAt: begun,
            completedAt: finish,
            steps: [
              runtimeStep({
                started_at: iso(begun),
                completed_at: iso(finish),
              }),
            ],
          }),
        ]),
      );
      scriptLog(
        rig,
        options.text ??
          logText(
            [actual as unknown as Record<string, unknown>],
            actual.carrier.settledAt,
          ),
      );
      const store = new DurableReviewStore();
      store.reviews.set(
        100,
        structuredClone(stored[0]) as unknown as StoredReviewV1,
      );
      const clock = new FakeClock(observed + 1);
      const resolver: ReviewOwnerSettlementResolverV1 = {
        read: (input) => rig.client.readReviewOwnerSettlement(input),
      };
      const transport = new GitHubCodexReviewTransport({
        client: makeClient(store, clock),
        repository: REPO,
        publisher: REVIEWER,
        clock,
        ownerRunId: "fresh-host",
        ownerSettlement: resolver,
        snapshot,
        reviewer: {
          prepare: () => {
            throw new Error("fresh recovery must never adopt/open a session");
          },
        },
      });
      return { rig, store, clock, transport };
    };
    await test.step("fresh native consumer finalizes only unavailable and preserves original identities", async () => {
      const h = fixture();
      h.store.lostUpdate = true;
      h.store.lostSubmit = true;
      const before = stored[0]!.body as string;
      const read = await h.transport.readReview({
        operationKey: actual.carrier.journal.operationKey,
        requestId: null,
        prNumber: 1,
      });
      assert.equal(read.ok, true);
      if (!read.ok) assert.fail("fresh observation unavailable");
      assert.equal(read.value.status, "unavailable");
      assert.notEqual(read.value.completedAt, null);
      const ready = await parseReviewJournalBody(
        h.store.reviews.get(100)!.body!,
      );
      assert.equal(ready.phase, "ready");
      assert.equal(ready.requestedAt, actual.carrier.journal.requestedAt);
      assert.equal(ready.requestId, actual.carrier.journal.requestId);
      assert.equal(ready.ownerExecution!.id, actual.execution.id);
      if (ready.phase === "ready") {
        assert.equal(ready.execution, null);
        assert.equal(ready.result.verdict, "unavailable");
        assert.equal(ready.result.taskAcceptance, undefined);
      }
      assert.notEqual(h.store.reviews.get(100)!.body, before);
      assert.equal(h.store.updates, 1);
      assert.equal(h.store.submits, 1);
      const again = await h.transport.readReview({
        operationKey: ready.operationKey,
        requestId: null,
        prNumber: 1,
      });
      assert.equal(again.ok, true);
      assert.equal(h.store.updates, 1);
      assert.equal(h.store.submits, 1);
      const session = new RecordingSession();
      const next = new GitHubCodexReviewTransport({
        client: makeClient(h.store, h.clock),
        repository: REPO,
        publisher: REVIEWER,
        clock: h.clock,
        ownerRunId: "next-host",
        snapshot,
        reviewer: makeReviewer(session, h.clock),
      });
      const admitted = await next.submitReview({
        operationKey: "review:real-owner:2",
        prNumber: 1,
        expectedHead: head,
        expectedBase: base,
        expectedReviewer: REVIEWER,
        latestStartAt: h.clock.now() + 60000,
        settleBy: h.clock.now() + 20 * 60000,
      });
      assert.equal(admitted.ok, true);
      if (admitted.ok) assert.equal(admitted.value.status, "submitted");
      await next.drain({
        deadline: h.clock.now() + 20 * 60000,
        interrupt: false,
      });
      assert.equal(session.turnStarts(), 1);
      assert.equal(h.store.creates, 1);
    });
    for (
      const [name, options] of [
        ["absent owner close carrier", {
          text: "job completed without review close proof",
        }],
        ["active owner", { active: true }],
        ["foreign native attempt", { wrongAttempt: true }],
        ["duplicate carrier", {
          text: logText([
            actual as unknown as Record<string, unknown>,
            actual as unknown as Record<string, unknown>,
          ], actual.carrier.settledAt),
        }],
        ["unproved close marker", {
          text: logText([{
            ...actual,
            carrier: { ...actual.carrier, processSettled: false },
          }], actual.carrier.settledAt),
        }],
        ["changed body custody", {
          text: logText([{
            ...actual,
            carrier: { ...actual.carrier, bodyDigest: "e".repeat(64) },
          }], actual.carrier.settledAt),
        }],
        ["foreign target scope", {
          text: logText([{
            ...actual,
            carrier: {
              ...actual.carrier,
              repository: { ...actual.carrier.repository, installationId: 999 },
            },
          }], actual.carrier.settledAt),
        }],
        ["changed native owner revision", {
          text: logText([{
            ...actual,
            execution: { ...actual.execution, revision: "f".repeat(40) },
          }], actual.carrier.settledAt),
        }],
      ] as const
    ) {
      await test.step(name, async () => {
        const h = fixture(options);
        const before = h.store.reviews.get(100)!.body;
        const read = await h.transport.readReview({
          operationKey: actual.carrier.journal.operationKey,
          requestId: null,
          prNumber: 1,
        });
        assert.equal(read.ok, true);
        if (read.ok) assert.equal(read.value.completedAt, null);
        assert.equal(h.store.updates, 0);
        assert.equal(h.store.submits, 0);
        assert.equal(h.store.reviews.get(100)!.body, before);
      });
    }
    await test.step("opaque legacy binding remains untouched and charged", async () => {
      const h = fixture();
      const review = h.store.reviews.get(100)!;
      const journal = await parseReviewJournalBody(review.body!);
      assert.equal(journal.phase, "running");
      if (journal.phase !== "running") assert.fail("expected running");
      const { ownerExecution: _nativeBinding, ...legacy } = journal;
      review.body = renderReviewJournalBody({
        ...legacy,
        execution: {
          ...legacy.execution,
          ownerRunId: "opaque-legacy-invocation",
        },
      });
      const before = review.body;
      const read = await h.transport.readReview({
        operationKey: legacy.operationKey,
        requestId: null,
        prNumber: 1,
      });
      assert.equal(read.ok, true);
      if (read.ok) assert.equal(read.value.completedAt, null);
      assert.equal(h.store.updates, 0);
      assert.equal(h.store.submits, 0);
      assert.equal(review.body, before);
      assert.equal(
        h.rig.http.calls.length,
        0,
        "old owner id is never parsed as a native run",
      );
    });
  });
});

Deno.test("review custody: escaped publisher pipe makes settlement unproved and emits no carrier", async () => {
  await interruptedReviewer(async ({ root, server, driver, pidFile }) => {
    const execution = intent({ createdAt: Date.now() - 1000 });
    const journal = {
      version: "v1" as const,
      phase: "intent" as const,
      repository: { owner: REPO.owner, name: REPO.name },
      prNumber: 1,
      expectedHead: "c".repeat(40) as GitSha,
      expectedBase: "d".repeat(40) as GitSha,
      operationKey: "review:escaped-owner:1",
      publisher: REVIEWER,
      requestId: "review-review:escaped-owner:1",
      requestedAt: Date.now(),
      ownerExecution: execution,
    };
    const registration = await reviewOwnerRegistration(
      REPO,
      100,
      journal,
      renderReviewJournalBody(journal),
    );
    const broker = new ReviewOwnerCustodyBroker(execution, [{
      repository: REPO,
      provider: "uos",
      model: "codex-auto-review",
      permissionProfile: "sentinel-review",
      session: {
        command: [
          Deno.execPath(),
          "run",
          "--allow-read",
          "--allow-write",
          server,
          pidFile,
        ],
        cwd: root,
        env: {},
        operationDeadlineMs: 60_000,
      },
    }]);
    const descriptor = await broker.start(root);
    const channel =
      new URL("../../src/host/review-owner-channel.ts", import.meta.url).href;
    const escapedFile = root + "/escaped.ts";
    const escapedPidFile = root + "/escaped.pid";
    await Deno.writeTextFile(escapedFile, "setInterval(() => {}, 1000);\n");
    await Deno.writeTextFile(
      driver,
      `
import { ReviewOwnerChannelClient } from ${JSON.stringify(channel)};
const client = new ReviewOwnerChannelClient(${JSON.stringify(descriptor)});
await client.register(${JSON.stringify(registration)});
const session = client.openSession({ cwd: ${JSON.stringify(root)}, requestId: ${
        JSON.stringify(journal.requestId)
      }, invocationId: "review-invocation-review:escaped-owner:1", ownerRunId: ${
        JSON.stringify(execution.id)
      }, nativeReviewTargetDigest: "d".repeat(64) });
session.open(); await session.send("initialize", {});
const escaped = new Deno.Command(Deno.execPath(), { args: ["run", ${
        JSON.stringify(escapedFile)
      }], clearEnv: true, env: {}, stdin: "null", stdout: "inherit", stderr: "inherit", detached: true }).spawn();
await Deno.writeTextFile(${
        JSON.stringify(escapedPidFile)
      }, String(escaped.pid));
console.log("reviewer opened"); await new Promise(() => {});
`,
    );
    let escapedPid: number | null = null;
    try {
      const result = await runRepairOwnerWithReviewCustody(
        broker,
        new DenoReplayRuntime(Deno.execPath()),
        {
          executable: Deno.execPath(),
          args: ["run", "--allow-read", "--allow-write", "--allow-run", driver],
          cwd: root,
          env: {},
          maxDurationMs: 1500,
          maxOutputBytes: 8192,
        },
      );
      escapedPid = Number(await Deno.readTextFile(escapedPidFile));
      assert.equal(
        alive(escapedPid),
        true,
        "the task-owned escaped writer is real, not adopted by the broker",
      );
      assert.equal(result.run.settled, false);
      assert.equal(
        result.settlements.length,
        0,
        "an escaped publisher cannot borrow reviewer close as finalization proof",
      );
    } finally {
      if (escapedPid === null) {
        try {
          escapedPid = Number(await Deno.readTextFile(escapedPidFile));
        } catch { /* No escaped child. */ }
      }
      if (escapedPid !== null && alive(escapedPid)) {
        Deno.kill(-escapedPid, "SIGKILL");
      }
      await broker.dispose();
    }
  });
});
