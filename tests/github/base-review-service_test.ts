/** Trusted issue-only service over fake APIs and the real native reviewer. */
import assert from "node:assert/strict";
import { canonicalStringifySha256 } from "../../src/contracts/canonical.ts";
import {
  type GitHubChecksV1,
  type GitHubIssueV1,
  portError,
  portOk,
} from "../../src/contracts/ports.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  baseReviewCommentBody,
  baseReviewCommentPayload,
  type BaseReviewCommentV1,
} from "../../src/github/base-review-comments.ts";
import { parseBaseReviewEvidenceRef } from "../../src/github/base-review-evidence.ts";
import {
  type BaseTaskReviewOptionsV1,
  BaseTaskReviewService,
} from "../../src/github/base-review-service.ts";
import {
  parseExecution,
  parseReadyExecution,
} from "../../src/github/journal-metadata.ts";
import { parseReviewResultV1 } from "../../src/github/review-result-parser.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { r80Available, withR80Parsers } from "../host/r80-contracts.ts";
import { FakeClock, MemoryState } from "../repair/helpers.ts";
import { seededSnapshot } from "../repair/loop-rig.ts";
import {
  REPO,
  reservation,
  SHA1,
  SHA2,
  T0,
  workRecord,
} from "../state/helpers.ts";
import {
  agentMessage,
  makeReviewer,
  ScriptedCodexSession,
  snapshotFixture,
  turnCompleted,
} from "./codex-reviewer-helpers.ts";

const ORIGIN = "1".repeat(64);
const ADMISSION = "2".repeat(64);
const PUBLISHER = "ubiquity-sentinel[bot]";
const CHECKS = [
  "validate",
  "verify-artifact",
  "darwin-native",
  "mac-containment",
];
const R80 = await r80Available();

