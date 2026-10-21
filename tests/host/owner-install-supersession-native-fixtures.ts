/** Actual production reviewer composition; only app-server and HTTP are synthetic. */
import assert from "node:assert/strict";
import { composeLocalGitHub } from "../../src/host/local-github.ts";
import { LocalSessionTracker } from "../../src/host/local-client.ts";
import { ReviewOwnerChannelClient } from "../../src/host/review-owner-channel.ts";
import { ReviewOwnerCustodyBroker } from "../../src/host/review-owner-custody.ts";
import { GATEWAY_PROVIDER } from "../../src/host/model-route.ts";
import type { HostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import type { OwnerSuccessorReviewPorts } from "../../src/host/owner-successor-acceptance.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { checkRunWire, issueWire } from "../github/helpers.ts";
import {
  clock,
  type SupersessionRig,
  task,
} from "./owner-install-supersession-fixtures.ts";
import type { OwnerSuccessorCustodyRegistration } from "../../src/host/owner-successor-acceptance-custody.ts";

export async function nativeOwnerReviewPorts(
  rig: SupersessionRig,
  nativeOwner: HostedExecutionIntentV1,
  reviewFailure = false,
) {
  const suffix = nativeOwner.runId,
    server = `${rig.source.root}/owner-app-server-${suffix}.ts`,
    methods = `${rig.source.root}/owner-methods-${suffix}.jsonl`,
    pidFile = `${rig.source.root}/owner-pid-${suffix}`;
  const checkout = `${rig.source.root}/owner-review-checkout`;
  const result = {
    verdict: "clean",
    summary: "Exact installed successor was assessed against task170.",
    findings: [],
    taskAcceptance: {
      issueNumber: task.issueNumber,
      taskDigest: task.digest,
      verdict: reviewFailure ? "not_fulfilled" : "fulfilled",
      evidence: [
        reviewFailure
          ? "The installed code still misses the requested behavior."
          : "The installed code implements the unchanged issue.",
      ],
    },
  };
  await Deno.writeTextFile(
    server,
    `await Deno.writeTextFile(Deno.args[1], String(Deno.pid));
const result = ${JSON.stringify(result)};
let text = "";
for await (const part of Deno.stdin.readable) {
  text += new TextDecoder().decode(part);
  let end;
  while ((end = text.indexOf("\\n")) >= 0) {
    const frame = JSON.parse(text.slice(0, end)); text = text.slice(end + 1);
    const p = frame.params ?? {};
    await Deno.writeTextFile(Deno.args[0], JSON.stringify({ method: frame.method, schema: p.outputSchema ?? null, target: p.target ?? null, overrides: Object.keys(p).filter(key => ["model", "modelProvider", "effort", "outputSchema"].includes(key)) }) + "\\n", { append: true });
    if (frame.id === undefined) continue;
    const answer = frame.method === "thread/start" ? { thread: { id: "owner-thread" }, model: "codex-selected-default", modelProvider: "uos", reasoningEffort: null, activePermissionProfile: { id: p.permissions } }
      : frame.method === "review/start" ? { turn: { id: "owner-turn", status: "inProgress" }, reviewThreadId: "owner-thread" } : { userAgent: "synthetic-external-app-server" };
    console.log(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: answer }));
    if (frame.method === "review/start") {
      const scope = { threadId: "owner-thread", turnId: "owner-turn" };
      const entry = { ...scope, item: { type: "enteredReviewMode", id: "owner-entry", review: "custom review" } };
      for (const method of ["item/started", "item/completed"]) console.log(JSON.stringify({ jsonrpc: "2.0", method, params: entry }));
      const marker = '<SENTINEL_NATIVE_REVIEW_V1>{"binding":';
      const binding = JSON.parse(p.target.instructions.split(marker)[1].split(',"result":<RESULT>}')[0]);
      const review = '<SENTINEL_NATIVE_REVIEW_V1>' + JSON.stringify({ binding, result }) + '</SENTINEL_NATIVE_REVIEW_V1>';
      const exit = { ...scope, item: { type: "exitedReviewMode", id: "owner-result", review } };
      for (const method of ["item/started", "item/completed"]) console.log(JSON.stringify({ jsonrpc: "2.0", method, params: exit }));
      console.log(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "owner-thread", turn: { id: "owner-turn", status: "completed", durationMs: 1234 } } }));
    }
  }
}
`,
  );
  const repository = { owner: "ubiquity", name: "sentinel", installationId: 0 };
  const broker = new ReviewOwnerCustodyBroker(nativeOwner, [{
    repository,
    provider: GATEWAY_PROVIDER,
    model: "codex-auto-review",
    permissionProfile: "sentinel-review",
    session: {
      command: [
        Deno.execPath(),
        "run",
        "--allow-read",
        "--allow-write",
        server,
        methods,
        pidFile,
      ],
      cwd: checkout,
      env: {},
      operationDeadlineMs: 30_000,
    },
  }]);
  const client = new ReviewOwnerChannelClient(
    await broker.start(rig.source.root),
  );
  const tracker = new LocalSessionTracker();
  let ports: OwnerSuccessorReviewPorts | undefined;
  composeLocalGitHub({
    clock,
    state: rig.repair,
    gate: new DurableGitHubCooldownGate({ state: rig.repair, clock }),
    token: "offline-native-app-token",
    login: "ubiquity-sentinel[bot]",
    invocationId: nativeOwner.id,
    ownerExecution: nativeOwner,
    ownerCustody: client,
    ownerSettlement: {
      read: () =>
        Promise.reject(
          new Error("no PR journal may be read by owner successor"),
        ),
    },
    stateRoot: rig.source.root,
    sourcePath: rig.source.runtime,
    scratch: `${rig.source.root}/owner-scratch`,
    reviewCheckout: checkout,
    reviewClientHome: `${rig.source.root}/owner-client`,
    reviewTmpDir: `${rig.source.root}/owner-tmp`,
    reviewDenoDir: `${rig.source.root}/owner-deno`,
    trustedPath: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    codexExecutable: "/usr/bin/false",
    tracker,
    reviewModelId: "codex-auto-review",
    repository,
    onOwnerSuccessorReviewPorts: (value) => {
      ports = value;
    },
    http: (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/graphql") {
        assert.equal(request.method, "POST");
        assert.ok(
          JSON.parse(request.body!).query.trimStart().startsWith("query"),
        );
      } else assert.equal(request.method, "GET");
      const body = path === "/graphql"
        ? {
          data: {
            repository: {
              issue: {
                number: 170,
                blockedBy: { nodes: [], pageInfo: { hasNextPage: false } },
                subIssues: { totalCount: 0 },
              },
            },
          },
        }
        : path.endsWith("/issues/170")
        ? issueWire({
          number: 170,
          title: task.title,
          body: task.body,
          state: "closed",
        })
        : path.endsWith("/check-runs")
        ? {
          total_count: 1,
          check_runs: [
            checkRunWire({
              name: "test-local",
              head_sha: nativeOwner.revision,
              status: "completed",
              conclusion: "success",
            }),
          ],
        }
        : path.endsWith("/statuses")
        ? []
        : undefined;
      assert.notEqual(
        body,
        undefined,
        `unexpected external owner-review HTTP port ${path}`,
      );
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        bodyText: JSON.stringify(body),
      });
    },
  });
  assert.ok(ports?.custody);
  const events: string[] = [], custody = ports.custody;
  const registrations: OwnerSuccessorCustodyRegistration[] = [];
  ports.custody = {
    registerOwnerSuccessor: async (value) => {
      await custody.registerOwnerSuccessor(value);
      registrations.push(structuredClone(value));
      events.push("registered");
    },
    armOwnerSuccessor: async (value) => {
      await custody.armOwnerSuccessor(value);
      events.push("armed");
    },
    settledOwnerSuccessor: async (value) => {
      await custody.settledOwnerSuccessor(value);
      events.push("settled");
    },
  };
  const records = () => {
    try {
      return Deno.readTextFileSync(methods).trim().split("\n").filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const session = {
    turnStarts: () =>
      records().filter((r) => r.method === "review/start").length,
    get closed() {
      return events.filter((e) => e === "settled").length;
    },
  };
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await client.close();
    const carriers = await broker.finish({ settled: true, truncated: false });
    assert.deepEqual(
      carriers,
      [],
      "owner successor must never emit a false PR carrier",
    );
    await broker.dispose();
    assert.equal(await tracker.settleAll(), true);
    try {
      const pid = Number(await Deno.readTextFile(pidFile));
      let alive = false;
      try {
        Deno.kill(pid, 0);
        alive = true;
      } catch { /* Exact owned reviewer process settled. */ }
      assert.equal(alive, false);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  };
  return {
    ports,
    session,
    events,
    client,
    broker,
    dispose,
    assertRefusals: async () => {
      const registration = registrations[0];
      assert.ok(registration);
      const r = registration.review, starts = session.turnStarts();
      await assert.rejects(() =>
        client.registerOwnerSuccessor(
          {
            ...registration,
            kind: "base",
          } as unknown as OwnerSuccessorCustodyRegistration,
        )
      );
      await assert.rejects(() =>
        client.registerOwnerSuccessor({
          ...registration,
          review: {
            ...r,
            reservation: {
              ...r.reservation,
              outcome: "submitted",
              settledAt: Date.now(),
            },
          },
        })
      );
      await assert.rejects(() =>
        client.registerOwnerSuccessor({
          ...registration,
          review: {
            ...r,
            binding: {
              ...r.binding,
              nativeOwner: {
                ...r.binding.nativeOwner,
                launcherSha: "0".repeat(
                  40,
                ) as HostedExecutionIntentV1["launcherSha"],
              },
            },
          },
        })
      );
      await assert.rejects(() =>
        client.registerOwnerSuccessor({
          ...registration,
          review: {
            ...r,
            binding: { ...r.binding, ownerBindingSha256: "0".repeat(64) },
          },
        })
      );
      const unknown = "owner-successor-request:" + "0".repeat(64);
      await assert.rejects(() =>
        client.settledOwnerSuccessor({ requestId: unknown })
      );
      const missing = await ports!.reviewer.prepare({
        snapshot: r.binding.snapshot,
        task,
        requestId: unknown,
        invocationId: "missing-owner-registration",
        ownerRunId: nativeOwner.id,
        latestStartAt: Date.now() + 60_000,
        settleBy: Date.now() + 120_000,
      });
      assert.equal(
        missing.ok,
        false,
        "actual broker refuses missing registration before external session/model start",
      );
      assert.throws(() =>
        client.openSession({
          cwd: checkout,
          requestId: r.binding.requestId,
          invocationId: r.binding.invocationId,
          ownerRunId: nativeOwner.id,
        })
      );
      assert.equal(session.turnStarts(), starts);
    },
    assertSchema: () => {
      const request = records().find((r) => r.method === "review/start");
      assert.ok(request);
      assert.equal(request.schema, null);
      assert.equal(records().some((r) => r.method === "turn/start"), false);
      for (const record of records()) assert.deepEqual(record.overrides, []);
      const marker =
        "RESULT must satisfy the following descriptive contract; it is not a protocol-enforced output schema:\n";
      const schema = JSON.parse(
        request.target.instructions.split(marker)[1].split("\n")[0],
      );
      assert.deepEqual(
        schema?.properties.taskAcceptance.properties.issueNumber.enum,
        [170],
      );
      assert.deepEqual(
        schema?.properties.taskAcceptance.properties.taskDigest.enum,
        [task.digest],
      );
    },
  };
}
