/**
 * T03: structured Codex reviewer against scripted app-server sessions.
 * No model, network, GitHub or paid calls; every timeout is milliseconds and
 * driven by control promises or injected deadlines.
 */

import assert from "node:assert/strict";
import { finalizeReviewCompletion } from "../../src/github/codex-reviewer.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import {
  ACCOUNT_CONTENT,
  agentMessage,
  assertStrictSubmittedSchema,
  BASE,
  CLEAN_RESULT,
  contains,
  HEAD,
  makeReviewer,
  prepareRequest,
  PROVIDER,
  REVIEW_PROFILE,
  ScriptedCodexSession,
  snapshotFixture,
  startReview,
  submittedPrompt,
  turnCompleted,
} from "./codex-reviewer-helpers.ts";

Deno.test(
  "reviewer: prepare exposes the running identity with zero turn/start and abandon closes cleanly",
  async () => {
    const session = new ScriptedCodexSession();
    const snapshot = await snapshotFixture();
    const reviewer = makeReviewer(session);
    const prepared = await reviewer.prepare(prepareRequest(snapshot));
    if (!prepared.ok) assert.fail(prepared.error.detail);
    const review = prepared.value;

    assert.deepEqual(session.sent, ["initialize", "thread/start"]);
    assert.deepEqual(
      (session.params[0] as Record<string, unknown>).capabilities,
      {
        experimentalApi: true,
        optOutNotificationMethods: [
          "item/reasoning/summaryTextDelta",
          "item/reasoning/summaryPartAdded",
          "item/reasoning/textDelta",
        ],
      },
      "the required named profile enables the experimental capabilities",
    );
    assert.equal(session.opened, 1);
    assert.equal(session.turnStarts(), 0);
    assert.equal(review.startAttempted(), false);
    assert.equal(review.execution.threadId, "thread-1");
    assert.equal(review.execution.invocationId, "invocation-1");
    assert.equal(review.execution.ownerRunId, "run-1");
    assert.equal(review.execution.submittedProvider, PROVIDER);
    assert.equal(review.execution.model, "gpt-reserve");
    assert.equal(review.execution.reasoning, "max");
    assert.equal(review.execution.startMayOccur, true);
    assert.equal("turnId" in review.execution, false);

    const threadParams = session.params[1] as Record<string, unknown>;
    assert.equal(threadParams.model, "gpt-reserve");
    assert.equal(threadParams.modelProvider, PROVIDER);
    assert.equal(threadParams.permissions, REVIEW_PROFILE);
    assert.equal(
      "sandbox" in threadParams,
      false,
      "the required named profile replaces the legacy sandbox",
    );
    assert.equal(threadParams.approvalPolicy, "never");
    assert.deepEqual(threadParams.config, {
      model_reasoning_effort: "max",
      review_model: "gpt-reserve",
      "features.shell_tool": true,
      "features.unified_exec": false,
      "features.multi_agent": false,
      "features.apps": false,
      web_search: "disabled",
    });

    const close = await review.close();
    assert.equal(close.settled, true);
    assert.equal(close.failure, null);
    assert.equal(close.timedOut, false);
    assert.equal(session.closed, 1);
    assert.equal(session.turnStarts(), 0);
  },
);

