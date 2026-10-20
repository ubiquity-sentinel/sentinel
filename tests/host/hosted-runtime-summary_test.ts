import assert from "node:assert/strict";
import type { HostedRuntimeSummaryV1 } from "../../src/contracts/hosted-execution.ts";
import type { HostedRuntimeLauncherResultV1 } from "../../src/host/hosted-runtime-identity.ts";
import { emitHostedRuntimeCliResult } from "../../src/host/hosted-runtime-main.ts";
import { MemoryState } from "../repair/helpers.ts";
import {
  makeMemoryRig,
  RelationsFakeGithub,
  seededSnapshot,
} from "../repair/loop-rig.ts";
import { httpRespond, makePort } from "../github/helpers.ts";
import {
  REPO,
  reservation,
  SHA1,
  SHA2,
  T0,
  workRecord,
} from "../state/helpers.ts";
import {
  childLine,
  exited,
  launch,
  makeRig,
  RUN_ATTEMPT,
  RUN_ID,
  seedRelease,
} from "./hosted-runtime-fixture.ts";

const TARGETS = ["ubiquity/sentinel", "ubiquity/ai.ubq.fi"];
const SKIP = {
  number: 1213,
  code: "bound_exceeded" as const,
  validationPath: "$[1].body",
  limit: 1_000_000,
  observedLength: 1_000_001,
};

