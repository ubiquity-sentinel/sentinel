/**
 * The serial repair job's two #328 fan-out advisory lines reach the hosted
 * job log through the launcher's advisory re-emission (`scanStepLines`): the
 * same-run hand-back takeover (`sentinel_repair_handback`, `read` or
 * `unavailable`) and the no-delegation fallback
 * (`sentinel_repair_fanout_delegation`). The launcher used to re-emit only
 * step, matrix-skip and pass lines, so a takeover that read `unavailable`
 * went unseen. Neither line has a `status`: beside exactly one real child
 * record the child-status scan still reads that one record, and the resolved
 * launcher result is the same as without them. The lines are the real
 * producers' own; no network, no model.
 */
import assert from "node:assert/strict";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { ActionsTargetCyclesInputV1 } from "../../src/host/actions.ts";
import { emitHostedRuntimeCliResult } from "../../src/host/hosted-runtime.ts";
import type { HostedRuntimeLauncherResultV1 } from "../../src/host/hosted-runtime.ts";
import { scanChildStatusRecords } from "../../src/host/hosted-runtime-status.ts";
import type { RepairHandbackV1 } from "../../src/host/matrix-artifact-port.ts";
import {
  delegatedRecordsOfRun,
  REPAIR_FANOUT_DELEGATION_KIND,
} from "../../src/host/repair-fanout-host.ts";
import {
  REPAIR_HANDBACK_KIND,
  startRepairHandbackTakeover,
} from "../../src/host/repair-handback-takeover.ts";
import { REPO, SHA1, SHA2, T0 } from "../state/helpers.ts";
import {
  childLine,
  exited,
  launch,
  makeRig,
  OBSERVED_BASE,
  seedRelease,
} from "./hosted-runtime-fixture.ts";

const RUN = { runId: 41, runAttempt: 1, launcherSha: SHA1 };

/** The real takeover's one line for `handbacks` (null: the read failed). */
async function handbackLine(
  handbacks: readonly RepairHandbackV1[] | null,
): Promise<string> {
  const lines: string[] = [];
  const takeover = startRepairHandbackTakeover({
    transport: {
      repairHandbacks: () =>
        handbacks === null
          ? Promise.reject(new Error("unauthenticated"))
          : Promise.resolve(handbacks),
    },
    planDigest: "d".repeat(64),
    exclude: new Set(["issue-1"]),
    configs: [{ repository: REPO } as unknown as RepositoryConfigV1],
    request: { run: RUN, runtime: { revision: SHA2, generation: 3 }, until: 0 },
    wake: () => true,
    log: (line) => lines.push(line),
  });
  assert.notEqual(takeover, null);
  await takeover!.settle();
  assert.equal(lines.length, 1);
  return lines[0];
}

/** The real serial job's one line when its plan is absent beside its root. */
async function delegationLine(): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    const delegated = await delegatedRecordsOfRun(
      {
        host: {
          execution: { id: "41:1:repair", generation: 3 },
          run: RUN,
          artifactRoot: `${Deno.cwd()}/.sentinel-absent-${T0}/.sentinel-matrix`,
        },
      } as unknown as ActionsTargetCyclesInputV1,
      { planDigest: "d".repeat(64), repairPlanDigest: "b".repeat(64) },
    );
    assert.equal(delegated, undefined);
  } finally {
    console.log = original;
  }
  assert.equal(lines.length, 1);
  return lines[0];
}

/** Run the production CLI printer and capture what reaches the job log. */
function emitted(
  result: HostedRuntimeLauncherResultV1,
): { logged: string[]; exit: number } {
  const logged: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  let exit = -1;
  try {
    console.log = (...args: unknown[]) =>
      logged.push(args.map(String).join(" "));
    console.error = () => {};
    exit = emitHostedRuntimeCliResult(result);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { logged, exit };
}

/** The resolved launcher result without its advisory step lines. */
function resolvedOnly(
  result: HostedRuntimeLauncherResultV1,
): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...result };
  delete rest.stepLines;
  return rest;
}

