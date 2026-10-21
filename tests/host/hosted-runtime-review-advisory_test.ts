/** A refused reviewer command item is an advisory line, never a second child record. */
import assert from "node:assert/strict";
import {
  commandItem,
  makeReviewer,
  prepareRequest,
  ScriptedCodexSession,
  snapshotFixture,
  startReview,
  turnCompleted,
} from "../github/codex-reviewer-helpers.ts";
import { emitHostedRuntimeCliResult } from "../../src/host/hosted-runtime.ts";
import type { HostedRuntimeLauncherResultV1 } from "../../src/host/hosted-runtime.ts";
import {
  childLine,
  exited,
  launch,
  makeRig,
  OBSERVED_BASE,
  seedRelease,
} from "./hosted-runtime-fixture.ts";

/**
 * Drive the real reviewer through one refused command start (a cwd other than
 * the trusted session cwd, as live repair runs report) and return exactly the
 * stdout lines it printed. Binding the launcher test to the emitter keeps the
 * exemption honest if the runtime line ever changes shape.
 */
async function refusedCommandItemLines(
  method = "item/started",
  item: Record<string, unknown> = commandItem("cmd-1", "inProgress", {
    cwd: "/tmp/other-checkout",
  }),
): Promise<string[]> {
  const session = new ScriptedCodexSession();
  session.plan = (scripted) => {
    scripted.emit(method, {
      threadId: "thread-1",
      turnId: scripted.turnId,
      item,
    });
    scripted.emit("turn/completed", turnCompleted(scripted.turnId));
  };
  const printed: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  };
  try {
    const outcome = await startReview(session, await snapshotFixture());
    assert.equal(outcome.status, "unavailable");
  } finally {
    console.log = original;
  }
  const refused = printed.filter((line) =>
    line.includes('"sentinel_review_command_item_refused"')
  );
  assert.equal(refused.length, 1, printed.join("\n"));
  // The live line carries an own `status` (the observed item status).
  assert.equal(Object.hasOwn(JSON.parse(refused[0]), "status"), true);
  return refused;
}

Deno.test("hosted runtime: a refused reviewer command item beside the child record still settles healthy", async () => {
  const [refused] = await refusedCommandItemLines();
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const healthy = childLine(rig.execution);
    for (
      const stdout of [
        `${refused}\n${healthy}\n`,
        `${healthy}\n${refused}\n`,
        `${refused}\n${refused}\n${healthy}\n`,
      ]
    ) {
      rig.process.child = exited(stdout, 0);
      const result = await launch(rig);
      assert.equal(result.status, "healthy", stdout);
      assert.equal(result.terminal?.outcome, "healthy");
      assert.equal(result.terminal?.baseSha, OBSERVED_BASE);
    }

    // The exemption is exact: the same event with any other key set, or any
    // other status-bearing line, is still an uncertain second record.
    const parsed = JSON.parse(refused) as Record<string, unknown>;
    const { knownItem: _dropped, ...missingKey } = parsed;
    for (
      const line of [
        JSON.stringify({ ...parsed, outcome: { status: "idle" } }),
        JSON.stringify(missingKey),
        JSON.stringify({ ...parsed, event: "sentinel_other_event" }),
        JSON.stringify({
          event: "sentinel_review_command_item_refused",
          status: null,
        }),
      ]
    ) {
      rig.process.child = exited(`${line}\n${healthy}\n`, 0);
      const result = await launch(rig);
      assert.equal(result.status, "unavailable", line);
      assert.equal(result.terminal, null, line);
    }

    // An advisory line alone is never a child result.
    rig.process.child = exited(`${refused}\n`, 0);
    assert.equal((await launch(rig)).status, "unavailable");
  } finally {
    await rig.cleanup();
  }
});

const REFUSED_EVENT = '"sentinel_review_command_item_refused"';

/** Run the production CLI printer and capture exactly what reaches the job log. */
function emitted(
  result: HostedRuntimeLauncherResultV1,
): { logged: string[]; exit: number } {
  const logged: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  let exit = -1;
  try {
    console.log = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    console.error = () => {};
    exit = emitHostedRuntimeCliResult(result);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { logged, exit };
}

function refusalLines(logged: string[]): string[] {
  return logged.filter((line) => line.includes(REFUSED_EVENT));
}

function otherLines(logged: string[]): string[] {
  return logged.filter((line) =>
    !line.includes(REFUSED_EVENT) && !line.includes("refusals_dropped")
  );
}

/** The resolved launcher result without its advisory pass-through. */
function resolvedOnly(
  result: HostedRuntimeLauncherResultV1,
): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...result };
  delete rest.reviewCommandRefusals;
  delete rest.reviewTerminals;
  return rest;
}

