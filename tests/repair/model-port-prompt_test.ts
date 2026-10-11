/** Cohesive prompt cases for the unchanged model-port facade. */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import { CodexImplementationPort } from "../../src/repair/model-port.ts";
import { REPO, SHA1, SHA3 } from "../state/helpers.ts";
import { CHECKOUT, FakeCodexSession } from "./model-port-helpers.ts";

Deno.test(
  "runtime prompt: a correction carries the exact unresolved review findings",
  async () => {
    const session = new FakeCodexSession();
    const port = new CodexImplementationPort({
      openSession: () => Promise.resolve(session),
      checkoutDir: CHECKOUT,
      checkout: {
        resolve: () =>
          Promise.resolve({
            head: SHA3,
            checkpointSha: null,
            changedPaths: ["src/github/text.ts"],
          }),
      },
      modelProvider: "sentinel-host",
    });
    const result = await port.runModel({
      taskId: asWorkItemId("issue-1"),
      repository: { ...REPO },
      base: SHA1,
      checkoutBase: SHA3,
      issue: { number: 48, title: "title", body: "body" },
      evidence: [{ kind: "review_receipt", ref: "artifact:x" }],
      reviewFindings: [
        {
          severity: "P2",
          path: "src/github/text.ts",
          message: "Colon-separated matching corrupts URL queries.",
        },
        { severity: "P1", path: null, message: "Second finding." },
      ],
      model: "gpt-reserve",
      reasoning: "max",
      maxDurationMs: 5_000,
      maxOutputChars: 12_345,
    });
    assert.ok(result.ok, JSON.stringify(result));
    const threadStart = session.sent.find(
      (frame) => frame.method === "thread/start",
    );
    const prompt = JSON.stringify(threadStart?.params ?? {});
    assert.ok(
      prompt.includes("Unresolved findings of the review that rejected"),
      "the correction prompt names the rejection",
    );
    assert.ok(prompt.includes("[P2] src/github/text.ts"));
    assert.ok(
      prompt.includes("Colon-separated matching corrupts URL queries."),
    );
    assert.ok(prompt.includes("[P1] (no file)"));
  },
);

Deno.test(
  "runtime prompt: cross-task repository lessons are rendered as shared context",
  async () => {
    const session = new FakeCodexSession();
    const port = new CodexImplementationPort({
      openSession: () => Promise.resolve(session),
      checkoutDir: CHECKOUT,
      checkout: {
        resolve: () =>
          Promise.resolve({
            head: SHA3,
            checkpointSha: null,
            changedPaths: ["src/github/text.ts"],
          }),
      },
      modelProvider: "sentinel-host",
    });
    const result = await port.runModel({
      taskId: asWorkItemId("issue-1"),
      repository: { ...REPO },
      base: SHA1,
      issue: { number: 48, title: "title", body: "body" },
      evidence: [],
      repositoryLessons: [
        {
          detail: "failed_command_loop",
          stage: "model",
          failureClass: "semantic_no_progress",
          count: 3,
          lastAtMs: 1786000001000,
        },
      ],
      model: "gpt-reserve",
      reasoning: "max",
      maxDurationMs: 5_000,
      maxOutputChars: 12_345,
    });
    assert.ok(result.ok, JSON.stringify(result));
    const threadStart = session.sent.find(
      (frame) => frame.method === "thread/start",
    );
    const prompt = JSON.stringify(threadStart?.params ?? {});
    assert.ok(prompt.includes("RECENT FAILURES ELSEWHERE IN THIS REPOSITORY"));
    assert.ok(prompt.includes("failed_command_loop"));
    assert.ok(prompt.includes("3 recorded outcomes"));
  },
);

Deno.test(
  "runtime prompt: versioned regressions are rendered as a regression signal",
  async () => {
    const session = new FakeCodexSession();
    const port = new CodexImplementationPort({
      openSession: () => Promise.resolve(session),
      checkoutDir: CHECKOUT,
      checkout: {
        resolve: () =>
          Promise.resolve({
            head: SHA3,
            checkpointSha: null,
            changedPaths: ["src/github/text.ts"],
          }),
      },
      modelProvider: "sentinel-host",
    });
    const result = await port.runModel({
      taskId: asWorkItemId("issue-1"),
      repository: { ...REPO },
      base: SHA1,
      issue: { number: 48, title: "title", body: "body" },
      evidence: [],
      regressions: [
        {
          detail: "model run did not complete with a trusted candidate",
          priorSuccessRevision: SHA3,
          priorSuccessAtMs: 1786000001000,
          failuresAtCurrentRevision: 2,
          lastFailureAtMs: 1786000009000,
        },
      ],
      model: "gpt-reserve",
      reasoning: "max",
      maxDurationMs: 5_000,
      maxOutputChars: 12_345,
    });
    assert.ok(result.ok, JSON.stringify(result));
    const threadStart = session.sent.find(
      (frame) => frame.method === "thread/start",
    );
    const prompt = JSON.stringify(threadStart?.params ?? {});
    assert.ok(prompt.includes("REGRESSION SIGNAL"));
    assert.ok(prompt.includes("worked before, broken now"));
    assert.ok(prompt.includes("version-controlled"));
    assert.ok(prompt.includes("restoring or aligning"));
    assert.ok(prompt.includes("2 recorded failures now"));
    assert.ok(prompt.includes(String(SHA3)));
  },
);

