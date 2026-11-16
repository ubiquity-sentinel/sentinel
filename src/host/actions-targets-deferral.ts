/**
 * A hosted pass whose committed targets were all unreadable (supervisor run
 * 43790005563, 2026-11-16: every default-branch read of the serial repair job
 * failed during a GitHub 403 burst and the job threw `targets_empty`).
 *
 * The setting listed repositories and `loadTargetConfigsV1` skipped every one
 * because a read could not prove an answer. That is unavailability, never an
 * empty setting (which still refuses with `STATIC_TARGETS_EMPTY` before this
 * module is reached), so:
 *
 * - an ordinary pass defers: one text-free advisory line (reason code and
 *   counts), the actual startup probe, and the one child result with the
 *   idle outcome `STATIC_TARGETS_DEFERRED`. Nothing after the target load runs
 *   (no queue custody, owner-successor phase, target cycle, ingestion, CI
 *   approval or model start), so the pass writes nothing an idle pass would
 *   not: exactly what the former throw left, minus the red job. A matrix
 *   planner then publishes its empty zero-grant plan and a repository cell
 *   its refusal (`settleTargetsDeferral`), as for a cell whose own target is
 *   not configured;
 * - a verification execution (bootstrap, prior, candidate, rollback) and an
 *   admitted matrix cell fail with `STATIC_TARGETS_UNAVAILABLE`: unavailable
 *   evidence never passes an install or rollback gate, and a granted cell
 *   that cannot run keeps its charge unreconciled for the existing recovery
 *   instead of writing a `not_started` park.
 */
import type { GitSha } from "../contracts/brands.ts";
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import { targetsDeferralLineV1 } from "../repair/targets-deferral-line.ts";
import {
  type ActionsRepairHostDepsV1,
  type ActionsRepairHostResultV1,
  STATIC_PREFLIGHT,
} from "./actions-target-cycles.ts";
import {
  STATIC_TARGETS_DEFERRED,
  STATIC_TARGETS_UNAVAILABLE,
  type UnavailableTargetCountsV1,
} from "./targets.ts";

/** Settle one pass whose every committed target read was unavailable. */
export async function settleUnavailableTargetsV1(input: {
  counts: UnavailableTargetCountsV1;
  job: ActionsRepairHostDepsV1["job"];
  execution: HostedExecutionIntentV1;
  controllerSha: GitSha;
  baseSha: string;
  login: string;
  /** The actual startup probe; a rejection is an unready startup. */
  probeStartup: () => Promise<void>;
  /** The job's own artifact for the deferral (a repository cell's refusal). */
  settle?: () => Promise<void>;
}): Promise<ActionsRepairHostResultV1> {
  try {
    const line = targetsDeferralLineV1(input.counts);
    if (line !== null) console.log(JSON.stringify(line));
  } catch {
    // Advisory only.
  }
  if (input.execution.purpose !== "ordinary" || input.job === "matrix_cell") {
    throw new Error(STATIC_TARGETS_UNAVAILABLE);
  }
  await input.settle?.();
  let startupReady = false;
  try {
    await input.probeStartup();
    startupReady = true;
  } catch {
    startupReady = false;
  }
  const result: ActionsRepairHostResultV1 = {
    status: "ran",
    outcome: { status: "idle", detail: STATIC_TARGETS_DEFERRED },
    controllerSha: input.controllerSha,
    baseSha: input.baseSha,
    login: input.login,
    startupReady,
    ciApproval: { approved: 0, pending: 0, unavailable: 0 },
    execution: input.execution,
  };
  console.log(JSON.stringify(result));
  // As for every other pass: a deferral never hides an unavailable startup.
  if (!startupReady) throw new Error(STATIC_PREFLIGHT);
  return result;
}
