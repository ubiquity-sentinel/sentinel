/** A refused reviewer command item is an advisory line, never a second child record. */
import assert from "node:assert/strict";
import {
  commandItem,
  ScriptedCodexSession,
  snapshotFixture,
  startReview,
  turnCompleted,
} from "../github/codex-reviewer-helpers.ts";
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
async function refusedCommandItemLines(): Promise<string[]> {
  const session = new ScriptedCodexSession();
  session.plan = (scripted) => {
    scripted.emit("item/started", {
      threadId: "thread-1",
      turnId: scripted.turnId,
      item: commandItem("cmd-1", "inProgress", { cwd: "/tmp/other-checkout" }),
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
