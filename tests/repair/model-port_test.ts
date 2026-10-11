/**
 * m04-repair model-port tests: the runtime ImplementationPort requests the
 * bounded isolated-checkout WRITE capability (workspace-write sandbox over
 * the secret-free checkout cwd, never read-only, never full access), still
 * refuses approvals, and produces a completed receipt with the resolved
 * candidate through an injected verifier/resolver. A trusted host committer
 * can turn model edits into a local candidate when the sandbox protects
 * `.git`. These capability and settlement cases use recording fake sessions.
 * The separate transport suite proves owned real-subprocess boundaries without
 * network or model calls.
 */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import type { ModelRunRequestV1 } from "../../src/contracts/ports.ts";
import {
  CodexImplementationPort,
  createRequestRuntimeReceiptVerifier,
  unavailableReceiptVerifier,
} from "../../src/repair/model-port.ts";
import type { ActualSessionEvidenceV1 } from "../../src/repair/model-port.ts";
import { REPO, SHA1, SHA3 } from "../state/helpers.ts";
import {
  CHECKOUT,
  FakeCodexSession,
  ReasoningStreamSession,
  runtimeRequest,
  ThrowingNotificationSession,
} from "./model-port-helpers.ts";

Deno.test(
  "model-port: custom verifier keeps the implementation port as its call receiver",
  async () => {
    const session = new FakeCodexSession();
    let receiver: unknown = null;
    let verifierCalls = 0;
    const port = new CodexImplementationPort({
      openSession: () => Promise.resolve(session),
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
      receiptVerifier: function (
        this: unknown,
        evidence: ActualSessionEvidenceV1,
      ) {
        receiver = this;
        verifierCalls++;
        return createRequestRuntimeReceiptVerifier("sentinel-host")(evidence);
      },
      checkout: {
        resolve: () =>
          Promise.resolve({
            head: SHA3,
            checkpointSha: null,
            changedPaths: ["src/app.ts"],
          }),
      },
    });
    const result = await port.runModel(runtimeRequest());
    assert.ok(result.ok, "the fake session produces a verified receipt");
    if (result.ok) assert.equal(result.value.outcome, "completed");
    assert.equal(verifierCalls, 1);
    assert.ok(
      receiver === port,
      "the original custom-verifier receiver is preserved",
    );
    assert.equal(session.closeCalls, 1);
  },
);

