/**
 * Owner decision 2026-11-18 ("no private repos"): the runtime configures a
 * committed target only when GitHub's repository read says it is public
 * (`src/repair/target-visibility.ts`), through the actual hosted composition
 * and the production target resolvers over fake GitHub answers, the matrix
 * rig's real Git state remote, release custody and native identity:
 *
 * - a private target is never configured: the pass hands its target cycles
 *   the public target only, reads nothing of the private one beyond its
 *   repository read, and prints one text-free line with the closed reason
 *   and counts;
 * - a visibility GitHub did not state skips the target like an unreadable
 *   branch: never treated as public;
 * - a private skip is never a read failure: a pass whose public targets were
 *   all transiently unreadable still defers with counts over them only, and
 *   a setting whose every target is private refuses as empty, never as
 *   unavailable.
 */
import assert from "node:assert/strict";
import { ensureRepairStateSeed } from "../../src/host/actions-host-io.ts";
import { runActionsRepairHost } from "../../src/host/actions-repair-host.ts";
import {
  STATIC_TARGETS_DEFERRED,
  STATIC_TARGETS_EMPTY,
} from "../../src/host/targets.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import { PRIVATE_TARGET_REASON } from "../../src/repair/target-visibility.ts";
import { PRIVATE_TARGETS_KIND } from "../../src/repair/private-targets-line.ts";
import { scanStepLines } from "../../src/repair/step-line.ts";
import { TARGETS_DEFERRAL_KIND } from "../../src/repair/targets-deferral-line.ts";
import { rig } from "./matrix-actions-fixtures.ts";
import {
  advanceWithLog,
  type Answer,
  deferralLines,
  LISTED,
  NO_MODEL,
  observed,
  PRODUCTION,
  QUIET_LOG,
  quietly,
  reply,
  servingJobLogs,
  UNAVAILABLE_503,
} from "./targets-deferral-fixtures.ts";

const QUIET = new Map([[101, QUIET_LOG]]);
const PUBLIC_SENTINEL = reply(
  200,
  {},
  '{"default_branch":"development","private":false,"visibility":"public"}',
);
const PRIVATE_PROSPECTOR = reply(
  200,
  {},
  '{"default_branch":"main","private":true,"visibility":"private"}',
);

/** Answer the two committed targets' repository reads; the rest reach `http`. */
function targets(
  http: HttpTransportV1,
  sentinel: Answer,
  prospector: Answer,
): HttpTransportV1 {
  return (request) => {
    const path = new URL(request.url).pathname;
    if (
      request.method === "GET" && path === "/repos/ubiquity-sentinel/sentinel"
    ) {
      return sentinel(request);
    }
    if (request.method === "GET" && path === "/repos/ubiquity/prospector") {
      return prospector(request);
    }
    return http(request);
  };
}

function privateLines(lines: readonly string[]) {
  return lines.filter((line) => line.includes("sentinel_private_targets"));
}

class CyclesReached extends Error {}

Deno.test("private target: never configured; the pass reads nothing more of it and prints one text-free line", async () => {
  const r = await rig();
  try {
    await ensureRepairStateSeed(r.store, r.clock);
    await advanceWithLog(r, 72, QUIET_LOG, 101);
    const deps = await r.job("private-target-serial", "repair");
    await Deno.writeTextFile(`${deps.workDir}/sentinel.targets.json`, LISTED);
    const http = observed(
      targets(
        servingJobLogs(deps.http, QUIET),
        PUBLIC_SENTINEL,
        PRIVATE_PROSPECTOR,
      ),
    );
    const configured: string[][] = [];
    const { value: outcome, lines } = await quietly(async () => {
      try {
        await runActionsRepairHost({
          ...deps,
          ...PRODUCTION,
          state: r.store,
          http: http.http,
          model: NO_MODEL,
          preflight: () => Promise.resolve(),
          runTargetCycles: (input) => {
            configured.push(
              input.configs.map((config) =>
                `${config.repository.owner}/${config.repository.name}`
              ),
            );
            throw new CyclesReached();
          },
        });
        return "returned";
      } catch (error) {
        return error instanceof CyclesReached ? "cycles" : String(error);
      }
    });
    assert.equal(outcome, "cycles", "the public target still runs its cycle");
    assert.deepEqual(configured, [["ubiquity-sentinel/sentinel"]]);
    // The private target's one repository read and nothing else of it: no
    // tree facts, issue listing, pull, comment or CI read.
    assert.deepEqual(
      http.requests.filter((request) => request.includes("prospector")),
      ["GET /repos/ubiquity/prospector"],
    );
    const line = privateLines(lines);
    assert.equal(line.length, 1);
    assert.deepEqual(JSON.parse(line[0]), {
      kind: "sentinel_private_targets",
      reason: PRIVATE_TARGET_REASON,
      skipped: 1,
      listed: 2,
      configured: 1,
    });
    assert.equal(line[0].includes("prospector"), false);
    // The launcher re-emits it into the job log after its strict re-parse.
    assert.deepEqual(
      scanStepLines(lines.join("\n")).filter((entry) =>
        entry.kind === PRIVATE_TARGETS_KIND
      ),
      [JSON.parse(line[0])],
    );
    assert.deepEqual(deferralLines(lines), [], "no deferral line");
  } finally {
    await r.cleanup();
  }
});