async function rig() {
  const issue: GitHubIssueV1 = {
    number: 300,
    title: "Reject negative deposits",
    body: "Reject a negative amount before changing the balance.",
    state: "open",
    author: "owner",
    labels: [],
    createdAt: T0 - 1_000,
    updatedAt: T0,
    closedAt: null,
    relations: { openBlockers: [], subIssueCount: 0 },
  };
  const task = {
    issueNumber: issue.number,
    title: issue.title,
    body: issue.body,
    digest: await reviewTaskStatementDigest({
      issueNumber: issue.number,
      title: issue.title,
      body: issue.body,
    }),
  };
  const record = workRecord("issue-300", {
    source: { kind: "issue", id: "300", revision: SHA1 },
    related: { incidentId: null, issueNumber: 300 },
    target: {
      base: SHA1,
      branch: null,
      checkpoint: null,
      head: null,
      pr: null,
    },
    counters: { attempts: 2, retries: 0, reviewRounds: 1 },
    wait: { reason: "backoff", since: T0, until: null },
    intent: {
      kind: "issue_closure",
      key: `base-review:${ORIGIN}:${task.digest}`,
      startedAt: T0,
      branch: null,
      expectedHead: SHA1,
      observedBase: SHA1,
      pr: null,
      requestId: ADMISSION,
      resultId: null,
    },
  });
  record.target.branch = candidateBranch(record.id);
  const state = new MemoryState();
  state.repairHead = SHA1;
  state.repair = parseRepairStateSnapshotV1(seededSnapshot([record], {
    reservations: [
      reservation(ORIGIN, {
        taskId: record.id,
        outcome: "ambiguous",
        settledAt: T0,
      }),
      reservation(ADMISSION, {
        taskId: record.id,
        purpose: "review_request",
        attempt: 1,
      }),
    ],
  }));
  const clock = new FakeClock(T0);
  const session = new ScriptedCodexSession();
  const comments = new Map<number, BaseReviewCommentV1>();
  const events: string[] = [];
  const data = {
    issue,
    base: SHA1,
    checks: {
      head: SHA1,
      checks: CHECKS.map((name) => ({
        name,
        head: SHA1,
        status: "completed" as const,
        conclusion: "success" as const,
        startedAt: T0 - 1_000,
        completedAt: T0,
      })),
    } as GitHubChecksV1,
    publisher: PUBLISHER,
    closeCalls: 0,
    createError: false,
    readHook: null as
      | null
      | ((comment: BaseReviewCommentV1) => BaseReviewCommentV1),
    createHook: null as null | (() => void),
    result: {
      verdict: "clean",
      summary: "The exact base already rejects negative amounts.",
      findings: [],
      taskAcceptance: {
        issueNumber: 300,
        taskDigest: task.digest,
        verdict: "already_satisfied_at_base",
        evidence: ["account.ts at the exact base rejects negative amounts."],
      },
    },
  };
  session.plan = () => events.push("turn/start");
  session.live = (native) => {
    native.emit("item/started", agentMessage(native.turnId, "result-1", ""));
    native.emit(
      "item/completed",
      agentMessage(
        native.turnId,
        "result-1",
        JSON.stringify(data.result),
      ),
    );
    native.emit("turn/completed", turnCompleted(native.turnId));
  };
  const client: BaseTaskReviewOptionsV1["client"] = {
    readIssue(number) {
      assert.equal(number, 300);
      events.push("issue/read");
      return Promise.resolve(portOk(data.issue));
    },
    readRef(ref) {
      assert.equal(ref, "refs/heads/development");
      events.push("base/read");
      return Promise.resolve(portOk({ ref, sha: data.base }));
    },
    readBaseReviewChecks(head, names) {
      assert.equal(head, SHA1);
      assert.deepEqual(names, CHECKS);
      events.push("checks/read");
      return Promise.resolve(portOk(data.checks));
    },
    createBaseReviewComment(number, body) {
      assert.equal(number, 300);
      events.push("comment/create");
      if (data.createError) {
        return Promise.resolve(portError("unavailable", "response lost"));
      }
      const comment = { id: comments.size + 101, body, author: data.publisher };
      comments.set(comment.id, comment);
      data.createHook?.();
      return Promise.resolve(portOk({ ...comment }));
    },
    readBaseReviewComment(number, id) {
      assert.equal(number, 300);
      events.push(`comment/read:${id}`);
      const comment = comments.get(id);
      assert.ok(comment);
      return Promise.resolve(
        portOk(data.readHook?.(comment) ?? { ...comment }),
      );
    },
    closeIssue(number) {
      assert.equal(number, 300);
      data.closeCalls++;
      events.push("issue/close");
      data.issue = { ...data.issue, state: "closed", closedAt: clock.now() };
      return Promise.resolve(portOk(data.issue));
    },
  };
  const options: BaseTaskReviewOptionsV1 = {
    client,
    repository: REPO,
    baseBranch: "development",
    publisher: PUBLISHER,
    clock,
    state,
    ownerRunId: "owner-run-1",
    provider: "openai",
    model: "gpt-reserve",
    snapshot: {
      async capture(input) {
        assert.deepEqual(input, { base: SHA1, head: SHA1 });
        return portOk(
          await snapshotFixture({
            base: SHA1,
            head: SHA1,
            mergeBase: SHA1,
            files: [],
          }),
        );
      },
    },
    reviewer: makeReviewer(session, {
      now: () => clock.now(),
      sessionCwd: Deno.cwd(),
    }),
    custody: {
      registerBaseReview: () => {
        events.push("custody/register");
        return Promise.resolve();
      },
      armBaseReview: () => {
        events.push("custody/arm");
        return Promise.resolve();
      },
      settledBaseReview: () => {
        events.push("custody/settled");
        return Promise.resolve();
      },
    },
  };
  const service = new BaseTaskReviewService(options);
  return {
    options,
    service,
    task,
    record,
    state,
    session,
    clock,
    comments,
    events,
    data,
    run: () =>
      service.run({
        record,
        task,
        admission: ADMISSION,
        latestStartAt: clock.now() + 60_000,
        settleBy: clock.now() + 120_000,
      }),
  };
}
type Rig = Awaited<ReturnType<typeof rig>>;

