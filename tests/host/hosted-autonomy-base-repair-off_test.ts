/**
 * Base-repair filing stays off for every target while the base-repair CI-fix
 * cap lands ahead of it (2026-11-16, stage 1 of the base-repair split):
 * `BASE_REPAIR_FILING_ENABLED` is false, so the real maintenance pass
 * (`runHostedAutonomy`) runs its `base_repair` phase and reads and files
 * nothing for ai.ubq.fi, uusd.ubq.fi or permit2-rpc-manager, each holding a
 * record on a red tip that its head fails too (the live shape of
 * 2026-11-15). With no filing there is no base-repair task, so the runtime
 * cap that lands with this stage has nothing to cap.
 */
import assert from "node:assert/strict";
import { INACTIVE_CI_MINUTES } from "../../src/budget/ci-minutes.ts";
import type {
  RepairStateWriter,
  StateReadView,
} from "../../src/contracts/ports.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { RED_BASE_RECHECK_MS } from "../../src/repair/ci-first-policy.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { BASE_REPAIR_FILING_ENABLED } from "../../ops/hosted-autonomy-base-repair.ts";
import { runHostedAutonomy } from "../../ops/hosted-autonomy-runner.ts";
import type { HostedAutonomyGitHubV1 } from "../../ops/hosted-autonomy-types.ts";
import { SHA1, T0, workRecord } from "../state/helpers.ts";
import {
  snapshotOf,
  TransitionState,
  withDarkQueueAuthority,
} from "./hosted-autonomy-preservation-fixtures.ts";

const NOW = T0 + 6 * 60 * 60_000;
const TARGETS = ["ai.ubq.fi", "uusd.ubq.fi", "permit2-rpc-manager"];
/** Each target's red tip and its held record's head (both red on `validate`). */
const tip = (index: number) => `a${index}`.repeat(20);
const head = (index: number) => `b${index}`.repeat(20);

/** Issue `issue` of `name`, held by the CI-first gate on its red tip. */
function held(name: string, index: number, issue: number): WorkRecordV1 {
  const id = `issue-ubiquity-${name}-${issue}`;
  return workRecord(id, {
    repository: { owner: "ubiquity", name, installationId: 7 },
    source: { kind: "issue", id: String(issue), revision: SHA1 },
    related: { incidentId: null, issueNumber: issue },
    nextStep: "work",
    wait: {
      reason: "backoff",
      since: NOW - 60_000,
      until: NOW - 60_000 + RED_BASE_RECHECK_MS,
    },
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
    target: {
      base: tip(index),
      branch: candidateBranch(id as never),
      checkpoint: null,
      head: head(index),
      pr: 5000 + issue,
    },
  });
}

/** One target's fake GitHub: every base-repair read and create is recorded. */
function fakeTarget(index: number, reads: string[]): HostedAutonomyGitHubV1 {
  return {
    readDefaultBranch: () => Promise.resolve("development"),
    readBaseTip: () => Promise.resolve(tip(index)),
    hasSuccessfulCheck: () => Promise.resolve(false),
    hasAllChecksGreen: () => Promise.resolve(false),
    readPull: () => Promise.resolve(null),
    readIssueOpen: () => Promise.resolve(true),
    readIssueTask: () => Promise.resolve(null),
    readIssueOptedOut: () => Promise.resolve(false),
    merge: () => Promise.reject(new Error("nothing merges in this pass")),
    closeIssue: () => Promise.resolve(false),
    listParkedRuns: () => Promise.resolve([]),
    approveRun: () => Promise.resolve(false),
    failedChecks: (commit: string) => {
      reads.push(`checks:${commit}`);
      return Promise.resolve(["validate"]);
    },
    baseRepairIssues: {
      listAppAuthored: () => {
        reads.push("issues");
        return Promise.resolve([]);
      },
      create: () => {
        reads.push("create");
        return Promise.resolve(9000);
      },
    },
  } as unknown as HostedAutonomyGitHubV1;
}

Deno.test("base repair off: no target is read or filed for, ai.ubq.fi included, through the maintenance pass", async () => {
  assert.equal(BASE_REPAIR_FILING_ENABLED, false);
  const reads: Record<string, string[]> = {};
  const surfaces: Record<string, HostedAutonomyGitHubV1> = {};
  for (const [index, name] of TARGETS.entries()) {
    reads[name] = [];
    surfaces[name] = fakeTarget(index, reads[name]);
  }
  const records = TARGETS.map((name, index) => held(name, index, 40 + index));
  const state = new TransitionState(snapshotOf(records, []));
  const deps = await withDarkQueueAuthority({
    ciMinutes: INACTIVE_CI_MINUTES,
    state: state as unknown as StateReadView & RepairStateWriter,
    githubFor: (repository) => surfaces[repository.name] ?? null,
    clock: { now: () => NOW },
  });
  const progress: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => {
    try {
      const line = JSON.parse(String(args[0]));
      if (line?.kind === "sentinel_maintenance_progress") {
        progress.push(`${line.phase}:${line.event}`);
      }
    } catch {
      // Not a JSON line.
    }
  };
  try {
    for (let pass = 0; pass < 3; pass++) {
      const { actions } = await runHostedAutonomy(deps);
      assert.deepEqual(
        actions.filter((action) => action.startsWith("base-repair:")),
        [],
        `pass ${pass}`,
      );
    }
  } finally {
    console.log = log;
  }
  // The phase ran and did nothing: no check read, no listing, no create.
  assert.ok(progress.includes("base_repair:start"), progress.join(" "));
  assert.ok(progress.includes("base_repair:finish"), progress.join(" "));
  for (const name of TARGETS) assert.deepEqual(reads[name], [], name);
  assert.equal(state.writes, 0, "and no repair state write");
});