Deno.test("model-port: thread starts with bounded isolated-checkout write capability", async () => {
  const session = new FakeCodexSession();
  const verified: ActualSessionEvidenceV1[] = [];
  const port = new CodexImplementationPort({
    openSession: () => Promise.resolve(session),
    checkoutDir: CHECKOUT,
    checkout: {
      resolve: () =>
        Promise.resolve({
          head: SHA3,
          checkpointSha: null,
          changedPaths: ["src/app.ts"],
        }),
    },
    // A valid provider is required before any session opens; the custom
    // verifier below stays an ADDITIONAL restriction after the core checks.
    modelProvider: "sentinel-host",
    receiptVerifier: (evidence) => {
      verified.push(evidence);
      if (
        evidence.threadModel === "gpt-reserve" &&
        evidence.terminal.status === "completed"
      ) {
        return {
          provider: evidence.threadModelProvider ?? "sentinel-host",
          observedModel: "gpt-reserve",
          observedReasoning: "max",
        };
      }
      return null;
    },
  });

  const result = await port.runModel({
    taskId: asWorkItemId("issue-1"),
    repository: { ...REPO },
    base: SHA1,
    issue: { number: 1, title: "title", body: "body" },
    evidence: [],
    model: "gpt-reserve",
    reasoning: "max",
    maxDurationMs: 5_000,
    maxOutputChars: 10_000,
  });
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.value.outcome, "completed");
  assert.equal(result.value.candidate?.head, SHA3);
  assert.deepEqual(
    result.value.candidate?.changedPaths,
    ["src/app.ts"],
    "candidate comes from the isolated checkout resolver",
  );

  const threadStart = session.sent.find(
    (frame) => frame.method === "thread/start",
  );
  assert.ok(threadStart, "thread/start was sent");
  const params = threadStart?.params as Record<string, unknown>;
  // Bounded isolated-checkout write capability: the narrowest write-capable
  // sandbox, scoped to the checkout cwd — not read-only (a commit would be
  // impossible) and never full access.
  assert.equal(params.sandbox, "workspace-write");
  assert.equal(
    "permissions" in params,
    false,
    "an omitted permission profile keeps the legacy sandbox request",
  );
  const initialize = session.sent.find(
    (frame) => frame.method === "initialize",
  );
  assert.deepEqual(
    (initialize?.params as Record<string, unknown>).capabilities,
    {
      experimentalApi: false,
      requestAttestation: false,
      optOutNotificationMethods: [
        "item/reasoning/summaryTextDelta",
        "item/reasoning/summaryPartAdded",
        "item/reasoning/textDelta",
      ],
    },
    "an omitted permission profile keeps the legacy capabilities",
  );
  assert.equal(params.cwd, CHECKOUT, "write scope is the isolated checkout");
  assert.equal(params.approvalPolicy, "never");
  assert.equal(params.ephemeral, true);
  assert.equal(params.model, "gpt-reserve");
  assert.deepEqual(
    params.config,
    { model_reasoning_effort: "max" },
    "thread defaults are pinned to the requested runtime effort",
  );
  assert.equal(
    session.sent.some((frame) =>
      frame.method === "turn/start" &&
      (frame.params as Record<string, unknown>).effort === "max"
    ),
    true,
    "max reasoning is requested on the turn",
  );
  assert.equal(session.closeCalls, 1, "the session is always closed");
  assert.equal(
    session.openCalls,
    1,
    "the lazy session is opened at the model boundary",
  );
  assert.ok(
    verified.length === 1,
    "the trusted-host verifier observed the session evidence",
  );
});

Deno.test(
  "model-port: unused reasoning streams are opted out and stay non-output while the output bound still fails closed",
  async () => {
    const session = new ReasoningStreamSession(false);
    const port = new CodexImplementationPort({
      openSession: () => Promise.resolve(session),
      checkoutDir: CHECKOUT,
      checkout: {
        resolve: () =>
          Promise.resolve({
            head: SHA3,
            checkpointSha: null,
            changedPaths: ["src/app.ts"],
          }),
      },
      modelProvider: "sentinel-host",
    });
    const request: ModelRunRequestV1 = {
      taskId: asWorkItemId("issue-1"),
      repository: { ...REPO },
      base: SHA1,
      issue: { number: 1, title: "title", body: "body" },
      evidence: [],
      model: "gpt-reserve",
      reasoning: "max",
      maxDurationMs: 5_000,
      maxOutputChars: 10_000,
    };

    const result = await port.runModel(request);
    assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.value.outcome, "completed");
    assert.equal(result.value.candidate?.head, SHA3);
    assert.deepEqual(result.value.candidate?.changedPaths, ["src/app.ts"]);
    assert.equal(result.value.actual.evidenceKind, "request-runtime");
    assert.equal(result.value.actual.provider, "sentinel-host");
    assert.equal(result.value.actual.observedModel, "gpt-reserve");
    assert.equal(result.value.actual.observedReasoning, "max");
    assert.equal(result.value.actual.threadId, "thread-1");
    assert.equal(result.value.actual.turnId, "turn-1");
    assert.equal(result.value.actual.observedTerminalStatus, "completed");

    const initialize = session.sent.find(
      (frame) => frame.method === "initialize",
    );
    assert.ok(initialize, "initialize was sent");
    assert.deepEqual(
      (initialize?.params as Record<string, unknown>).capabilities,
      {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: [
          "item/reasoning/summaryTextDelta",
          "item/reasoning/summaryPartAdded",
          "item/reasoning/textDelta",
        ],
      },
      "the initialize request opts out of exactly the unused reasoning streams",
    );

    // Control: a server that ignores the opt-out and still streams over-bound
    // reasoning bytes is charged by the EXISTING output bound, which
    // interrupts the turn and permits no candidate.
    const breach = new ReasoningStreamSession(true);
    const breachPort = new CodexImplementationPort({
      openSession: () => Promise.resolve(breach),
      checkoutDir: CHECKOUT,
      checkout: {
        resolve: () =>
          Promise.resolve({
            head: SHA3,
            checkpointSha: null,
            changedPaths: ["src/app.ts"],
          }),
      },
      modelProvider: "sentinel-host",
    });
    const bounded = await breachPort.runModel({
      ...request,
      maxOutputChars: 512,
    });
    assert.ok(bounded.ok, JSON.stringify(bounded));
    if (!bounded.ok) return;
    assert.equal(bounded.value.outcome, "interrupted");
    assert.equal(bounded.value.candidate, null);
    assert.ok(
      bounded.value.actual.outputChars > 512,
      "ignored reasoning bytes are still charged against the output bound",
    );
    assert.equal(
      breach.sent.some((frame) => frame.method === "turn/interrupt"),
      true,
      "the existing output bound interrupts the turn",
    );
  },
);

