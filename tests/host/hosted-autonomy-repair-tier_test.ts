/**
 * #324 through the real maintenance pass: the hosted autonomy runner, the
 * real Git repair store and the generated 731-record production-shaped
 * snapshot. The tier step demotes within its row budget, defers the rest
 * without failing the pass, reports its counts in one summary line, and the
 * next pass reads fewer hot records.
 */
import assert from "node:assert/strict";
import { GitStateStore } from "../../src/state/mod.ts";
import { createMetricsCollectorV1 } from "../../src/contracts/throughput-metrics-collector.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import type { HostedAutonomyDepsV1 } from "../../ops/hosted-autonomy-types.ts";
import { REPAIR_TIER_SUMMARY_KIND } from "../../ops/hosted-autonomy-repair-tier.ts";
import { makeRig, run } from "./hosted-autonomy-rig.ts";
import {
  COUNTS,
  issueNumber,
  issueOpen,
  NOW,
  tierFixtureSnapshot,
  TOTAL_WORK,
} from "../state/repair-tier-fixtures.ts";

const FIXTURE_RECORDS = TOTAL_WORK + COUNTS.reservations +
  COUNTS.reservationArchive + COUNTS.reviews + COUNTS.releaseRequests +
  COUNTS.attemptMemory;

function openNumbers(): number[] {
  const numbers: number[] = [];
  for (let index = 0; index < TOTAL_WORK; index++) {
    if (issueOpen(index)) numbers.push(issueNumber(index));
  }
  return numbers;
}

/** Runs one pass and returns its result plus the parsed tier summary line. */
async function pass(
  rig: Awaited<ReturnType<typeof makeRig>>["rig"],
  github: Awaited<ReturnType<typeof makeRig>>["github"],
  extra: Partial<HostedAutonomyDepsV1>,
) {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  let result;
  try {
    result = await run(rig, github, extra);
  } finally {
    console.log = original;
  }
  const summaries = lines.flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed?.kind === REPAIR_TIER_SUMMARY_KIND ? [parsed] : [];
    } catch {
      return [];
    }
  });
  assert.equal(summaries.length, 1, "exactly one tier summary line per pass");
  return { result, summary: summaries[0] };
}

Deno.test("hosted maintenance pass: 731-record surface demotes under budget, defers the rest and reports counts", async () => {
  const { rig, github } = await makeRig("repair-tier", {
    repair: tierFixtureSnapshot(),
  });
  try {
    const store = new GitStateStore({
      scratchDir: `${rig.tmp}/tier`,
      remoteUrl: `${rig.tmp}/remote.git`,
      role: "repair",
    });
    const listed: string[] = [];
    const extra: Partial<HostedAutonomyDepsV1> = {
      clock: { now: () => NOW },
      repairTiers: {
        store,
        listOpenIssueNumbers: (repository: RepositoryIdentityV1) => {
          listed.push(`${repository.owner}/${repository.name}`);
          return Promise.resolve(portOk(openNumbers()));
        },
        demotionBudget: 1_200,
      },
    };

    const metrics = createMetricsCollectorV1();
    const first = await pass(rig, github, { ...extra, metrics });
    assert.notEqual(
      first.result.status,
      "failed",
      JSON.stringify(first.result),
    );
    assert.deepEqual(listed, ["ubiquity/ai.ubq.fi"]);
    assert.equal(
      first.summary.status,
      "applied",
      JSON.stringify(first.summary),
    );
    assert.equal(first.summary.recordsRead, FIXTURE_RECORDS);
    assert.equal(first.summary.promoted, 0);
    // The rig's release ref has no VPS release: the path is observed disabled.
    assert.equal(first.summary.releaseRequestsMovedToCold, 0);
    assert.equal(first.summary.releaseRequestsSuperseded, 0);
    // Whole families only: 1,200 rows fit exactly, 2,024 eligible rows wait.
    assert.equal(first.summary.demoted, 1_200);
    assert.equal(first.summary.deferred, 2_024);
    assert.ok(
      first.result.actions.some((action) =>
        action ===
          "repair-tier:promoted:0:demoted:1200:deferred:2024:read:4962" +
            ":release-disabled:moved-cold:0:superseded:0"
      ),
      JSON.stringify(first.result.actions),
    );

    const record = metrics.snapshot({
      cycle: { runId: 1, attempt: 1 },
      startedAtMs: NOW,
      finishedAtMs: NOW + 1,
    });
    assert.equal(record.counts.recordsRead, FIXTURE_RECORDS);
    assert.equal(record.counts.releaseRequestsMovedToCold, 0);

    // The next pass reads exactly the rows the first one left hot and keeps
    // draining under the same budget, never failing.
    const second = await pass(rig, github, extra);
    assert.notEqual(second.result.status, "failed");
    assert.equal(second.summary.status, "applied");
    assert.equal(
      second.summary.recordsRead,
      FIXTURE_RECORDS - first.summary.demoted,
    );
    assert.equal(second.summary.demoted, 1_197);
    assert.equal(second.summary.deferred, 827);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("hosted maintenance pass: without the tier capability nothing moves and the pass reports it once", async () => {
  const { rig, github } = await makeRig("repair-tier-off", {
    repair: tierFixtureSnapshot(),
  });
  try {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      await run(rig, github, { clock: { now: () => NOW } });
    } finally {
      console.log = original;
    }
    assert.equal(
      lines.filter((line) => line.includes(REPAIR_TIER_SUMMARY_KIND)).length,
      0,
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true }).catch(() => {});
  }
});
