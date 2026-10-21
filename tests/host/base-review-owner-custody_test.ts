import { canonicalStringifySha256 } from "../../src/contracts/canonical.ts";
/** Real parent-owned handles for issue-only, exact-base satisfaction reviews. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { HostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import {
  parseBaseReviewOwnerRegistration,
} from "../../src/github/base-review-owner.ts";
import type { BaseReviewOwnerRegistrationV1 } from "../../src/github/base-review-owner.ts";
import type { ReviewJournalExecutionV1 } from "../../src/github/journal-metadata.ts";
import { ReviewOwnerChannelClient } from "../../src/host/review-owner-channel.ts";
import {
  ReviewOwnerCustodyBroker,
  runRepairOwnerWithReviewCustody,
} from "../../src/host/review-owner-custody.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const REPOSITORY = {
  owner: "ubiquity-sentinel",
  name: "sentinel",
  installationId: 0,
};
const OWNER: HostedExecutionIntentV1 = {
  id: "7:2:repair",
  runId: 7,
  runAttempt: 2,
  launcherSha: "a".repeat(40) as GitSha,
  revision: "b".repeat(40) as GitSha,
  generation: 80,
  purpose: "ordinary",
  releaseId: null,
  createdAt: 1,
};
const REGISTRATION: BaseReviewOwnerRegistrationV1 = {
  repository: REPOSITORY,
  base: "c".repeat(40) as GitSha,
  taskDigest: "d".repeat(64),
  reservationId: "e".repeat(64),
  requestId: "base-review-" + "e".repeat(64),
  ownerRunId: OWNER.id,
};
const TARGET = { type: "custom", instructions: "Review the exact base task." };
const TARGET_DIGEST = await canonicalStringifySha256(TARGET);
const PREPARED: ReviewJournalExecutionV1 = {
  ownerRunId: OWNER.id,
  invocationId: "base-review-invocation",
  threadId: "base-review-thread",
  submittedProvider: "uos",
  model: null,
  reasoning: null,
  nativeReview: { mode: "review/start", targetDigest: TARGET_DIGEST },
  startMayOccur: true,
};
const THREAD = {
  permissions: "sentinel-review",
};
const TURN = {
  threadId: PREPARED.threadId,
  delivery: "inline",
  target: TARGET,
};

async function fixture() {
  const root = await Deno.makeTempDir({
    dir: ROOT,
    prefix: "base-review-custody-",
  });
  const server = root + "/reviewer.ts";
  const pidFile = root + "/reviewer.pid";
  const methods = root + "/methods.jsonl";
  await Deno.writeTextFile(
    server,
    `await Deno.writeTextFile(Deno.args[0], String(Deno.pid));
setInterval(() => {}, 1000);
let text = "";
for await (const part of Deno.stdin.readable) {
  text += new TextDecoder().decode(part);
  let end;
  while ((end = text.indexOf("\\n")) >= 0) {
    const frame = JSON.parse(text.slice(0, end)); text = text.slice(end + 1);
    await Deno.writeTextFile(Deno.args[1], JSON.stringify(frame.method) + "\\n", { append: true });
    if (frame.id === undefined) continue;
    const p = frame.params ?? {};
    const result = frame.method === "thread/start"
      ? { thread: { id: "base-review-thread" }, model: "codex-resolved", modelProvider: "uos", reasoningEffort: null, activePermissionProfile: { id: p.permissions } }
      : frame.method === "review/start" ? { turn: { id: "base-review-turn", status: "inProgress" } }
      : { userAgent: "fake-reviewer" };
    console.log(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
  }
}
await new Promise(() => {});
`,
  );
  const broker = new ReviewOwnerCustodyBroker(OWNER, [{
    repository: REPOSITORY,
    provider: PREPARED.submittedProvider,
    model: "ignored-legacy-selector",
    permissionProfile: THREAD.permissions,
    session: {
      command: [
        Deno.execPath(),
        "run",
        "--allow-read",
        "--allow-write",
        server,
        pidFile,
        methods,
      ],
      cwd: root,
      env: {},
      operationDeadlineMs: 10_000,
    },
  }]);
  const descriptor = await broker.start(root);
  const client = new ReviewOwnerChannelClient(descriptor);
  return {
    root,
    broker,
    client,
    descriptor,
    pidFile,
    methods,
    session: () =>
      client.openSession({
        cwd: root,
        requestId: REGISTRATION.requestId,
        invocationId: PREPARED.invocationId,
        ownerRunId: OWNER.id,
        nativeReviewTargetDigest: TARGET_DIGEST,
      }),
    async dispose() {
      await client.close();
      await broker.dispose();
      await Deno.remove(root, { recursive: true });
    },
  };
}

function alive(pid: number): boolean {
  try {
    Deno.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

Deno.test("base review custody: only exact prepared and armed owner starts one native turn", async () => {
  const h = await fixture();
  try {
    await h.client.registerBaseReview(REGISTRATION);
    const session = h.session();
    await session.send("initialize", {});
    await assert.rejects(
      session.send("thread/start", { ...THREAD, cwd: h.root, model: "other" }),
    );
    await session.send("thread/start", { ...THREAD, cwd: h.root });
    await assert.rejects(
      session.send("thread/start", { ...THREAD, cwd: h.root }),
    );
    await assert.rejects(session.send("turn/start", TURN));
    await assert.rejects(session.send("review/start", TURN));
    await assert.rejects(h.client.armBaseReview({
      requestId: REGISTRATION.requestId,
      execution: { ...PREPARED, threadId: "unowned-thread" },
    }));
    await assert.rejects(
      h.client.settledBaseReview({ requestId: REGISTRATION.requestId }),
    );
    await h.client.armBaseReview({
      requestId: REGISTRATION.requestId,
      execution: PREPARED,
    });
    await assert.rejects(
      h.client.armBaseReview({
        requestId: REGISTRATION.requestId,
        execution: PREPARED,
      }),
    );
    await assert.rejects(
      session.send("review/start", { ...TURN, effort: "low" }),
    );
    await session.send("review/start", TURN);
    await assert.rejects(session.send("review/start", TURN));
    await session.close();
    assert.equal(session.isSettled?.(), true);
    await h.client.settledBaseReview({ requestId: REGISTRATION.requestId });
    assert.deepEqual(
      await h.broker.finish({ settled: true, truncated: false }),
      [],
    );
    const methods = (await Deno.readTextFile(h.methods)).trim().split("\n").map(
      (line) => JSON.parse(line),
    );
    assert.equal(methods.filter((name) => name === "thread/start").length, 1);
    assert.equal(methods.filter((name) => name === "review/start").length, 1);
    assert.equal(methods.includes("turn/start"), false);
    assert.equal(alive(Number(await Deno.readTextFile(h.pidFile))), false);
  } finally {
    await h.dispose();
  }
});

Deno.test("base review custody: registration is exact, immutable and cannot reuse PR authority", async () => {
  const h = await fixture();
  try {
    for (
      const changed of [
        { ownerRunId: "8:1:repair" },
        { repository: { ...REPOSITORY, installationId: 1 } },
        { repository: { ...REPOSITORY, name: "other" } },
      ]
    ) {
      await assert.rejects(
        h.client.registerBaseReview({ ...REGISTRATION, ...changed }),
      );
    }
    for (
      const changed of [
        { token: "not-a-real-token" },
        { base: "c".repeat(64) },
        { taskDigest: "d".repeat(40) },
        { requestId: "base-review-" + "f".repeat(64) },
      ]
    ) {
      assert.throws(() =>
        parseBaseReviewOwnerRegistration({ ...REGISTRATION, ...changed })
      );
    }
    await h.client.registerBaseReview(REGISTRATION);
    await h.client.registerBaseReview(REGISTRATION);
    for (
      const changed of [
        { base: "f".repeat(40) as GitSha },
        { taskDigest: "f".repeat(64) },
      ]
    ) {
      await assert.rejects(
        h.client.registerBaseReview({ ...REGISTRATION, ...changed }),
      );
    }
    const registration = {
      repository: REPOSITORY,
      reviewId: 100,
      bodyDigest: "f".repeat(64),
      journal: {
        version: "v1" as const,
        phase: "intent" as const,
        repository: { owner: REPOSITORY.owner, name: REPOSITORY.name },
        prNumber: 1,
        expectedHead: REGISTRATION.base,
        expectedBase: REGISTRATION.base,
        operationKey: "review:task:round1",
        publisher: "ubiquity-sentinel[bot]",
        requestId: REGISTRATION.requestId,
        requestedAt: 2,
        ownerExecution: OWNER,
      },
    };
    await assert.rejects(h.client.register(registration));
    await assert.rejects(h.client.settled(registration));
    const other = "base-review-" + "a".repeat(64);
    await h.client.register({
      ...registration,
      journal: { ...registration.journal, requestId: other },
    });
    await assert.rejects(
      h.client.registerBaseReview({
        ...REGISTRATION,
        reservationId: "a".repeat(64),
        requestId: other,
      }),
    );
    await assert.rejects(
      h.client.armBaseReview({ requestId: other, execution: PREPARED }),
    );
    await assert.rejects(h.client.settledBaseReview({ requestId: other }));
  } finally {
    await h.dispose();
  }
});

Deno.test("base review custody: dead publisher leaves no reviewer handle or new stdout carrier", async () => {
  const h = await fixture();
  const driver = h.root + "/publisher.ts";
  const channel =
    new URL("../../src/host/review-owner-channel.ts", import.meta.url).href;
  try {
    await Deno.writeTextFile(
      driver,
      `import { ReviewOwnerChannelClient } from ${JSON.stringify(channel)};
const client = new ReviewOwnerChannelClient(${JSON.stringify(h.descriptor)});
await client.registerBaseReview(${JSON.stringify(REGISTRATION)});
const session = client.openSession(${
        JSON.stringify({
          cwd: h.root,
          requestId: REGISTRATION.requestId,
          invocationId: PREPARED.invocationId,
          ownerRunId: OWNER.id,
          nativeReviewTargetDigest: TARGET_DIGEST,
        })
      });
await session.send("initialize", {});
await session.send("thread/start", ${
        JSON.stringify({ ...THREAD, cwd: h.root })
      });
await client.armBaseReview(${
        JSON.stringify({
          requestId: REGISTRATION.requestId,
          execution: PREPARED,
        })
      });
await session.send("review/start", ${JSON.stringify(TURN)});
console.log("base reviewer opened");
await new Promise(() => {});
`,
    );
    const result = await runRepairOwnerWithReviewCustody(
      h.broker,
      new DenoReplayRuntime(Deno.execPath()),
      {
        executable: Deno.execPath(),
        args: ["run", "--allow-read", "--allow-write", driver],
        cwd: h.root,
        env: {},
        maxDurationMs: 1000,
        maxOutputBytes: 8192,
      },
    );
    assert.equal(result.run.settled, true);
    assert.match(
      new TextDecoder().decode(result.run.stdout),
      /base reviewer opened/,
    );
    assert.deepEqual(
      result.settlements,
      [],
      "R80 receives no new settlement shape",
    );
    assert.equal(alive(Number(await Deno.readTextFile(h.pidFile))), false);
  } finally {
    await h.dispose();
  }
});