async function ready(h: Rig) {
  const run = await h.run();
  if (!run.ok) assert.fail(run.error.detail);
  const binding = parseBaseReviewEvidenceRef(run.value.ref);
  assert.ok(binding);
  const record = parseWorkRecordV1({
    ...h.record,
    evidence: [{ kind: "review_receipt", ref: run.value.ref }],
    intent: { ...h.record.intent!, resultId: binding.resultDigest },
  });
  h.state.repair = parseRepairStateSnapshotV1({
    ...h.state.repair!,
    work: [record],
    reservations: h.state.repair!.reservations.map((charge) =>
      charge.id === ADMISSION
        ? { ...charge, outcome: "submitted", settledAt: h.clock.now() }
        : charge
    ),
  });
  return { record, ref: run.value.ref, deadline: h.clock.now() + 60_000 };
}

Deno.test("base service: native review saves exact running/result/ready payloads then closes once after restart", async () => {
  const h = await rig();
  const inspected = await h.service.inspect({
    record: h.record,
    deadline: T0 + 60_000,
  });
  assert.deepEqual(inspected, portOk(h.task));
  const close = await ready(h);
  assert.equal(h.session.turnStarts(), 1);
  assert.equal(h.comments.size, 3);
  const payloads = [...h.comments.values()].map((row) =>
    baseReviewCommentPayload(row.body)
  );
  const running = parseExecution(payloads[0], "$.execution");
  const result = parseReviewResultV1(payloads[1]);
  const execution = parseReadyExecution(payloads[2], "$.execution");
  assert.equal(running.invocationId, `base-review-${ADMISSION}`);
  assert.equal(execution.invocationId, running.invocationId);
  assert.equal(result.taskAcceptance?.taskDigest, h.task.digest);
  assert.ok(
    h.events.indexOf("comment/read:101") < h.events.indexOf("turn/start"),
  );
  assert.ok(h.events.indexOf("custody/arm") < h.events.indexOf("turn/start"));
  assert.ok(
    h.events.indexOf("custody/settled") <
      h.events.lastIndexOf("comment/create"),
  );
  const restarted = new BaseTaskReviewService({
    ...h.options,
    ownerRunId: "owner-run-2",
  });
  assert.deepEqual(await restarted.close(close), portOk("closed"));
  assert.deepEqual(await restarted.close(close), portOk("already_closed"));
  assert.equal(h.data.closeCalls, 1);
  assert.equal(h.session.turnStarts(), 1);
  assert.equal(
    h.state.repairWrites,
    0,
    "service has no authoritative state writer",
  );
  assert.equal(h.state.repair!.reservations[0].outcome, "ambiguous");
});

Deno.test("base service: current base, source task, dependencies and every required CI job gate a native start", async () => {
  const mutations: [string, (h: Rig) => void][] = [
    ["base", (h) => {
      h.data.base = SHA2;
    }],
    ["source text", (h) => {
      h.data.issue.body += " changed";
    }],
    ["source identity", (h) => {
      h.data.issue.number = 301;
    }],
    ["closed source", (h) => {
      h.data.issue.state = "closed";
    }],
    ["opt out", (h) => {
      h.data.issue.labels = ["sentinel:skip"];
    }],
    ["dependencies unavailable", (h) => {
      delete h.data.issue.relations;
    }],
    ["open dependency", (h) => {
      h.data.issue.relations!.subIssueCount = 1;
    }],
    ["missing check", (h) => {
      h.data.checks.checks.pop();
    }],
    ["red CI", (h) => {
      h.data.checks.checks[0].conclusion = "failure";
    }],
    ["wrong check head", (h) => {
      h.data.checks.head = SHA2;
    }],
    ["admission drift", (h) => {
      h.state.repair!.work[0].counters.retries++;
    }],
    ["spent admission", (h) => {
      h.state.repair!.reservations[1].outcome = "ambiguous";
    }],
    ["missing original implementation charge", (h) => {
      h.state.repair!.reservations.shift();
    }],
    ["original charge was never submitted", (h) => {
      h.state.repair!.reservations[0].outcome = "reserved";
      h.state.repair!.reservations[0].settledAt = null;
    }],
    ["intent task digest mismatch", (h) => {
      h.record.intent!.key = `base-review:${ORIGIN}:${"3".repeat(64)}`;
      h.state.repair!.work[0] = structuredClone(h.record);
    }],
  ];
  for (const [label, mutate] of mutations) {
    const h = await rig();
    // Incoming request and current state are independent copies.
    h.state.repair = structuredClone(h.state.repair);
    mutate(h);
    const result = await h.run();
    assert.equal(result.ok, false, label);
    assert.equal(h.session.turnStarts(), 0, label);
    assert.equal(h.comments.size, 0, label);
    assert.equal(h.data.closeCalls, 0, label);
  }
});