Deno.test(
  "model-port: permission profile gates capabilities, thread permissions and exact acknowledgement",
  async () => {
    const session = new FakeCodexSession({ id: "sentinel-repair" });
    const port = new CodexImplementationPort({
      openSession: () => Promise.resolve(session),
      checkoutDir: CHECKOUT,
      checkout: {
        resolve: () =>
          Promise.resolve({
            head: SHA3,
            checkpointSha: null,
            changedPaths: ["src/app.ts"],
          }),
      },
      modelProvider: "sentinel-host",
      permissionProfile: "sentinel-repair",
    });

    const result = await port.runModel({
      taskId: asWorkItemId("issue-1"),
      repository: { ...REPO },
      base: SHA1,
      issue: { number: 1, title: "title", body: "body" },
      evidence: [],
      model: "gpt-reserve",
      reasoning: "max",
      maxDurationMs: 5_000,
      maxOutputChars: 10_000,
    });
    assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.value.outcome, "completed");

    const initialize = session.sent.find(
      (frame) => frame.method === "initialize",
    );
    assert.ok(initialize, "initialize was sent");
    assert.deepEqual(
      (initialize?.params as Record<string, unknown>).capabilities,
      {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [
          "item/reasoning/summaryTextDelta",
          "item/reasoning/summaryPartAdded",
          "item/reasoning/textDelta",
        ],
      },
      "experimental capabilities are enabled only for a configured profile",
    );
    const threadStart = session.sent.find(
      (frame) => frame.method === "thread/start",
    );
    assert.ok(threadStart, "thread/start was sent");
    const params = threadStart?.params as Record<string, unknown>;
    assert.equal(params.permissions, "sentinel-repair");
    assert.equal(
      "sandbox" in params,
      false,
      "the named profile replaces the legacy sandbox",
    );
    assert.equal(params.cwd, CHECKOUT);
    assert.equal(params.approvalPolicy, "never");
    const turnStart = session.sent.find(
      (frame) => frame.method === "turn/start",
    );
    assert.ok(turnStart, "turn/start was sent");
    const turnParams = turnStart?.params as Record<string, unknown>;
    assert.equal(
      "permissions" in turnParams,
      false,
      "the implementation turn inherits the thread profile",
    );
    assert.equal("sandboxPolicy" in turnParams, false);
    assert.equal(session.closeCalls, 1);
  },
);