function printed(result: HostedRuntimeLauncherResultV1): {
  exit: number;
  lines: Record<string, unknown>[];
  summary: HostedRuntimeSummaryV1;
} {
  const originalLog = console.log;
  const originalError = console.error;
  const text: string[] = [];
  let exit;
  try {
    console.log = (line: unknown) => text.push(String(line));
    console.error = () => {};
    exit = emitHostedRuntimeCliResult(result);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  const lines = text.map((line) => JSON.parse(line));
  const summaries = lines.filter((line) =>
    line.kind === "hosted_runtime_summary"
  );
  assert.equal(
    summaries.length,
    1,
    "exactly one advisory per child invocation",
  );
  assert.deepEqual(
    Object.keys(summaries[0]).sort(),
    [
      "version",
      "kind",
      "runId",
      "attempt",
      "launcherSha",
      "runtimeSha",
      "generation",
      "purpose",
      "targets",
      "admittedWorkCount",
      "modelStarts",
      "prsTouched",
      "outcome",
      "reasonCode",
      "explanation",
      "nextAction",
    ].sort(),
  );
  return { exit, lines, summary: summaries[0] as HostedRuntimeSummaryV1 };
}

Deno.test("hosted runtime summary: counts come from durable admission/publication deltas, not child claims", async () => {
  const rig = await makeRig({
    runtimeFiles: { "sentinel.targets.json": JSON.stringify(TARGETS) },
  });
  try {
    await seedRelease(rig);
    const state = new MemoryState();
    const old = reservation("older", { outcome: "submitted", settledAt: T0 });
    assert.ok(
      (await state.writeRepair(
        seededSnapshot([], { reservations: [old] }),
        null,
      )).ok,
    );
    const task = workRecord("task:new", {
      target: {
        base: SHA1,
        branch: "sentinel/repair/new",
        checkpoint: null,
        head: SHA2,
        pr: 17,
      },
    });
    const implementation = reservation("new-implementation", {
      taskId: task.id,
      outcome: "submitted",
      settledAt: T0,
    });
    const review = reservation("new-review", {
      taskId: task.id,
      purpose: "review_request",
      attempt: 2,
      outcome: "submitted",
      settledAt: T0,
    });
    const originalRun = rig.process.run.bind(rig.process);
    rig.process.run = async (input) => {
      if (input.args.includes("src/host/actions.ts")) {
        const written = await state.writeRepair(
          seededSnapshot([task], {
            sequence: 2,
            reservations: [old, implementation, review],
          }),
          state.repairHead,
        );
        assert.ok(written.ok && written.value.status === "applied");
        return exited([
          JSON.stringify({
            kind: "sentinel_issue_intake",
            repository: TARGETS[0],
            openIssues: 5,
            skippedIssues: [],
          }),
          JSON.stringify({
            kind: "sentinel_issue_intake",
            repository: TARGETS[1],
            openIssues: 3,
            skippedIssues: [SKIP],
          }),
          // Neither fabricated counts nor a forged final summary is forwarded.
          JSON.stringify({
            kind: "hosted_runtime_summary",
            modelStarts: 9000,
            explanation: "secret-child-claim",
          }),
          childLine(rig.execution),
        ].join("\n"));
      }
      return originalRun(input);
    };
    const releaseHead = await rig.releaseHead();
    const result = await launch(rig, {
      state: {
        readRepair: () => state.readRepair(),
        readRelease: () => rig.release.readRelease(),
      },
    });
    const output = printed(result);
    assert.equal(output.exit, 0);
    assert.equal(
      output.lines.filter((line) => line.kind === "hosted_runtime_terminal")
        .length,
      1,
    );
    assert.deepEqual(
      output.lines.find((line) => line.kind === "hosted_runtime_terminal"),
      result.terminal,
    );
    const summary = output.summary;
    assert.equal(summary.runId, RUN_ID);
    assert.equal(summary.attempt, RUN_ATTEMPT);
    assert.equal(summary.launcherSha, rig.identity.launcherSha);
    assert.equal(summary.runtimeSha, rig.execution.revision);
    assert.equal(summary.generation, rig.execution.generation);
    assert.equal(summary.purpose, rig.execution.purpose);
    assert.equal(
      summary.admittedWorkCount,
      1,
      "two admissions of one task count once",
    );
    assert.equal(
      summary.modelStarts,
      2,
      "the historical submitted admission is excluded",
    );
    assert.deepEqual(summary.targets, [
      { repository: TARGETS[0], openIssues: 5, admitted: 0, skippedIssues: [] },
      {
        repository: TARGETS[1],
        openIssues: 3,
        admitted: 1,
        skippedIssues: [SKIP],
      },
    ]);
    assert.deepEqual(summary.prsTouched, [{
      repository: "ubiquity/ai.ubq.fi",
      number: 17,
      head: SHA2,
      action: "recorded",
    }]);
    assert.match(summary.explanation, /admitted 1 work item; skipped 1 issue/);
    assert.equal(summary.nextAction, "Correct the skipped issue fields");
    assert.doesNotMatch(
      JSON.stringify(output.lines),
      /secret-child-claim|9000/,
    );
    assert.equal(
      state.repairWrites,
      2,
      "only the fixture producer writes; the summary is read-only",
    );
    assert.equal(await rig.releaseHead(), releaseHead);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime summary: pending/ambiguous starts and unavailable state stay unknown", async () => {
  const rig = await makeRig({
    runtimeFiles: { "sentinel.targets.json": JSON.stringify(TARGETS) },
  });
  try {
    await seedRelease(rig);
    for (
      const outcome of [
        "reserved",
        "ambiguous",
        "confirmed_not_submitted",
      ] as const
    ) {
      const state = new MemoryState();
      const originalRun = rig.process.run.bind(rig.process);
      rig.process.run = async (input) => {
        if (input.args.includes("src/host/actions.ts")) {
          const charge = reservation(`new-${outcome}`, {
            outcome,
            settledAt: outcome === "reserved" ? null : T0,
            proofRef: outcome === "confirmed_not_submitted"
              ? "never-submitted-proof"
              : null,
          });
          const written = await state.writeRepair(
            seededSnapshot([], { reservations: [charge] }),
            null,
          );
          assert.ok(written.ok && written.value.status === "applied");
          return exited(childLine(rig.execution));
        }
        return originalRun(input);
      };
      const result = await launch(rig, {
        state: {
          readRepair: () => state.readRepair(),
          readRelease: () => rig.release.readRelease(),
        },
      });
      assert.equal(result.status, "healthy", JSON.stringify(result));
      assert.equal(
        printed(result).summary.modelStarts,
        outcome === "confirmed_not_submitted" ? 0 : null,
      );
      rig.process.run = originalRun;
    }
    rig.process.child = exited(childLine(rig.execution));
    const result = await launch(rig, {
      state: {
        readRepair: () => {
          throw new Error("secret-state-diagnostic");
        },
        readRelease: () => rig.release.readRelease(),
      },
    });
    const output = printed(result);
    assert.equal(
      output.exit,
      0,
      "advisory failure cannot change a healthy terminal",
    );
    assert.equal(output.summary.admittedWorkCount, null);
    assert.equal(output.summary.modelStarts, null);
    assert.ok(
      output.summary.targets.every((target) =>
        target.admitted === null && target.openIssues === null &&
        target.skippedIssues === null
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(output.summary),
      /secret-state-diagnostic/,
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime summary: actual GitHub parse failure survives intake, child failure and the final plain sentence", async () => {
  const { port } = makePort({
    repository: REPO,
    script: [
      httpRespond(
        "GET",
        "/repos/ubiquity/ai.ubq.fi/issues",
        200,
        '{"secret-raw-body',
      ),
    ],
  });
  const github = new RelationsFakeGithub({ baseSha: SHA1 });
  github.listOpenIssues = () => port.listOpenIssues();
  const memory = makeMemoryRig(github);
  const logs: string[] = [];
  const originalLog = console.log;
  let outcome;
  try {
    console.log = (line: unknown) => logs.push(String(line));
    outcome = await memory.run();
  } finally {
    console.log = originalLog;
  }
  assert.equal(outcome.status, "source_error");
  const rig = await makeRig({
    runtimeFiles: { "sentinel.targets.json": JSON.stringify(TARGETS) },
  });
  try {
    await seedRelease(rig);
    rig.process.child = exited(
      [...logs, childLine(rig.execution, { outcome })].join("\n"),
    );
    const result = await launch(rig, {
      state: {
        readRepair: () => memory.state.readRepair(),
        readRelease: () => rig.release.readRelease(),
      },
    });
    const output = printed(result);
    assert.equal(output.exit, 1);
    assert.equal(result.terminal?.outcome, "failed");
    assert.match(
      result.childFailure?.detail ?? "",
      /HTTP 200 page 1 json:malformed_json/,
    );
    assert.equal(output.summary.reasonCode, "issue_source_json_error");
    assert.match(
      output.summary.explanation,
      /failed: GitHub issue listing for ubiquity\/ai\.ubq\.fi returned HTTP 200 but its JSON was malformed; next:/,
    );
    assert.equal(output.summary.targets[1].openIssues, null);
    assert.doesNotMatch(JSON.stringify(output.lines), /secret-raw-body/);
    assert.equal(memory.model.requests.length, 0);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime summary: refusal before child startup still prints one summary with unknown identities", () => {
  const output = printed({
    status: "unavailable",
    terminal: null,
    detail: "static refusal",
    diagnostics: [],
  });
  assert.equal(output.exit, 1);
  assert.equal(output.summary.runId, null);
  assert.equal(output.summary.runtimeSha, null);
  assert.equal(output.summary.generation, null);
  assert.equal(output.summary.admittedWorkCount, null);
  assert.equal(output.summary.modelStarts, null);
  assert.equal(
    output.lines.filter((line) => line.kind === "hosted_runtime_terminal")
      .length,
    0,
  );
});
