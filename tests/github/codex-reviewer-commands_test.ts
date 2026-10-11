// codex reviewer commands_test.

import assert from "node:assert/strict";
import { finalizeReviewCompletion } from "../../src/github/codex-reviewer.ts";
import { CodexProtocolError } from "../../src/repair/codex-transport.ts";
import type { ReviewSnapshotV1 } from "../../src/github/review-snapshot.ts";
import {
  agentMessage,
  CLEAN_RESULT,
  commandItem,
  contains,
  makeReviewer,
  prepareRequest,
  ScriptedCodexSession,
  snapshotFixture,
  startReview,
  turnCompleted,
} from "./codex-reviewer-helpers.ts";

Deno.test(
  "reviewer: unfinished commands, malformed or wrong command identities and interruptions never yield clean",
  async () => {
    // A started command without a completed settlement.
    const unfinished = new ScriptedCodexSession();
    unfinished.plan = (scripted) => {
      scripted.emit("item/started", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "inProgress"),
      });
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-final",
          JSON.stringify(CLEAN_RESULT),
        ),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const pending = await startReview(unfinished, await snapshotFixture());
    assert.equal(pending.status, "unavailable");
    assert.equal(pending.execution, null);
    contains(pending.detail ?? "", "settle");

    // A delta that shares no started command item identity.
    const unknownDelta = new ScriptedCodexSession();
    unknownDelta.plan = (scripted) => {
      scripted.emit("item/commandExecution/outputDelta", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        itemId: "cmd-unknown",
        delta: "x\n",
      });
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const uncorrelated = await startReview(
      unknownDelta,
      await snapshotFixture(),
    );
    assert.equal(uncorrelated.status, "unavailable");
    contains(uncorrelated.detail ?? "", "correlate");

    // A delta carrying a different turn identity.
    const wrongTurn = new ScriptedCodexSession();
    wrongTurn.plan = (scripted) => {
      scripted.emit("item/started", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "inProgress"),
      });
      scripted.emit("item/commandExecution/outputDelta", {
        threadId: "thread-1",
        turnId: "turn-other",
        itemId: "cmd-1",
        delta: "x\n",
      });
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const mismatched = await startReview(wrongTurn, await snapshotFixture());
    assert.equal(mismatched.status, "unavailable");
    contains(mismatched.detail ?? "", "correlate");

    // A malformed delta shape (non-string delta).
    const malformedDelta = new ScriptedCodexSession();
    malformedDelta.plan = (scripted) => {
      scripted.emit("item/commandExecution/outputDelta", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        itemId: "cmd-1",
        delta: 5,
      });
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const malformed = await startReview(
      malformedDelta,
      await snapshotFixture(),
    );
    assert.equal(malformed.status, "unavailable");
    contains(malformed.detail ?? "", "correlate");

    // An unmatched command completion with no recorded start.
    const unmatched = new ScriptedCodexSession();
    unmatched.plan = (scripted) => {
      scripted.emit("item/completed", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "completed"),
      });
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const orphan = await startReview(unmatched, await snapshotFixture());
    assert.equal(orphan.status, "unavailable");
    contains(orphan.detail ?? "", "command execution item");

    // A command start that reports a cwd other than the trusted session cwd.
    const wrongCwd = new ScriptedCodexSession();
    wrongCwd.plan = (scripted) => {
      scripted.emit("item/started", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "inProgress", {
          cwd: "/tmp/other-checkout",
        }),
      });
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const cwdRefused = await startReview(wrongCwd, await snapshotFixture());
    assert.equal(cwdRefused.status, "unavailable");
    contains(cwdRefused.detail ?? "", "command execution item");

    // Plugin/script provenance can never claim the agent read operation.
    const pluginSource = new ScriptedCodexSession();
    pluginSource.plan = (scripted) => {
      scripted.emit("item/started", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "inProgress", {
          source: "plugin",
          pluginId: "plugin-1",
        }),
      });
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const sourceRefused = await startReview(
      pluginSource,
      await snapshotFixture(),
    );
    assert.equal(sourceRefused.status, "unavailable");
    contains(sourceRefused.detail ?? "", "command execution item");

    // A start status that is already terminal is not a valid start.
    const terminalStart = new ScriptedCodexSession();
    terminalStart.plan = (scripted) => {
      scripted.emit("item/started", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "completed"),
      });
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const statusRefused = await startReview(
      terminalStart,
      await snapshotFixture(),
    );
    assert.equal(statusRefused.status, "unavailable");
    contains(statusRefused.detail ?? "", "command execution item");

    // A completion whose command no longer matches the recorded start.
    const wrongCommand = new ScriptedCodexSession();
    wrongCommand.plan = (scripted) => {
      scripted.emit("item/started", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "inProgress"),
      });
      scripted.emit("item/completed", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "completed", {
          command: "rg --no-heading -n withdrawal account.ts",
        }),
      });
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const commandRefused = await startReview(
      wrongCommand,
      await snapshotFixture(),
    );
    assert.equal(commandRefused.status, "unavailable");
    contains(commandRefused.detail ?? "", "command execution item");

    // A declined command is unavailable, never a settled read.
    const declined = new ScriptedCodexSession();
    declined.plan = (scripted) => {
      scripted.emit("item/started", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "inProgress"),
      });
      scripted.emit("item/completed", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "declined"),
      });
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const declinedRun = await startReview(declined, await snapshotFixture());
    assert.equal(declinedRun.status, "unavailable");
    contains(declinedRun.detail ?? "", "command execution item");

    // An ordinary failed read (for example no match) is a settled completion.
    const failedRead = new ScriptedCodexSession();
    failedRead.plan = (scripted) => {
      scripted.emit("item/started", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "inProgress"),
      });
      scripted.emit("item/completed", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "failed"),
      });
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-final",
          JSON.stringify(CLEAN_RESULT),
        ),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const failedReadRun = await startReview(
      failedRead,
      await snapshotFixture(),
    );
    assert.equal(failedReadRun.status, "clean");

    // A started command reported twice is contradictory.
    const duplicateStart = new ScriptedCodexSession();
    duplicateStart.plan = (scripted) => {
      const started = {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "inProgress"),
      };
      scripted.emit("item/started", started);
      scripted.emit("item/started", started);
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const duplicatedStart = await startReview(
      duplicateStart,
      await snapshotFixture(),
    );
    assert.equal(duplicatedStart.status, "unavailable");
    contains(duplicatedStart.detail ?? "", "contradictory");

    // A completed command reported twice is contradictory.
    const duplicate = new ScriptedCodexSession();
    duplicate.plan = (scripted) => {
      scripted.emit("item/started", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "inProgress"),
      });
      const completed = {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "completed"),
      };
      scripted.emit("item/completed", completed);
      scripted.emit("item/completed", completed);
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const contradictory = await startReview(duplicate, await snapshotFixture());
    assert.equal(contradictory.status, "unavailable");
    contains(contradictory.detail ?? "", "contradictory");

    // Terminal interaction and connection-scoped command telemetry are refused.
    const interaction = new ScriptedCodexSession();
    interaction.plan = (scripted) => {
      scripted.emit("item/commandExecution/terminalInteraction", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        itemId: "cmd-1",
        stdin: "y\n",
      });
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const interactionRun = await startReview(
      interaction,
      await snapshotFixture(),
    );
    assert.equal(interactionRun.status, "unavailable");
    contains(interactionRun.detail ?? "", "terminal interaction");

    const connectionScoped = new ScriptedCodexSession();
    connectionScoped.plan = (scripted) => {
      scripted.emit("command/exec/outputDelta", {
        processId: "p-1",
        delta: "x",
      });
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const connectionRun = await startReview(
      connectionScoped,
      await snapshotFixture(),
    );
    assert.equal(connectionRun.status, "unavailable");
    contains(connectionRun.detail ?? "", "connection-scoped");

    // A compacted context is fatal evidence.
    const compacted = new ScriptedCodexSession();
    compacted.plan = (scripted) => {
      scripted.emit("thread/compacted", { threadId: "thread-1" });
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-final",
          JSON.stringify(CLEAN_RESULT),
        ),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const compactedRun = await startReview(compacted, await snapshotFixture());
    assert.equal(compactedRun.status, "unavailable");
    contains(compactedRun.detail ?? "", "compacted");

    // An interrupted turn is never a clean review.
    const interrupted = new ScriptedCodexSession();
    interrupted.plan = (scripted) => {
      scripted.emit(
        "turn/completed",
        turnCompleted(scripted.turnId, "interrupted"),
      );
    };
    const interruptedRun = await startReview(
      interrupted,
      await snapshotFixture(),
    );
    assert.equal(interruptedRun.status, "unavailable");
    assert.equal(interruptedRun.actual?.observedTerminalStatus, "interrupted");
    assert.equal(interruptedRun.execution, null);
  },
);