Deno.test(
  "runtime prompt: verified prior attempts are rendered as an already-tried section",
  async () => {
    const session = new FakeCodexSession();
    const port = new CodexImplementationPort({
      openSession: () => Promise.resolve(session),
      checkoutDir: CHECKOUT,
      checkout: {
        resolve: () =>
          Promise.resolve({
            head: SHA3,
            checkpointSha: null,
            changedPaths: ["src/github/text.ts"],
          }),
      },
      modelProvider: "sentinel-host",
    });
    const result = await port.runModel({
      taskId: asWorkItemId("issue-1"),
      repository: { ...REPO },
      base: SHA1,
      issue: { number: 48, title: "title", body: "body" },
      evidence: [],
      priorAttempts: [
        {
          detail: "model run did not complete with a trusted candidate",
          stage: "model",
          failureClass: "semantic_no_progress",
          count: 2,
          lastAtMs: 1786000001000,
        },
        {
          detail: "failed_command_loop",
          stage: "model",
          failureClass: "semantic_no_progress",
          count: 1,
          lastAtMs: 1786000002000,
        },
      ],
      model: "gpt-reserve",
      reasoning: "max",
      maxDurationMs: 5_000,
      maxOutputChars: 12_345,
    });
    assert.ok(result.ok, JSON.stringify(result));
    const threadStart = session.sent.find(
      (frame) => frame.method === "thread/start",
    );
    const prompt = JSON.stringify(threadStart?.params ?? {});
    assert.ok(
      prompt.includes("ALREADY TRIED"),
      "the prior-attempt section is rendered",
    );
    assert.ok(
      prompt.includes("model run did not complete with a trusted candidate"),
    );
    assert.ok(prompt.includes("2 recorded outcomes"));
    assert.ok(prompt.includes("failed_command_loop"));
    assert.ok(prompt.includes("1 recorded outcome)"));
  },
);

Deno.test(
  "runtime prompt: an implementation without findings carries no rejection text",
  async () => {
    const session = new FakeCodexSession();
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
    await port.runModel({
      taskId: asWorkItemId("issue-1"),
      repository: { ...REPO },
      base: SHA1,
      issue: { number: 1, title: "title", body: "body" },
      evidence: [],
      model: "gpt-reserve",
      reasoning: "max",
      maxDurationMs: 5_000,
      maxOutputChars: 12_345,
    });
    const threadStart = session.sent.find(
      (frame) => frame.method === "thread/start",
    );
    assert.equal(
      JSON.stringify(threadStart?.params ?? {}).includes(
        "Unresolved findings of the review",
      ),
      false,
    );
  },
);

Deno.test(
  "runtime prompt: thread/start and turn/start carry the runtime implementer role and request bounds",
  async () => {
    const session = new FakeCodexSession();
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

    const result = await port.runModel({
      taskId: asWorkItemId("issue-1"),
      repository: { ...REPO },
      base: SHA1,
      issue: { number: 1, title: "title", body: "body" },
      evidence: [],
      model: "gpt-reserve",
      reasoning: "max",
      maxDurationMs: 5_000,
      maxOutputChars: 12_345,
    });
    assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.value.outcome, "completed");

    // The assertions read the ACTUAL session frames: the prompt is the real
    // thread/turn payload used by the runtime, not a helper-only echo.
    const threadStart = session.sent.find(
      (frame) => frame.method === "thread/start",
    );
    const turnStart = session.sent.find(
      (frame) => frame.method === "turn/start",
    );
    assert.ok(threadStart, "thread/start was sent");
    assert.ok(turnStart, "turn/start was sent");
    const baseInstructions = (threadStart?.params as Record<string, unknown>)
      .baseInstructions;
    assert.equal(typeof baseInstructions, "string");
    const turnInput = (turnStart?.params as Record<string, unknown>).input as
      | { type?: unknown; text?: unknown }[]
      | undefined;
    assert.equal(turnInput?.[0]?.type, "text");
    assert.equal(
      turnInput?.[0]?.text,
      baseInstructions,
      "the same runtime prompt is submitted on thread/start and turn/start",
    );

    const prompt = (baseInstructions as string).toLowerCase();
    for (
      const required of [
        "runtime implementer role",
        "edit only the current provided checkout",
        "do not run git add, git commit or git push",
        "worktrees",
        "delegate",
        "the trusted host owns commits, pushes, review and release",
        "do not take over master-plan orchestration",
        "protected paths",
        "credentials",
        "expected test assertions",
        "gpt-reserve",
        "max reasoning",
        "total event output allowance is 12345 characters",
        "every tool notification counts against it",
        "repeated full output is charged again",
        "max_output_tokens at or below 2000",
        "targeted symbol searches followed by excerpts of at most 100 lines",
        "read the applicable instructions only once",
        "never repeat a full file read",
        "check the actual failure instead of retrying",
        "stop broad source surveying",
        "smallest edit",
        "reserve most of the allowance for implementation and focused validation",
        "necessary source context",
        "keep individual command output bounded",
        "never dump docs/build-status.md in full",
        "bounded matching sections",
        "concise final response",
      ]
    ) {
      assert.ok(
        prompt.includes(required),
        `runtime prompt carries: ${required}`,
      );
    }
    assert.equal(
      prompt.includes("439 kb"),
      false,
      "the stale hardcoded build-status size is gone",
    );
    assert.equal(
      prompt.includes("minimal commit"),
      false,
      "the obsolete commit-production instruction is gone",
    );
  },
);