Deno.test(
  "model-port: permission profile missing or wrong acknowledgement fails closed before any turn",
  async (t) => {
    const cases: [string, Record<string, unknown> | undefined][] = [
      ["missing", undefined],
      ["wrong", { id: "other-profile" }],
    ];
    for (const [label, ack] of cases) {
      await t.step(label, async () => {
        const session = ack === undefined
          ? new FakeCodexSession()
          : new FakeCodexSession(ack);
        const port = new CodexImplementationPort({
          openSession: () => Promise.resolve(session),
          checkoutDir: CHECKOUT,
          checkout: {
            resolve: () =>
              Promise.resolve({
                head: SHA3,
                checkpointSha: null,
                changedPaths: ["src/app.ts"],
              }),
          },
          modelProvider: "sentinel-host",
          permissionProfile: "sentinel-repair",
        });
        const result = await port.runModel({
          taskId: asWorkItemId("issue-1"),
          repository: { ...REPO },
          base: SHA1,
          issue: { number: 1, title: "title", body: "body" },
          evidence: [],
          model: "gpt-reserve",
          reasoning: "max",
          maxDurationMs: 5_000,
          maxOutputChars: 10_000,
        });
        assert.equal(
          result.ok,
          false,
          `${label} acknowledgement must fail closed`,
        );
        if (result.ok) return;
        assert.equal(result.error.kind, "unavailable");
        assert.equal(
          session.sent.some((frame) => frame.method === "turn/start"),
          false,
          "no turn starts without the exact acknowledgement",
        );
        assert.equal(session.closeCalls, 1, "the owned session settles");
      });
    }
  },
);

Deno.test(
  "model-port: invalid permission profile opens no session",
  async (t) => {
    const invalidProfiles = [
      "",
      "1bad",
      "bad profile",
      "a".repeat(65),
      "danger-full-access",
      "full-access",
    ];
    for (const profile of invalidProfiles) {
      await t.step(JSON.stringify(profile), async () => {
        const session = new FakeCodexSession({ id: profile });
        let opened = 0;
        const port = new CodexImplementationPort({
          openSession: () => {
            opened++;
            return Promise.resolve(session);
          },
          checkoutDir: CHECKOUT,
          modelProvider: "sentinel-host",
          permissionProfile: profile,
        });
        const result = await port.runModel({
          taskId: asWorkItemId("issue-1"),
          repository: { ...REPO },
          base: SHA1,
          issue: { number: 1, title: "title", body: "body" },
          evidence: [],
          model: "gpt-reserve",
          reasoning: "max",
          maxDurationMs: 5_000,
          maxOutputChars: 10_000,
        });
        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.error.kind, "unavailable");
        assert.equal(opened, 0, "no session opens for an invalid profile");
        assert.equal(session.sent.length, 0);
      });
    }
  },
);

Deno.test(
  "model-port: candidate commit waits for model session settlement",
  async () => {
    const session = new FakeCodexSession();
    let commitObservedClosed = false;
    const port = new CodexImplementationPort({
      openSession: () => Promise.resolve(session),
      checkoutDir: CHECKOUT,
      checkout: {
        resolve: () =>
          Promise.resolve({
            head: SHA3,
            checkpointSha: null,
            changedPaths: ["src/app.ts"],
          }),
      },
      commitCandidate: {
        commit: () => {
          commitObservedClosed = session.closed;
          return Promise.resolve(true);
        },
      },
      modelProvider: "sentinel-host",
      receiptVerifier: () => ({
        provider: "sentinel-host",
        observedModel: "gpt-reserve",
        observedReasoning: "max",
      }),
    });
    const result = await port.runModel({
      taskId: asWorkItemId("issue-commit-order"),
      repository: { ...REPO },
      base: SHA1,
      issue: null,
      evidence: [],
      model: "gpt-reserve",
      reasoning: "max",
      maxDurationMs: 5_000,
      maxOutputChars: 10_000,
    });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(commitObservedClosed, true);
    assert.equal(session.closeCalls, 1);
  },
);

Deno.test(
  "model-port: notification registration failure clears settlement timers and stays unavailable",
  async () => {
    const session = new ThrowingNotificationSession();
    const port = new CodexImplementationPort({
      openSession: () => Promise.resolve(session),
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
      receiptVerifier: () => ({
        provider: "sentinel-host",
        observedModel: "gpt-reserve",
        observedReasoning: "max",
      }),
    });
    const started = performance.now();
    const result = await port.runModel({
      taskId: asWorkItemId("issue-notification-registration"),
      repository: { ...REPO },
      base: SHA1,
      issue: null,
      evidence: [],
      model: "gpt-reserve",
      reasoning: "max",
      maxDurationMs: 2_000,
      maxOutputChars: 10_000,
    });
    // Notification registration failure is protocol uncertainty: the sticky
    // unavailable disposition returns unavailable (never a certifiable failed
    // runtime receipt — the custom verifier is never reached without concrete
    // request/runtime evidence).
    assert.ok(!result.ok, JSON.stringify(result));
    if (!result.ok) {
      assert.equal(result.error.kind, "unavailable");
      assert.equal(result.error.detail, "notification registration failed");
    }
    assert.equal(session.closeCalls, 1);
    assert.ok(
      performance.now() - started < 500,
      "registration failure must settle without waiting for the duration timer",
    );
  },
);