Deno.test(
  "reviewer: no runtime terminal settles as a correlated host timeout",
  async () => {
    const session = new ScriptedCodexSession();
    const snapshot = await snapshotFixture();
    const now = Date.now();
    const reviewer = makeReviewer(session);
    const prepared = await reviewer.prepare(prepareRequest(snapshot, {
      latestStartAt: now + 60_000,
      settleBy: now + 240,
    }));
    if (!prepared.ok) assert.fail(prepared.error.detail);
    const review = prepared.value;
    const outcome = await review.start();
    if (!outcome.ok) assert.fail(outcome.error.detail);
    assert.equal(outcome.value.status, "unavailable");
    assert.equal(outcome.value.execution, null);
    assert.equal(outcome.value.actual?.terminalOrigin, "host-timeout");
    assert.equal(outcome.value.actual?.observedTerminalStatus, null);
    assert.equal(outcome.value.actual?.turnId, "turn-1");
    contains(outcome.value.detail ?? "", "terminal");
    contains(session.sent.join(","), "turn/interrupt");
  },
);

Deno.test(
  "reviewer: close is bounded, idempotent and invalidates corrupted completion",
  async () => {
    // Settlement uncertainty: a clean completion cannot survive an unsettled
    // close, and the second close reuses the single owned close.
    const uncertainSession = new ScriptedCodexSession();
    uncertainSession.plan = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-1", JSON.stringify(CLEAN_RESULT)),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const uncertainReviewer = makeReviewer(uncertainSession);
    const uncertainPrepared = await uncertainReviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!uncertainPrepared.ok) assert.fail(uncertainPrepared.error.detail);
    const uncertainRun = uncertainPrepared.value;
    const outcome = await uncertainRun.start();
    if (!outcome.ok) assert.fail(outcome.error.detail);
    assert.equal(outcome.value.status, "clean");

    uncertainSession.settled = false;
    const uncertain = await uncertainRun.close();
    assert.equal(uncertain.settled, false);
    assert.equal(uncertain.timedOut, false);
    const uncertainFinal = finalizeReviewCompletion(outcome, uncertain);
    assert.equal(uncertainFinal.ok, false, "unsettled close invalidates clean");
    assert.equal(uncertainSession.closed, 1);
    const again = await uncertainRun.close();
    assert.deepEqual(again, uncertain);
    assert.equal(uncertainSession.closed, 1);

    // Corrupt transport failure after completion invalidates it as well.
    const corruptSession = new ScriptedCodexSession();
    corruptSession.plan = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-1", JSON.stringify(CLEAN_RESULT)),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const corruptReviewer = makeReviewer(corruptSession);
    const corruptPrepared = await corruptReviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!corruptPrepared.ok) assert.fail(corruptPrepared.error.detail);
    const corruptRun = corruptPrepared.value;
    const corruptOutcome = await corruptRun.start();
    if (!corruptOutcome.ok) assert.fail(corruptOutcome.error.detail);
    corruptSession.failure = new CodexProtocolError(
      "stream_output_bound_exceeded",
      "raw transport detail that must not escape",
    );
    const corrupt = await corruptRun.close();
    assert.equal(corrupt.failure, "close_failed");
    assert.equal(
      JSON.stringify(corrupt).includes("raw transport detail"),
      false,
      "no raw transport detail escapes the sanitized close outcome",
    );
    const corruptFinal = finalizeReviewCompletion(corruptOutcome, corrupt);
    assert.equal(corruptFinal.ok, false);
    if (corruptFinal.ok) assert.fail("expected rejection");
    assert.equal(corruptFinal.error.kind, "unavailable");

    // A clean outcome with a clean close survives unchanged.
    const healthy = finalizeReviewCompletion(outcome, {
      settled: true,
      failure: null,
      timedOut: false,
    });
    assert.equal(healthy.ok, true);
  },
);