Deno.test("base service: running comment readback and fresh facts precede native start", async () => {
  const mutations: [string, (h: Rig) => void][] = [
    ["foreign author", (h) => {
      h.data.publisher = "another-app[bot]";
    }],
    ["readback edited", (h) => {
      h.data.readHook = (row) => ({ ...row, body: row.body + " " });
    }],
    ["create ambiguous", (h) => {
      h.data.createError = true;
    }],
    ["base drift after running write", (h) => {
      h.data.createHook = () => {
        h.data.base = SHA2;
      };
    }],
    ["task drift after running write", (h) => {
      h.data.createHook = () => {
        h.data.issue.body += " changed";
      };
    }],
    ["historical generic execution cannot authorize a native start", (h) => {
      const prepare = h.options.reviewer.prepare.bind(h.options.reviewer);
      h.options.reviewer.prepare = async (request) => {
        const prepared = await prepare(request);
        if (prepared.ok) {
          delete prepared.value.execution.nativeReview;
          prepared.value.execution.model = "historical-reviewer";
          prepared.value.execution.reasoning = "max";
        }
        return prepared;
      };
    }],
  ];
  for (const [label, mutate] of mutations) {
    const h = await rig();
    mutate(h);
    assert.equal((await h.run()).ok, false, label);
    assert.equal(h.session.turnStarts(), 0, label);
    assert.ok(h.session.closed > 0, label);
    assert.equal(h.data.closeCalls, 0, label);
  }
});

Deno.test("base service: ambiguous or unsettled native completion cannot publish ready evidence", async () => {
  for (const kind of ["ambiguous", "unsettled"] as const) {
    const h = await rig();
    if (kind === "ambiguous") {
      const original = h.session.live!;
      h.session.live = (native) => {
        original(native);
        native.emit(
          "item/completed",
          agentMessage(
            native.turnId,
            "duplicate",
            JSON.stringify(h.data.result),
          ),
        );
      };
    } else h.session.settled = false;
    assert.equal((await h.run()).ok, false, kind);
    assert.equal(h.session.turnStarts(), 1, kind);
    assert.equal(h.comments.size, 1, "only the durable running marker remains");
    assert.equal(h.data.closeCalls, 0);
    assert.equal(h.state.repair!.reservations[0].outcome, "ambiguous");
  }
});

Deno.test("base service: ready evidence must retain the exact prepared native thread", async () => {
  const h = await rig();
  const native = h.options.reviewer;
  h.options.reviewer = {
    async prepare(input) {
      const prepared = await native.prepare(input);
      if (!prepared.ok) return prepared;
      return portOk({
        ...prepared.value,
        execution: prepared.value.execution,
        close: () => prepared.value.close(),
        async start() {
          const completed = await prepared.value.start();
          if (!completed.ok || completed.value.execution === null) {
            return completed;
          }
          return portOk({
            ...completed.value,
            execution: {
              ...completed.value.execution,
              threadId: "different-native-thread",
            },
          });
        },
      });
    },
  };
  assert.equal((await h.run()).ok, false);
  assert.equal(h.session.turnStarts(), 1);
  assert.equal(
    h.comments.size,
    1,
    "a mixed native thread cannot publish ready evidence",
  );
  assert.equal(h.data.closeCalls, 0);
});

