/** Serial repair must not walk the implementation backlog before matrix planning. */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import type { HostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { DEFAULT_STEP_LIMIT } from "../../src/repair/loop-bounds.ts";
import { prepareMatrixIntakeV1 } from "../../src/repair/loop-intake.ts";
import { targetDeps } from "../../src/host/matrix-actions-shared.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { runActionsMatrixAggregateCycles } from "../../src/host/matrix-aggregate.ts";
import type { ActionsTargetCyclesInputV1 } from "../../src/host/actions-target-cycles.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "../repair/helpers.ts";
import { seededSnapshot } from "../repair/loop-rig.ts";
import { SHA1, T0, workRecord } from "../state/helpers.ts";

function rig(
  targets = 1,
  records = 0,
  purpose: HostedExecutionIntentV1["purpose"] = "ordinary",
) {
  const clock = new FakeClock(T0 + 2000);
  const configs = Array.from({ length: targets }, (_, index) => {
    const config = repairConfigs({
      adapter: { kind: "github" },
      sessionBound: { maxDurationMs: 60_000, maxOutputChars: 40000 },
    })[0];
    return {
      ...config,
      repository: { ...config.repository, name: `target-${index}` },
    };
  });
  const state = new MemoryState();
  const work = Array.from(
    { length: records },
    (_, index) =>
      workRecord(`issue-${index + 1}`, {
        repository: configs[index % targets].repository,
        related: { incidentId: null, issueNumber: index + 1 },
        target: {
          base: SHA1,
          branch: `sentinel/repair/issue-${index + 1}`,
          checkpoint: null,
          head: null,
          pr: null,
        },
      }),
  );
  state.repair = seededSnapshot(work);
  state.repairHead = SHA1;
  let reads = 0;
  const read = state.readRepair.bind(state);
  state.readRepair = () => {
    reads++;
    clock.advance(100);
    return read();
  };
  const github = new FakeGithub();
  const model = new FakeModel();
  let transports = 0;
  let preparations = 0;
  const input: ActionsTargetCyclesInputV1 = {
    clock,
    state,
    configs,
    controllerSha: SHA1,
    githubCooldown: new DurableGitHubCooldownGate({ clock, state }),
    incidents: new FakeIncidents(),
    replay: new FakeReplay(),
    model,
    budget: new RollingStartBudget({ clock, state, configs }),
    deadline: clock.now() + 60 * 60_000,
    stepLimit: Infinity,
    modelStartsEnabled: false,
    composeGithub: () => github,
    prepareTarget: () => {
      preparations++;
      return Promise.resolve();
    },
    host: {
      execution: {
        id: "1:1:repair",
        runId: 1,
        runAttempt: 1,
        launcherSha: SHA1,
        purpose,
        revision: SHA1,
        generation: 1,
        releaseId: null,
        createdAt: T0,
      },
      run: { runId: 1, runAttempt: 1, launcherSha: SHA1 },
      artifactRoot: "/unused",
      sourcePathFor: () => "/unused",
      expectedProvider: "unused",
      createArtifactTransport: () => {
        transports++;
        return Promise.resolve({ recover: () => Promise.resolve([]) });
      },
    },
  };
  return {
    input,
    state,
    work,
    github,
    model,
    reads: () => reads,
    transports: () => transports,
    preparations: () => preparations,
  };
}

function pendingCustody(records: WorkRecordV1[]) {
  for (const record of records) {
    // This published artifact cannot be replaced by a fresh planner start.
    record.target.head = SHA1;
    record.target.candidateState = { preserved: null, publishedHead: SHA1 };
  }
}

async function measure(input: ActionsTargetCyclesInputV1, native = false) {
  const log = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  const start = performance.now();
  const virtualStart = input.clock.now();
  try {
    const result = await runActionsMatrixAggregateCycles(
      input,
      undefined,
      native ? { planDigest: "a".repeat(64) } : undefined,
    );
    return {
      result,
      steps: lines.filter((line) =>
        line.includes('"kind":"sentinel_step"')
      ).length,
    };
  } finally {
    console.log = log;
    log(
      `serial-pass simulated_io_ms=${
        input.clock.now() - virtualStart
      } elapsed_ms=${Math.round(performance.now() - start)} sentinel_step=${
        lines.filter((line) => line.includes('"kind":"sentinel_step"')).length
      }`,
    );
  }
}

Deno.test("matrix serial pass: 700 planner-owned issues across 30 targets need no sentinel_step", async () => {
  const test = rig(30, 700);
  const before = structuredClone(test.state.repair);
  test.input.modelStartsEnabled = true;
  const measured = await measure(test.input, true);
  assert.equal(measured.steps, 0);
  assert.ok(test.reads() <= 100, `state reads: ${test.reads()}`);
  assert.deepEqual(test.state.repair, before);
  assert.equal(test.model.requests.length, 0);
  assert.equal(measured.result.addressed.length, 30);
});

for (const targets of [DEFAULT_STEP_LIMIT + 1, DEFAULT_STEP_LIMIT * 2]) {
  Deno.test(`matrix serial pass: prepares all ${targets} configured targets`, async () => {
    const test = rig(targets);
    const before = structuredClone(test.state.repair);
    test.input.modelStartsEnabled = true;
    const measured = await measure(test.input);
    assert.equal(test.preparations(), targets);
    assert.deepEqual(
      measured.result.addressed,
      test.input.configs.map((config) =>
        `${config.repository.owner}/${config.repository.name}`
      ),
    );
    assert.deepEqual(measured.result.skipped, []);
    assert.deepEqual(measured.result.failed, []);
    assert.deepEqual(test.state.repair, before);
    assert.equal(test.model.requests.length, 0);
  });
}

Deno.test("matrix serial pass: bootstrap checks state without recovery, target preparation or lifecycle", async () => {
  const test = rig(30, 700, "bootstrap");
  pendingCustody(test.work.slice(0, 270));
  const before = structuredClone(test.state.repair);
  const measured = await measure(test.input);
  assert.equal(measured.steps, 0);
  assert.equal(test.reads(), 1);
  assert.equal(test.transports(), 0);
  assert.equal(test.preparations(), 0);
  assert.equal(test.github.calls.length, 0);
  assert.deepEqual(test.state.repair, before);
  assert.equal(measured.result.outcome?.status, "idle");
});

Deno.test("matrix serial pass: total lifecycle advances are bounded across all targets", async () => {
  const test = rig(30, 270);
  pendingCustody(test.work);
  const before = structuredClone(test.state.repair);
  const measured = await measure(test.input);
  assert.ok(measured.steps > 0);
  assert.ok(measured.steps <= 32, `sentinel_step: ${measured.steps}`);
  assert.deepEqual(test.state.repair, before);
  assert.equal(test.model.requests.length, 0);
  assert.equal(measured.result.failed.length, 0);
});

Deno.test("matrix serial pass: native result consumers retain the full candidate observation lane", async () => {
  const test = rig(30, 270);
  pendingCustody(test.work);
  const before = structuredClone(test.state.repair);
  const measured = await measure(test.input, true);
  assert.equal(measured.steps, 270);
  assert.deepEqual(test.state.repair, before);
  assert.equal(test.model.requests.length, 0);
});

Deno.test("matrix serial pass: branchless starts remain available to batched planner intake", async () => {
  const test = rig(2, 70);
  for (const record of test.work) record.target.branch = null;
  const before = structuredClone(test.state.repair);
  const measured = await measure(test.input);
  assert.equal(measured.steps, 0);
  assert.deepEqual(test.state.repair, before);
  for (const config of test.input.configs) {
    await prepareMatrixIntakeV1({
      ...targetDeps(test.input, config),
      configs: [config],
    }, { deadline: test.input.deadline, modelStartsEnabled: false });
  }
  assert.equal(test.state.repairWrites, 2);
  assert.ok(
    test.state.repair?.work.every((record) => record.target.branch !== null),
  );
  assert.equal(test.model.requests.length, 0);
});

Deno.test("matrix serial pass: bootstrap rejects incompatible state before touching external ports", async () => {
  const test = rig(1, 1, "bootstrap");
  Object.assign(test.state.repair!, { version: "incompatible" });
  await assert.rejects(() => measure(test.input), /version/);
  assert.equal(test.reads(), 1);
  assert.equal(test.transports(), 0);
  assert.equal(test.preparations(), 0);
  assert.equal(test.github.calls.length, 0);
  assert.equal(test.model.requests.length, 0);
});

Deno.test("matrix serial pass: native bootstrap retains its initial scan and mandatory drain", async () => {
  const test = rig(1, 1, "bootstrap");
  const before = structuredClone(test.state.repair);
  const measured = await measure(test.input, true);
  assert.equal(test.transports(), 1);
  assert.equal(test.preparations(), 1);
  assert.equal(test.github.drains.length, 1);
  assert.equal(measured.steps, 0);
  assert.deepEqual(test.state.repair, before);
  assert.deepEqual(measured.result.failed, []);
  assert.equal(test.model.requests.length, 0);
});