Deno.test(
  "reviewer: explicit host close during a run yields unavailable, never clean",
  async () => {
    const session = new ScriptedCodexSession();
    const snapshot = await snapshotFixture();
    const reviewer = makeReviewer(session);
    const prepared = await reviewer.prepare(prepareRequest(snapshot));
    if (!prepared.ok) assert.fail(prepared.error.detail);
    const review = prepared.value;
    const starting = review.start();
    const closed = await review.close();
    assert.equal(closed.settled, true);
    assert.equal(session.closed, 1);
    const outcome = await starting;
    if (!outcome.ok) assert.fail(outcome.error.detail);
    assert.equal(outcome.value.status, "unavailable");
    assert.equal(outcome.value.execution, null);
    contains(outcome.value.detail ?? "", "closed");

    // A bounded close that cannot settle reports uncertainty within a short
    // deadline instead of hanging.
    const hung = new ScriptedCodexSession();
    hung.closeHook = () => new Promise<void>(() => {});
    const hungReviewer = makeReviewer(hung);
    const hungNow = Date.now();
    const hungPrepared = await hungReviewer.prepare(prepareRequest(
      await snapshotFixture(),
      { latestStartAt: hungNow + 60_000, settleBy: hungNow + 150 },
    ));
    if (!hungPrepared.ok) assert.fail(hungPrepared.error.detail);
    const hungOutcome = await hungPrepared.value.close();
    assert.equal(hungOutcome.settled, false);
    assert.equal(hungOutcome.timedOut, true);
    assert.ok(Date.now() - hungNow < 5_000, "close must be bounded");

    // A close that fails outright is sanitized as a static marker.
    const throwing = new ScriptedCodexSession();
    throwing.closeHook = () => Promise.reject(new Error("raw close detail"));
    const throwingReviewer = makeReviewer(throwing);
    const throwingPrepared = await throwingReviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!throwingPrepared.ok) assert.fail(throwingPrepared.error.detail);
    const thrown = await throwingPrepared.value.close();
    assert.equal(thrown.settled, false);
    assert.equal(thrown.failure, "close_failed");
    assert.equal(thrown.timedOut, false);
    assert.equal(JSON.stringify(thrown).includes("raw close detail"), false);

    // Throwing settlement/failure probes are sanitized, never thrown.
    const probing = new ScriptedCodexSession();
    probing.isSettled = () => {
      throw new Error("raw isSettled detail");
    };
    probing.getFailure = () => {
      throw new Error("raw getFailure detail");
    };
    const probingReviewer = makeReviewer(probing);
    const probingPrepared = await probingReviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!probingPrepared.ok) assert.fail(probingPrepared.error.detail);
    const probed = await probingPrepared.value.close();
    assert.equal(probed.settled, false);
    assert.equal(probed.failure, "close_failed");
    assert.equal(probed.timedOut, false);
    assert.equal(
      JSON.stringify(probed).includes("raw isSettled detail"),
      false,
    );
    assert.equal(
      JSON.stringify(probed).includes("raw getFailure detail"),
      false,
    );

    // A throwing failure probe during completion is sanitized as well.
    const probingRun = new ScriptedCodexSession();
    probingRun.plan = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-1", JSON.stringify(CLEAN_RESULT)),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    probingRun.getFailure = () => {
      throw new Error("raw getFailure detail");
    };
    const probingRunReviewer = makeReviewer(probingRun);
    const probingRunPrepared = await probingRunReviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!probingRunPrepared.ok) assert.fail(probingRunPrepared.error.detail);
    const probingOutcome = await probingRunPrepared.value.start();
    if (!probingOutcome.ok) assert.fail(probingOutcome.error.detail);
    assert.equal(probingOutcome.value.status, "unavailable");
    contains(probingOutcome.value.detail ?? "", "fatal failure");
    await probingRunPrepared.value.close();
  },
);