Deno.test(
  "reviewer: exactly one start submits a strict schema and accepts explicit null without a task",
  async () => {
    const session = new ScriptedCodexSession();
    const result = { ...CLEAN_RESULT, taskAcceptance: null };
    let now = Date.now();
    session.live = (scripted) => {
      now += 1;
      scripted.emit(
        "item/started",
        agentMessage(scripted.turnId, "item-1", ""),
      );
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-1",
          JSON.stringify(result),
        ),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const snapshot = await snapshotFixture();
    const reviewer = makeReviewer(session, { now: () => now });
    const prepared = await reviewer.prepare(prepareRequest(snapshot));
    if (!prepared.ok) assert.fail(prepared.error.detail);
    const review = prepared.value;
    const outcome = await review.start();
    if (!outcome.ok) assert.fail(outcome.error.detail);
    assert.equal(outcome.value.status, "clean");
    assert.deepEqual(outcome.value.result, result);
    assert.equal(outcome.value.resultId, "item-1");
    assert.equal(outcome.value.execution?.turnId, "turn-1");
    assert.equal(session.turnStarts(), 1);

    const again = await review.start();
    assert.equal(again.ok, false, "a repeated start must reject");
    assert.equal(session.turnStarts(), 1, "no second turn/start request");

    const turnParams = session.params[2] as {
      input: { text: string }[];
      outputSchema: unknown;
      permissions: unknown;
      approvalPolicy: unknown;
      model: unknown;
      effort: unknown;
    };
    assert.equal(turnParams.model, "gpt-reserve");
    assert.equal(turnParams.effort, "max");
    assert.equal(turnParams.permissions, REVIEW_PROFILE);
    assertStrictSubmittedSchema(session);
    const prompt = turnParams.input[0].text;
    contains(prompt, `Base ${BASE}; head ${HEAD};`);
    contains(prompt, snapshot.digest);
    contains(prompt, 'path "account.ts"; kind modified');
    contains(prompt, `oldBlob ${"1".repeat(40)}; newBlob ${"2".repeat(40)}`);
    contains(prompt, "candidateLines 4");
    contains(prompt, "--no-ext-diff");
    contains(prompt, "--no-textconv");
    assert.equal(
      prompt.includes(ACCOUNT_CONTENT.trim()),
      false,
      "no candidate content is embedded in the manifest prompt",
    );

    const closed = await review.close();
    assert.equal(closed.settled, true);
    const keptClean = finalizeReviewCompletion(outcome, closed);
    assert.equal(
      keptClean.ok,
      true,
      "an ordinary close after a clean result preserves it",
    );
    const afterClose = await review.start();
    assert.equal(afterClose.ok, false, "start after close must reject");
    assert.equal(session.turnStarts(), 1);
  },
);

Deno.test(
  "reviewer: task identities are constrained per request without cross-task schema mutation",
  async () => {
    const snapshot = await snapshotFixture();
    const schemas: {
      properties: {
        taskAcceptance: {
          properties: {
            issueNumber: { enum?: number[] };
            taskDigest: { enum?: string[] };
          };
        };
      };
    }[] = [];
    const tasks = [];
    for (const issueNumber of [263, 264]) {
      const text = {
        issueNumber,
        title: `Review task ${issueNumber}`,
        body: "Verify the exact candidate against this source task.",
      };
      const task = { ...text, digest: await reviewTaskStatementDigest(text) };
      tasks.push(task);
      const session = new ScriptedCodexSession();
      let now = Date.now();
      session.live = (scripted) => {
        now += 1;
        scripted.emit(
          "item/started",
          agentMessage(scripted.turnId, "item-1", ""),
        );
        scripted.emit(
          "item/completed",
          agentMessage(
            scripted.turnId,
            "item-1",
            JSON.stringify({
              ...CLEAN_RESULT,
              taskAcceptance: {
                issueNumber: task.issueNumber,
                taskDigest: task.digest,
                verdict: "fulfilled",
                evidence: ["The exact candidate implements this task."],
              },
            }),
          ),
        );
        scripted.emit("turn/completed", turnCompleted(scripted.turnId));
      };
      const reviewer = makeReviewer(session, { now: () => now });
      const prepared = await reviewer.prepare(
        prepareRequest(snapshot, { task }),
      );
      if (!prepared.ok) assert.fail(prepared.error.detail);
      try {
        const outcome = await prepared.value.start();
        if (!outcome.ok) assert.fail(outcome.error.detail);
        assert.equal(outcome.value.status, "clean");
        assertStrictSubmittedSchema(session);
        const params = session.params[session.sent.indexOf("turn/start")] as {
          outputSchema: typeof schemas[number];
        };
        schemas.push(params.outputSchema);
      } finally {
        await prepared.value.close();
      }
    }
    for (const [index, schema] of schemas.entries()) {
      const identity = schema.properties.taskAcceptance.properties;
      assert.deepEqual(identity.issueNumber.enum, [tasks[index].issueNumber]);
      assert.deepEqual(identity.taskDigest.enum, [tasks[index].digest]);
    }
    assert.notEqual(schemas[0], schemas[1], "each task owns its schema");
  },
);