Deno.test("private target: a visibility GitHub did not state is skipped, never treated as public", async () => {
  const r = await rig();
  try {
    await ensureRepairStateSeed(r.store, r.clock);
    await advanceWithLog(r, 72, QUIET_LOG, 101);
    for (
      const body of [
        '{"default_branch":"main"}',
        '{"default_branch":"main","private":"false"}',
        '{"default_branch":"main","private":false,"visibility":"internal"}',
        '{"default_branch":"main","private":false,"visibility":"secret"}',
      ]
    ) {
      const deps = await r.job(
        `private-target-unknown-${body.length}`,
        "repair",
      );
      await Deno.writeTextFile(`${deps.workDir}/sentinel.targets.json`, LISTED);
      const http = observed(
        targets(
          servingJobLogs(deps.http, QUIET),
          PUBLIC_SENTINEL,
          reply(200, {}, body),
        ),
      );
      const configured: string[][] = [];
      await quietly(async () => {
        try {
          await runActionsRepairHost({
            ...deps,
            ...PRODUCTION,
            state: r.store,
            http: http.http,
            model: NO_MODEL,
            preflight: () => Promise.resolve(),
            runTargetCycles: (input) => {
              configured.push(
                input.configs.map((config) =>
                  `${config.repository.owner}/${config.repository.name}`
                ),
              );
              throw new CyclesReached();
            },
          });
        } catch {
          // The cycles marker; the configured list is the assertion.
        }
      });
      assert.deepEqual(configured, [["ubiquity-sentinel/sentinel"]], body);
      assert.deepEqual(
        http.requests.filter((request) => request.includes("prospector")),
        ["GET /repos/ubiquity/prospector"],
        body,
      );
    }
  } finally {
    await r.cleanup();
  }
});

Deno.test("private target: never a read failure; public targets that were all transiently unreadable still defer, counted alone", async () => {
  const r = await rig();
  try {
    await ensureRepairStateSeed(r.store, r.clock);
    await advanceWithLog(r, 72, QUIET_LOG, 101);
    const deps = await r.job("private-target-deferral", "repair");
    await Deno.writeTextFile(`${deps.workDir}/sentinel.targets.json`, LISTED);
    const repairBefore = await r.store.readRepair();
    const { value: result, lines } = await quietly(() =>
      runActionsRepairHost({
        ...deps,
        ...PRODUCTION,
        state: r.store,
        http: targets(
          servingJobLogs(deps.http, QUIET),
          UNAVAILABLE_503,
          PRIVATE_PROSPECTOR,
        ),
        model: NO_MODEL,
        preflight: () => Promise.resolve(),
        runTargetCycles: () => {
          throw new Error("a deferred pass runs no target cycle");
        },
      })
    );
    assert.deepEqual(result.outcome, {
      status: "idle",
      detail: STATIC_TARGETS_DEFERRED,
    });
    assert.deepEqual(deferralLines(lines), [{
      kind: TARGETS_DEFERRAL_KIND,
      reasonCode: "targets_unavailable",
      listed: 1,
      branchUnavailable: 1,
      factsUnavailable: 0,
      transient: 1,
    }]);
    assert.equal(privateLines(lines).length, 1);
    assert.deepEqual(await r.store.readRepair(), repairBefore);
  } finally {
    await r.cleanup();
  }
});

Deno.test("private target: a setting whose every target is private refuses as empty, never as unavailable", async () => {
  const r = await rig();
  try {
    await ensureRepairStateSeed(r.store, r.clock);
    await advanceWithLog(r, 72, QUIET_LOG, 101);
    const deps = await r.job("private-target-all", "repair");
    await Deno.writeTextFile(
      `${deps.workDir}/sentinel.targets.json`,
      JSON.stringify(["ubiquity/prospector"]),
    );
    const repairBefore = await r.store.readRepair();
    const { value: failure, lines } = await quietly(async () => {
      try {
        await runActionsRepairHost({
          ...deps,
          ...PRODUCTION,
          state: r.store,
          http: targets(
            servingJobLogs(deps.http, QUIET),
            PUBLIC_SENTINEL,
            PRIVATE_PROSPECTOR,
          ),
          model: NO_MODEL,
          preflight: () => Promise.resolve(),
          runTargetCycles: () => {
            throw new Error("no target is configured");
          },
        });
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    assert.equal(failure, STATIC_TARGETS_EMPTY);
    assert.deepEqual(deferralLines(lines), []);
    assert.deepEqual(JSON.parse(privateLines(lines)[0]), {
      kind: "sentinel_private_targets",
      reason: PRIVATE_TARGET_REASON,
      skipped: 1,
      listed: 1,
      configured: 0,
    });
    assert.deepEqual(await r.store.readRepair(), repairBefore);
  } finally {
    await r.cleanup();
  }
});