Deno.test(
  "reviewer: short, elapsed and crossed deadlines reject before any start",
  async () => {
    const session = new ScriptedCodexSession();
    const snapshot = await snapshotFixture();
    const reviewer = makeReviewer(session);
    const now = Date.now();

    const expiredSettle = await reviewer.prepare(prepareRequest(snapshot, {
      latestStartAt: now + 10_000,
      settleBy: now - 1,
    }));
    assert.equal(expiredSettle.ok, false);
    const expiredStart = await reviewer.prepare(prepareRequest(snapshot, {
      latestStartAt: now - 1,
      settleBy: now + 10_000,
    }));
    assert.equal(expiredStart.ok, false);
    assert.equal(session.opened, 0, "no session is opened for bad deadlines");

    const crossed = await reviewer.prepare(prepareRequest(snapshot, {
      latestStartAt: Date.now() + 60,
      settleBy: Date.now() + 60_000,
    }));
    if (!crossed.ok) assert.fail(crossed.error.detail);
    await new Promise((resolve) => setTimeout(resolve, 90));
    const outcome = await crossed.value.start();
    assert.equal(outcome.ok, false, "a crossed latestStartAt must reject");
    if (outcome.ok) assert.fail("expected rejection");
    contains(outcome.error.detail, "latestStartAt");
    assert.equal(session.turnStarts(), 0);
    await crossed.value.close();
  },
);