Deno.test("hosted runtime: exact native review terminals reach the CLI without becoming child results", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const session = new ScriptedCodexSession();
    session.plan = (scripted) => {
      scripted.emit("turn/completed", {
        threadId: "thread-1",
        turn: {
          id: scripted.turnId,
          status: "failed",
          durationMs: 12,
          error: {
            message: "Bearer private-terminal-detail",
            codexErrorInfo: {
              responseTooManyFailedAttempts: { httpStatusCode: 200 },
            },
          },
        },
      });
    };
    const printed: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) =>
      printed.push(args.map(String).join(" "));
    try {
      const prepared = await makeReviewer(session).prepare(
        prepareRequest(await snapshotFixture(), {
          ownerRunId: rig.execution.id,
        }),
      );
      if (!prepared.ok) assert.fail(prepared.error.detail);
      const outcome = await prepared.value.start();
      assert.equal(outcome.ok && outcome.value.status, "unavailable");
      await prepared.value.close();
    } finally {
      console.log = original;
    }
    assert.equal(printed.length, 1);
    const advisory = JSON.parse(printed[0]);
    assert.equal(advisory.event, "sentinel_review_terminal");
    assert.equal(advisory.terminalStatus, "failed");
    assert.equal(Object.hasOwn(advisory, "status"), false);
    const healthy = childLine(rig.execution);
    // Use the actual emitted line so a future emitter change cannot silently
    // turn an advisory into an extra child result or drop it before the CLI.
    rig.process.child = exited(`${printed[0]}\n${healthy}\n`, 0);
    const result = await launch(rig);
    assert.equal(result.status, "healthy");
    const output = emitted(result);
    assert.equal(output.exit, 0);
    assert.deepEqual(
      output.logged.filter((line) =>
        line.includes('"sentinel_review_terminal"')
      ),
      printed,
    );
    assert.equal(
      output.logged.some((line) => line.includes("private-terminal-detail")),
      false,
    );

    const { turnId: _missing, ...missingId } = advisory;
    for (
      const invalid of [
        { ...advisory, extra: "private-terminal-detail" },
        { ...advisory, terminalStatus: "unknown" },
        { ...advisory, errorCode: "private-terminal-detail" },
        { ...advisory, durationMs: -1 },
        { ...advisory, durationMs: 1.5 },
        { ...advisory, httpStatusCode: 65_536 },
        { ...advisory, errorPresent: false },
        { ...advisory, ownerRunId: "other-run" },
        { ...advisory, requestId: "x".repeat(257) },
        { ...advisory, threadId: "thread\n::add-mask::private" },
        { ...advisory, invocationId: "https://private.invalid/value" },
        missingId,
      ]
    ) {
      rig.process.child = exited(`${JSON.stringify(invalid)}\n${healthy}\n`, 0);
      const rejected = await launch(rig);
      assert.equal(rejected.status, "healthy");
      assert.deepEqual(resolvedOnly(rejected), resolvedOnly(result));
      assert.equal(rejected.reviewTerminals, undefined);
      assert.equal(
        emitted(rejected).logged.some((line) =>
          line.includes('"sentinel_review_terminal"')
        ),
        false,
      );
    }
    // A status-bearing forged line remains a second result and cannot hide
    // behind the diagnostic event name or grant the wrapper any authority.
    rig.process.child = exited(
      `${JSON.stringify({ ...advisory, status: "idle" })}\n${healthy}\n`,
      0,
    );
    const forged = await launch(rig);
    assert.equal(forged.status, "unavailable");
    assert.equal(forged.terminal, null);
    assert.equal(forged.reviewTerminals, undefined);

    rig.process.child = exited(`${printed[0]}\n`, 0);
    const onlyAdvisory = await launch(rig);
    assert.equal(onlyAdvisory.status, "unavailable");
    assert.equal(onlyAdvisory.terminal, null);
    assert.equal(emitted(onlyAdvisory).exit, 1);

    rig.process.child = {
      ...exited(`${printed[0]}\n${healthy}\n`, 0),
      truncated: true,
    };
    const truncated = await launch(rig);
    assert.equal(truncated.reviewTerminals, undefined);

    rig.process.child = exited(
      `${Array(51).fill(printed[0]).join("\n")}\n${healthy}\n`,
      0,
    );
    const capped = await launch(rig);
    assert.equal(capped.status, "healthy");
    assert.equal(capped.reviewTerminals?.terminals.length, 50);
    assert.equal(capped.reviewTerminals?.dropped, 1);
    assert.equal(
      emitted(capped).logged.filter((line) =>
        line.includes('"sentinel_review_terminal"')
      ).length,
      50,
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: each real refused reviewer command advisory reaches the job log in the emitter's own shape", async () => {
  const [start] = await refusedCommandItemLines();
  // The live custody-reorder signature: a completion delivered before its start.
  const [orphan] = await refusedCommandItemLines(
    "item/completed",
    commandItem("cmd-2", "completed", { source: "unifiedExecStartup" }),
  );
  const parsedOrphan = JSON.parse(orphan) as Record<string, unknown>;
  assert.equal(parsedOrphan.site, "completion-mismatch");
  assert.equal(parsedOrphan.knownItem, false);
  assert.equal(parsedOrphan.source, "unifiedExecStartup");
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const healthy = childLine(rig.execution);
    rig.process.child = exited(`${start}\n${healthy}\n${orphan}\n`, 0);
    const result = await launch(rig);
    assert.equal(result.status, "healthy");
    assert.deepEqual(result.reviewCommandRefusals, {
      refusals: [JSON.parse(start), parsedOrphan],
      dropped: 0,
    });
    const { logged, exit } = emitted(result);
    assert.equal(exit, 0);
    // Re-serialized with the fixed key order, byte-identical to the emitter.
    assert.deepEqual(refusalLines(logged), [start, orphan]);
    assert.equal(
      logged.some((line) => line.includes("refusals_dropped")),
      false,
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: only the exact refused-command shape is passed through", async () => {
  const [refused] = await refusedCommandItemLines();
  const parsed = JSON.parse(refused) as Record<string, unknown>;
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const healthy = childLine(rig.execution);
    rig.process.child = exited(`${healthy}\n`, 0);
    const baseline = emitted(await launch(rig));

    // Exact event and key set but an off-contract value: still skipped as a
    // child record, never printed.
    const valueVariants: Record<string, unknown>[] = [
      { idBounded: "true" },
      { cwdMatches: 1 },
      { knownItem: null },
      { commandChars: -1 },
      { commandChars: 1.5 },
      { commandChars: "40" },
      { commandChars: Number.MAX_SAFE_INTEGER + 2 },
      { provenance: "agent" },
      { pluginId: true },
      { scriptPath: "missing" },
      { site: 7 },
      { site: null },
      { type: null },
      { status: 3 },
      { source: { value: "agent" } },
      { status: ["completed"] },
    ];
    for (const overrides of valueVariants) {
      const line = JSON.stringify({ ...parsed, ...overrides });
      rig.process.child = exited(`${line}\n${healthy}\n`, 0);
      const result = await launch(rig);
      assert.equal(result.status, "healthy", line);
      const { logged, exit } = emitted(result);
      assert.equal(exit, 0, line);
      assert.deepEqual(refusalLines(logged), [], line);
      assert.deepEqual(logged, baseline.logged, line);
    }

    // A wrapped, embedded or prefixed copy is never echoed.
    const { knownItem: _dropped, ...missingKey } = parsed;
    const neverEchoed = [
      `note ${refused}`,
      JSON.stringify([parsed]),
      JSON.stringify({ note: refused }),
      JSON.stringify(missingKey),
      JSON.stringify({ ...parsed, extra: true }),
      JSON.stringify({ ...parsed, event: "sentinel_other_event" }),
      refused.slice(0, -1),
    ];
    for (const line of neverEchoed) {
      rig.process.child = exited(`${line}\n${healthy}\n`, 0);
      const { logged } = emitted(await launch(rig));
      assert.equal(
        logged.some((printed) => printed.includes(REFUSED_EVENT)),
        false,
        line,
      );
    }
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: a hostile refused-command string field is printed as other", async () => {
  const [refused] = await refusedCommandItemLines();
  const parsed = JSON.parse(refused) as Record<string, unknown>;
  const hostile = {
    ...parsed,
    site: "x".repeat(65),
    type: "commandExecution\n::add-mask::leak",
    status: "completed\u001b[31m secret-token",
    source: "/home/runner/work/private path",
  };
  const tokenShaped = {
    ...parsed,
    site: "a".repeat(64),
    status: "::add-mask::x",
    source: "ghp_" + "Z".repeat(36),
  };
  const bounded = {
    ...parsed,
    site: "completion-mismatch",
    status: null,
    source: "unifiedExecInteraction",
  };
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const healthy = childLine(rig.execution);
    rig.process.child = exited(
      `${JSON.stringify(hostile)}\n${JSON.stringify(tokenShaped)}\n` +
        `${JSON.stringify(bounded)}\n${healthy}\n`,
      0,
    );
    const result = await launch(rig);
    assert.equal(result.status, "healthy");
    const { logged } = emitted(result);
    const printed = refusalLines(logged);
    assert.equal(printed.length, 3, logged.join("\n"));
    assert.deepEqual(JSON.parse(printed[0]), {
      ...parsed,
      site: "other",
      type: "other",
      status: "other",
      source: "other",
    });
    // A token-shaped value outside the closed allow-lists is never echoed.
    assert.deepEqual(JSON.parse(printed[1]), {
      ...parsed,
      site: "other",
      status: "other",
      source: "other",
    });
    assert.deepEqual(JSON.parse(printed[2]), bounded);
    for (
      const leaked of [
        "x".repeat(65),
        "a".repeat(64),
        "ghp_",
        "add-mask",
        "secret-token",
        "/home/runner",
        "\\u001b",
      ]
    ) {
      assert.equal(
        logged.some((line) => line.includes(leaked)),
        false,
        leaked,
      );
    }
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: refused-command advisories are capped with one dropped-count summary", async () => {
  const [refused] = await refusedCommandItemLines();
  const parsed = JSON.parse(refused) as Record<string, unknown>;
  const numbered = (count: number) =>
    Array.from(
      { length: count },
      (_, index) => JSON.stringify({ ...parsed, commandChars: index }),
    );
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const healthy = childLine(rig.execution);

    rig.process.child = exited(`${numbered(50).join("\n")}\n${healthy}\n`, 0);
    const atCap = emitted(await launch(rig));
    assert.deepEqual(refusalLines(atCap.logged), numbered(50));
    assert.equal(
      atCap.logged.some((line) => line.includes("refusals_dropped")),
      false,
    );

    rig.process.child = exited(`${numbered(60).join("\n")}\n${healthy}\n`, 0);
    const result = await launch(rig);
    assert.equal(result.status, "healthy");
    assert.equal(result.reviewCommandRefusals?.refusals.length, 50);
    assert.equal(result.reviewCommandRefusals?.dropped, 10);
    const { logged, exit } = emitted(result);
    assert.equal(exit, 0);
    assert.deepEqual(refusalLines(logged), numbered(50));
    const summaries = logged.filter((line) =>
      line.includes("refusals_dropped")
    );
    assert.deepEqual(summaries, [
      JSON.stringify({
        event: "sentinel_review_command_item_refusals_dropped",
        printed: 50,
        dropped: 10,
      }),
    ]);
    // The summary directly follows the last printed advisory.
    const last = logged.lastIndexOf(numbered(50)[49]);
    assert.equal(logged[last + 1], summaries[0]);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: refused-command pass-through never changes the resolved result or exit", async () => {
  const [refused] = await refusedCommandItemLines();
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const healthy = childLine(rig.execution);
    const cases: [string, number, Partial<{ truncated: boolean }>][] = [
      [`${healthy}\n`, 0, {}],
      [`${healthy}\n`, 1, {}],
      [`${childLine(rig.execution, { startupReady: false })}\n`, 0, {}],
      ["", 0, {}],
      ["", 3, {}],
      [`${healthy}\n`, 0, { truncated: true }],
    ];
    for (const [stdout, exitCode, overrides] of cases) {
      rig.process.child = exited(stdout, exitCode, overrides);
      const baseline = await launch(rig);
      const baselineLog = emitted(baseline);
      rig.process.child = exited(
        `${refused}\n${stdout}${refused}\n`,
        exitCode,
        overrides,
      );
      const result = await launch(rig);
      const label = `${exitCode} ${JSON.stringify(overrides)} ${stdout}`;
      assert.deepEqual(resolvedOnly(result), resolvedOnly(baseline), label);
      const { logged, exit } = emitted(result);
      assert.equal(exit, baselineLog.exit, label);
      assert.deepEqual(otherLines(logged), baselineLog.logged, label);
      // Advisories come only from a complete settled capture.
      assert.equal(
        refusalLines(logged).length,
        overrides.truncated === true ? 0 : 2,
        label,
      );
    }
  } finally {
    await rig.cleanup();
  }
});