Deno.test(
  "reviewer: a supplied task statement requires the exact bound acceptance",
  async () => {
    const task = {
      issueNumber: 263,
      title: "Start the VPS service with the selected release configuration",
      body: "Load the immutable selected-release config/import map/lockfile " +
        "and prove a rollback fixture.",
      // The digest must actually bind THIS text: an arbitrary 64-hex value is
      // refused before any session opens (proved below).
      digest: await reviewTaskStatementDigest({
        issueNumber: 263,
        title: "Start the VPS service with the selected release configuration",
        body:
          "Load the immutable selected-release config/import map/lockfile " +
          "and prove a rollback fixture.",
      }),
    };
    const acceptance = {
      issueNumber: task.issueNumber,
      taskDigest: task.digest,
      verdict: "fulfilled",
      evidence: ["the launcher loads the exact selected release configuration"],
    };
    const cases: [string, unknown, string | null][] = [
      [
        "missing acceptance",
        CLEAN_RESULT,
        "structured review unavailable: the result omitted the required task acceptance for a supplied task statement",
      ],
      [
        "null acceptance",
        { ...CLEAN_RESULT, taskAcceptance: null },
        "structured review unavailable: the result omitted the required task acceptance for a supplied task statement",
      ],
      [
        "acceptance for another task",
        {
          ...CLEAN_RESULT,
          taskAcceptance: { ...acceptance, issueNumber: 999 },
        },
        "structured review unavailable: the task acceptance is not bound to the supplied task statement",
      ],
      [
        "acceptance digest not bound",
        {
          ...CLEAN_RESULT,
          taskAcceptance: { ...acceptance, taskDigest: "d".repeat(64) },
        },
        "structured review unavailable: the task acceptance is not bound to the supplied task statement",
      ],
      ["exactly bound acceptance", {
        ...CLEAN_RESULT,
        taskAcceptance: acceptance,
      }, null],
    ];
    for (const [label, result, detail] of cases) {
      const session = new ScriptedCodexSession();
      let now = Date.now();
      session.live = (scripted) => {
        now += 1;
        scripted.emit(
          "item/started",
          agentMessage(scripted.turnId, "item-1", ""),
        );
        scripted.emit(
          "item/completed",
          agentMessage(scripted.turnId, "item-1", JSON.stringify(result)),
        );
        scripted.emit("turn/completed", turnCompleted(scripted.turnId));
      };
      const snapshot = await snapshotFixture();
      const reviewer = makeReviewer(session, { now: () => now });
      const prepared = await reviewer.prepare(
        prepareRequest(snapshot, { task }),
      );
      if (!prepared.ok) assert.fail(prepared.error.detail);
      const outcome = await prepared.value.start();
      if (!outcome.ok) assert.fail(outcome.error.detail);
      assertStrictSubmittedSchema(session);
      // The single turn/start carries the bound task statement as data.
      const prompt = (session.params[2] as { input: { text: string }[] })
        .input[0].text;
      contains(prompt, "TASK STATEMENT");
      contains(prompt, `Source issue: #${task.issueNumber}`);
      contains(prompt, `Task digest: ${task.digest}`);
      contains(prompt, task.body);
      if (detail === null) {
        assert.equal(outcome.value.status, "clean", label);
        assert.deepEqual(outcome.value.result?.taskAcceptance, acceptance);
      } else {
        assert.equal(outcome.value.status, "unavailable", label);
        assert.equal(outcome.value.detail, detail, label);
      }
      await prepared.value.close();
    }

    // A task statement that does not bind its own text opens no session.
    const session = new ScriptedCodexSession();
    const reviewer = makeReviewer(session);
    const snapshot = await snapshotFixture();
    const invalid = await reviewer.prepare(
      prepareRequest(snapshot, {
        task: { ...task, digest: "e".repeat(64) },
      }),
    );
    assert.equal(invalid.ok, false);
    assert.equal(session.opened, 0, "no session opens for a malformed task");
  },
);

Deno.test(
  "reviewer: a result cannot invent an acceptance without a task statement",
  async () => {
    const session = new ScriptedCodexSession();
    session.live = (scripted) => {
      scripted.emit(
        "item/started",
        agentMessage(scripted.turnId, "item-1", ""),
      );
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-1",
          JSON.stringify({
            ...CLEAN_RESULT,
            taskAcceptance: {
              issueNumber: 263,
              taskDigest: "c".repeat(64),
              verdict: "fulfilled",
              evidence: ["invented"],
            },
          }),
        ),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const snapshot = await snapshotFixture();
    const reviewer = makeReviewer(session);
    const prepared = await reviewer.prepare(prepareRequest(snapshot));
    if (!prepared.ok) assert.fail(prepared.error.detail);
    const outcome = await prepared.value.start();
    if (!outcome.ok) assert.fail(outcome.error.detail);
    assert.equal(outcome.value.status, "unavailable");
    assert.equal(
      outcome.value.detail,
      "structured review unavailable: the result carried a task acceptance without a supplied task statement",
    );
    await prepared.value.close();
  },
);

