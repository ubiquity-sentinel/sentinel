/**
 * C5.3 (2026-10-25 redesign): the multi-target pass rotates its setting order
 * by `runId % configs.length`, so the last configured target (Passport) is
 * not always the one left behind earlier review drains.
 */
import assert from "node:assert/strict";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import {
  type ActionsTargetCyclesInputV1,
  rotateTargetConfigsV1,
  runActionsTargetCycles,
} from "../../src/host/actions-target-cycles.ts";
import { FakeClock, MemoryState, repairConfigs } from "../repair/helpers.ts";
import { T0 } from "../state/helpers.ts";

const SLUGS = [
  "ubiquity-sentinel/sentinel",
  "ubiquity/ai.ubq.fi",
  "ubiquity/passport.ubq.fi",
];

function configs(): RepositoryConfigV1[] {
  const base = repairConfigs()[0];
  return SLUGS.map((slug) => {
    const [owner, name] = slug.split("/");
    return { ...base, repository: { ...base.repository, owner, name } };
  });
}

async function order(runId: number | undefined): Promise<string[]> {
  const started: string[] = [];
  const clock = new FakeClock(T0);
  const input = {
    clock,
    state: new MemoryState(),
    configs: configs(),
    deadline: T0 + 60_000,
    stepLimit: 1,
    modelStartsEnabled: false,
    composeGithub: () => ({}),
    runCycle: (deps: { configs: RepositoryConfigV1[] }) => {
      const { owner, name } = deps.configs[0].repository;
      started.push(`${owner}/${name}`);
      return Promise.resolve({ status: "idle", detail: "fixture" });
    },
    ...(runId === undefined ? {} : { host: { run: { runId } } }),
  } as unknown as ActionsTargetCyclesInputV1;
  const result = await runActionsTargetCycles(input);
  assert.deepEqual(result.addressed, started);
  return started;
}

Deno.test("target rotation: each run id starts at its own offset and every target runs once", async () => {
  assert.deepEqual(await order(9), SLUGS, "9 % 3 = 0 keeps the setting order");
  assert.deepEqual(await order(40095160778), [
    "ubiquity/passport.ubq.fi",
    "ubiquity-sentinel/sentinel",
    "ubiquity/ai.ubq.fi",
  ]);
  assert.deepEqual(await order(10), [
    "ubiquity/ai.ubq.fi",
    "ubiquity/passport.ubq.fi",
    "ubiquity-sentinel/sentinel",
  ]);
});

Deno.test("target rotation: without a native run identity the setting order is kept", async () => {
  assert.deepEqual(await order(undefined), SLUGS);
  assert.deepEqual(rotateTargetConfigsV1(SLUGS, -1), SLUGS);
  assert.deepEqual(rotateTargetConfigsV1(SLUGS, 1.5), SLUGS);
  assert.deepEqual(rotateTargetConfigsV1(["only"], 7), ["only"]);
});

Deno.test("target rotation: a deadline skips the remaining targets in the rotated order", async () => {
  const clock = new FakeClock(T0);
  const started: string[] = [];
  const result = await runActionsTargetCycles({
    clock,
    state: new MemoryState(),
    configs: configs(),
    deadline: T0 + 1_000,
    stepLimit: 1,
    modelStartsEnabled: false,
    composeGithub: () => ({}),
    runCycle: (deps: { configs: RepositoryConfigV1[] }) => {
      const { owner, name } = deps.configs[0].repository;
      started.push(`${owner}/${name}`);
      clock.advance(1_000);
      return Promise.resolve({ status: "idle", detail: "fixture" });
    },
    host: { run: { runId: 11 } },
  } as unknown as ActionsTargetCyclesInputV1);
  assert.deepEqual(started, ["ubiquity/passport.ubq.fi"]);
  assert.deepEqual(result.skipped, [
    "ubiquity-sentinel/sentinel",
    "ubiquity/ai.ubq.fi",
  ]);
});