Deno.test("base service: model-authored hosted app triggers never reach a comment write", async () => {
  const h = await rig();
  h.data.result.summary = ["@codex", "review"].join(" ");
  assert.equal((await h.run()).ok, false);
  assert.equal(h.session.turnStarts(), 1);
  assert.equal(
    h.comments.size,
    1,
    "only the native running marker was published",
  );
  assert.equal(h.data.closeCalls, 0);
  for (const row of h.comments.values()) {
    assert.doesNotMatch(row.body, /@codex\s+review/i);
  }
});

Deno.test("base service: closure rechecks live facts, publisher and exact native payload digests", async () => {
  const mutations: [string, (h: Rig) => void][] = [
    ["moved base", (h) => {
      h.data.base = SHA2;
    }],
    ["edited source", (h) => {
      h.data.issue.body += " changed";
    }],
    ["red base CI", (h) => {
      h.data.checks.checks[0].conclusion = "failure";
    }],
    ["missing base CI", (h) => {
      h.data.checks.checks.pop();
    }],
    ["wrong comment author", (h) => {
      h.comments.get(102)!.author = "another-app[bot]";
    }],
    ["edited result payload", (h) => {
      const row = h.comments.get(102)!;
      const result = parseReviewResultV1(baseReviewCommentPayload(row.body));
      row.body = baseReviewCommentBody({
        ...result,
        summary: "Changed summary",
      });
    }],
    ["edited execution payload", (h) => {
      const row = h.comments.get(103)!;
      const execution = parseReadyExecution(
        baseReviewCommentPayload(row.body),
        "$.execution",
      );
      row.body = baseReviewCommentBody({
        ...execution,
        ownerRunId: "other-owner",
      });
    }],
    ["readback wrong id", (h) => {
      h.data.readHook = (row) => ({ ...row, id: 999 });
    }],
  ];
  for (const [label, mutate] of mutations) {
    const h = await rig();
    const request = await ready(h);
    mutate(h);
    assert.equal((await h.service.close(request)).ok, false, label);
    assert.equal(h.data.closeCalls, 0, label);
    assert.equal(
      h.session.turnStarts(),
      1,
      "reconciliation starts no reviewer",
    );
  }
});

Deno.test("base service: clean code quality alone never authorizes issue closure", async () => {
  for (const verdict of ["fulfilled", "not_fulfilled", "uncertain"]) {
    const h = await rig();
    h.data.result.taskAcceptance.verdict = verdict;
    const request = await ready(h);
    assert.equal((await h.service.close(request)).ok, false, verdict);
    assert.equal(h.data.closeCalls, 0, verdict);
  }
});

Deno.test({
  name:
    "base service: actual R80 refuses native execution while preserving result and held-state parsing",
  ignore: !R80,
  async fn() {
    const h = await rig();
    const request = await ready(h);
    const binding = parseBaseReviewEvidenceRef(request.ref)!;
    const [running, result, execution] = [...h.comments.values()].map((row) =>
      baseReviewCommentPayload(row.body)
    );
    assert.equal(await canonicalStringifySha256(result), binding.resultDigest);
    assert.equal(
      await canonicalStringifySha256(execution),
      binding.executionDigest,
    );
    await withR80Parsers((old) => {
      assert.throws(() => old.parseReviewExecutionV1(running));
      assert.deepEqual(old.parseReviewResultV1(result), result);
      assert.throws(() => old.parseReviewReadyExecutionV1(execution));
      assert.deepEqual(
        old.parseRepairStateSnapshotV1(h.state.repair),
        h.state.repair,
      );
    });
  },
});