Deno.test(
  "reviewer: unused reasoning streams are opted out without ending a loud review",
  async () => {
    const session = new ScriptedCodexSession();
    session.live = (scripted) => {
      scripted.emit("item/reasoning/summaryTextDelta", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        delta: "considering the manifest",
      });
      scripted.emit("item/reasoning/summaryPartAdded", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        summaryIndex: 0,
      });
      scripted.emit("item/reasoning/textDelta", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        delta: "raw reasoning",
      });
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-1",
          JSON.stringify(CLEAN_RESULT),
        ),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const snapshot = await snapshotFixture();
    const reviewer = makeReviewer(session);
    const prepared = await reviewer.prepare(prepareRequest(snapshot));
    if (!prepared.ok) assert.fail(prepared.error.detail);
    assert.deepEqual(
      (session.params[0] as Record<string, unknown>).capabilities,
      {
        experimentalApi: true,
        optOutNotificationMethods: [
          "item/reasoning/summaryTextDelta",
          "item/reasoning/summaryPartAdded",
          "item/reasoning/textDelta",
        ],
      },
      "the initialize request opts out of exactly the unused reasoning streams",
    );

    const review = prepared.value;
    const outcome = await review.start();
    if (!outcome.ok) assert.fail(outcome.error.detail);
    assert.equal(outcome.value.status, "clean");
    assert.deepEqual(outcome.value.result, CLEAN_RESULT);
    assert.equal(outcome.value.resultId, "item-1");
    assert.equal(outcome.value.execution?.turnId, "turn-1");
    contains(submittedPrompt(session), `Base ${BASE}; head ${HEAD};`);
    assert.equal(session.turnStarts(), 1);

    // A server that ignores the opt-out still gets its full review duration.
    const breach = new ScriptedCodexSession();
    breach.live = (scripted) => {
      for (let index = 0; index < 4_200; index++) {
        scripted.emit("item/reasoning/textDelta", {
          threadId: "thread-1",
          turnId: scripted.turnId,
          delta: "raw",
        });
      }
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-late",
          JSON.stringify(CLEAN_RESULT),
        ),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const completed = await startReview(breach, await snapshotFixture());
    assert.equal(completed.status, "clean");
    assert.deepEqual(completed.result, CLEAN_RESULT);
    assert.equal(completed.resultId, "item-late");
    assert.equal(completed.execution?.turnId, "turn-1");
  },
);

Deno.test(
  "reviewer: configured review model binds thread, turn, running, ready and actual identity",
  async () => {
    const configured = "route-selected-review-model";
    const session = new ScriptedCodexSession();
    session.threadAck = {
      ...(session.threadAck as Record<string, unknown>),
      model: configured,
    };
    session.live = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-1", JSON.stringify(CLEAN_RESULT)),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const reviewer = makeReviewer(session, { model: configured });
    const prepared = await reviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!prepared.ok) assert.fail(prepared.error.detail);
    const review = prepared.value;
    // The running execution already carries the configured identity.
    assert.equal(review.execution.model, configured);
    assert.equal(review.execution.submittedProvider, PROVIDER);
    assert.equal(review.execution.reasoning, "max");

    // thread/start submits and requires exactly the configured model.
    const threadParams = session.params[1] as Record<string, unknown>;
    assert.equal(threadParams.model, configured);
    assert.equal(threadParams.modelProvider, PROVIDER);
    const threadConfig = threadParams.config as Record<string, unknown>;
    assert.equal(threadConfig.model_reasoning_effort, "max");
    assert.equal(threadConfig.review_model, configured);

    const outcome = await review.start();
    if (!outcome.ok) assert.fail(outcome.error.detail);
    assert.equal(outcome.value.status, "clean");
    assert.equal(outcome.value.resultId, "item-1");
    // The single turn submits the configured model with max reasoning.
    const turnParams = session.params[2] as Record<string, unknown>;
    assert.equal(turnParams.model, configured);
    assert.equal(turnParams.effort, "max");
    // The ready execution and the runtime actual bind the same identity.
    assert.equal(outcome.value.execution?.model, configured);
    assert.equal(outcome.value.execution?.actual.observedModel, configured);
    assert.equal(outcome.value.actual?.observedModel, configured);
    assert.equal(outcome.value.actual?.observedReasoning, "max");
    assert.equal(outcome.value.actual?.provider, PROVIDER);

    const closed = await review.close();
    assert.equal(closed.settled, true);
  },
);