Deno.test(
  "reviewer: digest, candidate-location and prepare-identity validation fail closed",
  async () => {
    const session = new ScriptedCodexSession();
    const reviewer = makeReviewer(session);
    const snapshot = await snapshotFixture();
    const tampered: ReviewSnapshotV1 = {
      ...snapshot,
      files: [{ ...snapshot.files[0], candidateLines: 99 }],
    };
    const digest = await reviewer.prepare(prepareRequest(tampered));
    assert.equal(digest.ok, false);
    if (digest.ok) assert.fail("expected rejection");
    contains(digest.error.detail, "digest");
    assert.equal(session.opened, 0);

    const badIdentity = await reviewer.prepare(
      prepareRequest(snapshot, { requestId: "" }),
    );
    assert.equal(badIdentity.ok, false);
    assert.equal(session.opened, 0);

    const withDeletion = await snapshotFixture({
      files: [
        {
          path: "account.ts",
          kind: "modified",
          oldBlob: "1".repeat(40),
          newBlob: "2".repeat(40),
          oldMode: "100644",
          newMode: "100644",
          candidateLines: 4,
        },
        {
          path: "gone.ts",
          kind: "deleted",
          oldBlob: "3".repeat(40),
          newBlob: "0".repeat(40),
          oldMode: "100644",
          newMode: "000000",
          candidateLines: null,
        },
      ],
    });
    const cases: { name: string; finding: Record<string, unknown> }[] = [
      {
        name: "invented path",
        finding: {
          priority: 1,
          title: "invented",
          body: "not a changed file",
          path: "other.ts",
          lineStart: 1,
          lineEnd: 1,
        },
      },
      {
        name: "deleted path",
        finding: {
          priority: 1,
          title: "deleted",
          body: "the file is gone in the candidate",
          path: "gone.ts",
          lineStart: 1,
          lineEnd: 1,
        },
      },
      {
        name: "out of range",
        finding: {
          priority: 1,
          title: "range",
          body: "beyond the candidate content",
          path: "account.ts",
          lineStart: 1,
          lineEnd: 99,
        },
      },
    ];
    for (const item of cases) {
      const result = JSON.stringify({
        verdict: "findings",
        summary: "location validation",
        findings: [item.finding],
      });
      const scripted = new ScriptedCodexSession();
      scripted.plan = (live) => {
        live.emit(
          "item/completed",
          agentMessage(live.turnId, "item-1", result),
        );
        live.emit("turn/completed", turnCompleted(live.turnId));
      };
      const outcome = await startReview(scripted, withDeletion);
      assert.equal(outcome.status, "unavailable", item.name);
      assert.equal(outcome.execution, null, item.name);
    }
  },
);

Deno.test(
  "reviewer: hanging initialize and thread/start never outlive the caller deadline",
  async () => {
    // An initialize response that never arrives.
    const hangingInit = new ScriptedCodexSession();
    hangingInit.hangMethods.add("initialize");
    const initNow = Date.now();
    const initPrepared = await makeReviewer(hangingInit).prepare(
      prepareRequest(await snapshotFixture(), {
        latestStartAt: initNow + 120,
        settleBy: initNow + 400,
      }),
    );
    assert.equal(initPrepared.ok, false);
    assert.ok(Date.now() - initNow < 5_000, "prepare must stay bounded");
    assert.equal(hangingInit.turnStarts(), 0);
    assert.equal(
      hangingInit.closed,
      1,
      "the owned session is closed in deadline",
    );

    // A thread/start response that never arrives.
    const hangingThread = new ScriptedCodexSession();
    hangingThread.hangMethods.add("thread/start");
    const threadNow = Date.now();
    const threadPrepared = await makeReviewer(hangingThread).prepare(
      prepareRequest(await snapshotFixture(), {
        latestStartAt: threadNow + 120,
        settleBy: threadNow + 400,
      }),
    );
    assert.equal(threadPrepared.ok, false);
    assert.ok(Date.now() - threadNow < 5_000, "prepare must stay bounded");
    assert.deepEqual(hangingThread.sent, ["initialize", "thread/start"]);
    assert.equal(hangingThread.turnStarts(), 0);
    assert.equal(hangingThread.closed, 1);

    // A response that crosses the absolute start gate.
    const crossing = new ScriptedCodexSession();
    crossing.sendDelayMs = { initialize: 80 };
    const crossNow = Date.now();
    const crossPrepared = await makeReviewer(crossing).prepare(
      prepareRequest(await snapshotFixture(), {
        latestStartAt: crossNow + 20,
        settleBy: crossNow + 400,
      }),
    );
    assert.equal(crossPrepared.ok, false);
    assert.ok(Date.now() - crossNow < 5_000, "prepare must stay bounded");
    assert.equal(crossing.turnStarts(), 0);
    assert.equal(crossing.closed, 1);
  },
);