Deno.test(
  "model-port: unavailable verifier fails closed before any session opens",
  async () => {
    const request: ModelRunRequestV1 = {
      taskId: asWorkItemId("issue-3"),
      repository: { ...REPO },
      base: SHA1,
      issue: null,
      evidence: [],
      model: "gpt-reserve",
      reasoning: "max",
      maxDurationMs: 5_000,
      maxOutputChars: 10_000,
    };
    // Neither an absent nor the exported unavailable verifier may cause any
    // session (or other model work) to begin: the existing typed unavailable
    // result is returned before openSession is ever invoked. Without an
    // explicit modelProvider no session may open even with a verifier.
    for (const supplied of [undefined, unavailableReceiptVerifier]) {
      let opened = 0;
      const port = new CodexImplementationPort({
        openSession: () => {
          opened++;
          throw new Error("no session may open without a certifying verifier");
        },
        checkoutDir: CHECKOUT,
        receiptVerifier: supplied,
      });
      const result = await port.runModel(request);
      assert.ok(!result.ok, JSON.stringify(result));
      if (!result.ok) {
        assert.equal(result.error.kind, "unavailable");
        assert.equal(
          result.error.detail,
          "model receipt unavailable: actual provider model/effort could not be verified at this boundary",
        );
      }
      assert.equal(
        opened,
        0,
        "no session opens and no model work begins without a configured verifier",
      );
    }
  },
);

Deno.test("model-port: a missing trusted receipt fails closed and still closes the session", async () => {
  const session = new FakeCodexSession();
  const port = new CodexImplementationPort({
    openSession: () => Promise.resolve(session),
    checkoutDir: CHECKOUT,
    modelProvider: "sentinel-host",
    checkout: {
      resolve: () =>
        Promise.resolve({ head: SHA3, checkpointSha: null, changedPaths: [] }),
    },
    receiptVerifier: () => null, // additional restriction: activation unresolved
  });
  const result = await port.runModel({
    taskId: asWorkItemId("issue-2"),
    repository: { ...REPO },
    base: SHA1,
    issue: null,
    evidence: [],
    model: "gpt-reserve",
    reasoning: "max",
    maxDurationMs: 5_000,
    maxOutputChars: 10_000,
  });
  assert.ok(!result.ok);
  if (!result.ok) assert.equal(result.error.kind, "unavailable");
  assert.equal(
    session.closeCalls,
    1,
    "fail-closed run still settles the session",
  );
});

Deno.test(
  "model-port: a base checkout never becomes a candidate without a commit",
  async () => {
    const session = new FakeCodexSession();
    const port = new CodexImplementationPort({
      openSession: () => Promise.resolve(session),
      checkoutDir: CHECKOUT,
      checkout: {
        resolve: () =>
          Promise.resolve({
            head: SHA1,
            checkpointSha: null,
            changedPaths: [],
          }),
      },
      modelProvider: "sentinel-host",
      receiptVerifier: () => ({
        provider: "sentinel-host",
        observedModel: "gpt-reserve",
        observedReasoning: "max",
      }),
    });
    const result = await port.runModel({
      taskId: asWorkItemId("issue-no-commit"),
      repository: { ...REPO },
      base: SHA1,
      issue: null,
      evidence: [],
      model: "gpt-reserve",
      reasoning: "max",
      maxDurationMs: 5_000,
      maxOutputChars: 10_000,
    });
    assert.ok(result.ok, JSON.stringify(result));
    if (result.ok) {
      assert.equal(result.value.outcome, "completed");
      assert.equal(result.value.candidate, null);
    }
  },
);