Deno.test(
  "reviewer: configured review model wrong acknowledgement and off-policy reroute are refused",
  async () => {
    const configured = "route-selected-review-model";
    const configuredAck = (session: ScriptedCodexSession) => {
      session.threadAck = {
        ...(session.threadAck as Record<string, unknown>),
        model: configured,
      };
    };

    // An acknowledged default literal is a wrong identity, not a relabel: the
    // preparation fails closed before any turn is submitted.
    const wrongAck = new ScriptedCodexSession();
    const refused = await makeReviewer(wrongAck, { model: configured })
      .prepare(prepareRequest(await snapshotFixture()));
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.error.kind, "unavailable");
    }
    assert.equal(wrongAck.turnStarts(), 0);
    assert.equal(wrongAck.closed, 1, "the owned session settles");

    // A reroute away from the configured model — including to the default
    // literal — is off-policy and never yields a clean review.
    for (const to of ["gpt-reserve", "other-review-model"]) {
      const rerouted = new ScriptedCodexSession();
      configuredAck(rerouted);
      rerouted.plan = (scripted) => {
        scripted.emit("model/rerouted", {
          threadId: "thread-1",
          turnId: scripted.turnId,
          fromModel: configured,
          toModel: to,
          reason: "capacity",
        });
        scripted.emit(
          "item/completed",
          agentMessage(
            scripted.turnId,
            "item-1",
            JSON.stringify(CLEAN_RESULT),
          ),
        );
        scripted.emit("turn/completed", turnCompleted(scripted.turnId));
      };
      const routing = await startReview(
        rerouted,
        await snapshotFixture(),
        configured,
      );
      assert.equal(routing.status, "unavailable");
      contains(routing.detail ?? "", "routed off");
    }

    // A failed runtime terminal still reports the configured model in the
    // actual block; the default literal is never substituted.
    const failed = new ScriptedCodexSession();
    configuredAck(failed);
    failed.plan = (scripted) => {
      scripted.emit("turn/completed", turnCompleted(scripted.turnId, "failed"));
    };
    const failedOutcome = await startReview(
      failed,
      await snapshotFixture(),
      configured,
    );
    assert.equal(failedOutcome.status, "unavailable");
    assert.equal(failedOutcome.actual?.observedModel, configured);
    assert.notEqual(
      failedOutcome.actual?.observedModel,
      "gpt-reserve",
      "the actual identity is never relabeled to the default literal",
    );
  },
);

Deno.test(
  "reviewer: configured review model invalid values refuse before opening any session",
  async (t) => {
    // Explicit runtime null is not the omitted-caller default: it reaches the
    // bounded validator and refuses (typed through unknown to stay
    // baseline-compatible with the optional model option).
    const invalid: unknown[] = [
      "",
      " ",
      " model",
      "model ",
      "bad\nmodel",
      "x".repeat(257),
      null,
    ];
    for (const model of invalid) {
      await t.step(JSON.stringify(model), async () => {
        const session = new ScriptedCodexSession();
        const prepared = await makeReviewer(session, { model })
          .prepare(prepareRequest(await snapshotFixture()));
        assert.equal(prepared.ok, false);
        if (prepared.ok) return;
        assert.equal(prepared.error.kind, "unavailable");
        contains(prepared.error.detail, "review model");
        assert.equal(session.opened, 0, "no app-server session is opened");
        assert.deepEqual(session.sent, [], "no handshake request is sent");
      });
    }
  },
);

Deno.test(
  "reviewer: bad thread acknowledgement fails preparation and closes the session",
  async () => {
    const session = new ScriptedCodexSession();
    session.threadAck = {
      thread: { id: "thread-1" },
      model: "gpt-5.4",
      modelProvider: PROVIDER,
      reasoningEffort: "max",
    };
    const reviewer = makeReviewer(session);
    const prepared = await reviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    assert.equal(prepared.ok, false);
    if (prepared.ok) assert.fail("expected rejection");
    assert.equal(prepared.error.kind, "unavailable");
    assert.equal(session.closed, 1);
    assert.equal(session.turnStarts(), 0);

    const provider = new ScriptedCodexSession();
    provider.threadAck = {
      thread: { id: "thread-1" },
      model: "gpt-reserve",
      modelProvider: "other-provider",
      reasoningEffort: "max",
    };
    const mismatch = await makeReviewer(provider).prepare(
      prepareRequest(await snapshotFixture()),
    );
    assert.equal(mismatch.ok, false);
    assert.equal(provider.closed, 1);
    assert.equal(provider.turnStarts(), 0);
  },
);