const fanoutLines = (logged: string[]) =>
  logged.filter((line) =>
    line.includes(REPAIR_HANDBACK_KIND) ||
    line.includes(REPAIR_FANOUT_DELEGATION_KIND)
  );

Deno.test("fan-out lines: the hand-back and no-delegation lines reach the job log beside exactly one child record", async () => {
  const read = await handbackLine([{ repository: REPO, records: ["issue-1"] }]);
  const unavailable = await handbackLine(null);
  const delegation = await delegationLine();
  assert.deepEqual(JSON.parse(read), {
    kind: REPAIR_HANDBACK_KIND,
    outcome: "read",
    records: 1,
  });
  assert.deepEqual(JSON.parse(unavailable), {
    kind: REPAIR_HANDBACK_KIND,
    outcome: "unavailable",
    records: 0,
  });
  assert.deepEqual(JSON.parse(delegation), {
    kind: REPAIR_FANOUT_DELEGATION_KIND,
    outcome: "unavailable",
  });
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const healthy = childLine(rig.execution);
    const stdout = [delegation, read, unavailable, healthy].join("\n") + "\n";
    assert.deepEqual(scanChildStatusRecords(stdout), {
      kind: "one",
      value: JSON.parse(healthy),
    });
    rig.process.child = exited(stdout, 0);
    const result = await launch(rig);
    assert.equal(result.status, "healthy");
    assert.equal(result.terminal?.outcome, "healthy");
    assert.equal(result.terminal?.baseSha, OBSERVED_BASE);
    const { logged, exit } = emitted(result);
    assert.equal(exit, 0);
    // Re-emitted exactly as printed, in child order, before the terminal.
    assert.deepEqual(fanoutLines(logged), [delegation, read, unavailable]);
    assert.deepEqual(logged.slice(0, 3), [delegation, read, unavailable]);
    assert.ok(
      logged.findIndex((line) => line.includes("hosted_runtime_terminal")) > 2,
    );
    // The lines change nothing the launcher resolved.
    rig.process.child = exited(`${healthy}\n`, 0);
    assert.deepEqual(resolvedOnly(result), resolvedOnly(await launch(rig)));
  } finally {
    await rig.cleanup();
  }
});

Deno.test("fan-out lines: a forged fan-out line is never re-emitted and a status-bearing one stays a second record", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const healthy = childLine(rig.execution);
    for (
      const invalid of [
        { kind: REPAIR_HANDBACK_KIND, outcome: "read", records: 1, extra: 1 },
        { kind: REPAIR_HANDBACK_KIND, outcome: "partial", records: 1 },
        { kind: REPAIR_HANDBACK_KIND, outcome: "read", records: -1 },
        { kind: REPAIR_HANDBACK_KIND, outcome: "read", records: 1.5 },
        { kind: REPAIR_HANDBACK_KIND, outcome: "read", records: 100_001 },
        { kind: REPAIR_HANDBACK_KIND, outcome: "read" },
        { kind: REPAIR_FANOUT_DELEGATION_KIND, outcome: "read" },
        { kind: REPAIR_FANOUT_DELEGATION_KIND, outcome: "unavailable", n: 0 },
      ]
    ) {
      rig.process.child = exited(`${JSON.stringify(invalid)}\n${healthy}\n`, 0);
      const result = await launch(rig);
      assert.equal(result.status, "healthy", JSON.stringify(invalid));
      assert.deepEqual(fanoutLines(emitted(result).logged), []);
    }
    rig.process.child = exited(
      `${
        JSON.stringify({
          kind: REPAIR_HANDBACK_KIND,
          outcome: "unavailable",
          records: 0,
          status: "ran",
        })
      }\n${healthy}\n`,
      0,
    );
    const forged = await launch(rig);
    assert.equal(forged.status, "unavailable");
    assert.equal(forged.terminal, null);
  } finally {
    await rig.cleanup();
  }
});
