/** One authoritative coordinator; only native session settlement overlaps. */
import { createRepairInvocation, type RepairInvocationV1 } from "../main.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import type {
  RepairCycleOptionsV1,
  RepairCycleOutcomeV1,
} from "../repair/loop.ts";
import { OPERATION_MARGIN_MS } from "../repair/loop-bounds.ts";
import { reviewOperationKey } from "../repair/keys.ts";
import { standingReviewAttempt } from "../repair/loop-review-records.ts";
import {
  logTargetTiming,
  type TargetTimingCountsV1,
} from "../repair/timing-lines.ts";
import type {
  ActionsTargetCyclesInputV1,
  ActionsTargetCyclesResultV1,
} from "./actions-target-cycles.ts";

export function createActionsTargetFlow(
  input: ActionsTargetCyclesInputV1,
  cycleOptions: Pick<RepairCycleOptionsV1, "matrixIntakeOwnsBranches"> = {},
) {
  const origin = input.runOrigin ?? input.clock.now();
  // A model-disabled bootstrap execution still prepares every target (the
  // bootstrap contract's source intake) and dispatches pre-merge CI; only the
  // work-record walk is skipped (issue #297).
  const bootstrap = input.bootstrap === true ||
    input.host?.execution.purpose === "bootstrap";
  const addressed: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  const listeners = new Set<() => void>();
  let outcome: RepairCycleOutcomeV1 | null = null;
  let cursor = 0;
  let fault: unknown;
  let failedAdvance = false;
  let advancing = false;
  let finalized: Promise<ActionsTargetCyclesResultV1> | null = null;
  const slots = input.configs.map((config) => ({
    config,
    status: "new" as "new" | "ready" | "waiting" | "done",
    invocation: null as RepairInvocationV1 | null,
    before: null as readonly WorkRecordV1[] | null,
    wake: new Set<string>(),
    completions: new Set<string>(),
    unsubscribe: null as (() => void) | null,
    // Advisory monotonic wall times (`sentinel_target_timing`); never read
    // back and never the injected run clock.
    timing: null as TargetTimingCountsV1 | null,
  }));
  const slug = (config: RepositoryConfigV1) =>
    config.repository.owner + "/" + config.repository.name;
  /** Await `work`, adding its monotonic wall time to one timing field. */
  const timed = async <T>(
    slot: (typeof slots)[number],
    field: Exclude<keyof TargetTimingCountsV1, "advances">,
    work: () => Promise<T>,
  ): Promise<T> => {
    const started = performance.now();
    try {
      return await work();
    } finally {
      slot.timing ??= {
        prepareMs: 0,
        premergeMs: 0,
        progressMs: 0,
        cycleMs: 0,
        advances: 0,
        finishMs: 0,
      };
      slot.timing[field] += performance.now() - started;
    }
  };
  const snapshot = async () => {
    try {
      const read = await input.state.readRepair();
      return read.ok && read.value.status === "found"
        ? read.value.snapshot.work
        : null;
    } catch {
      return null;
    }
  };
  /**
   * One read shared by every caller until it fails; a failed read is retried
   * by the next caller, exactly as an unshared read would be.
   */
  const sharedSnapshot = () => {
    let shared: Promise<readonly WorkRecordV1[] | null> | null = null;
    return async () => {
      const read = await (shared ??= snapshot());
      if (read === null) shared = null;
      return read;
    };
  };
  // Progress comments' baseline when the caller passed none: one target's
  // cycle changes only its own target's records, so the state before the
  // first cycle is every target's state before its own cycle (the serial
  // aggregate passes such a baseline itself).
  const progressBaseline = sharedSnapshot();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  /** False when that target's cycle ended (or never existed): nothing woke. */
  const wake = (
    config: RepositoryConfigV1,
    ids: readonly string[],
  ): boolean => {
    const slot = slots.find((entry) =>
      entry.config.repository.owner === config.repository.owner &&
      entry.config.repository.name === config.repository.name &&
      entry.config.repository.installationId ===
        config.repository.installationId
    );
    if (slot === undefined || slot.status === "done") return false;
    for (const id of ids) slot.wake.add(id);
    if (slot.status === "waiting") slot.status = "ready";
    notify();
    return true;
  };
  const advance = async (): Promise<boolean> => {
    if (advancing || finalized !== null) {
      throw new Error("target advances must be serial");
    }
    advancing = true;
    try {
      const start = cursor;
      for (let offset = 0; offset < slots.length; offset++) {
        const index = (start + offset) % slots.length;
        const slot = slots[index];
        if (slot.status !== "new" && slot.status !== "ready") continue;
        cursor = (index + 1) % slots.length;
        const config = slot.config;
        if (
          !(input.clock.now() < input.deadline) ||
          (slot.status === "new" && addressed.length > 0 &&
            input.deadline - input.clock.now() < OPERATION_MARGIN_MS)
        ) {
          slot.status = "done";
          if (slot.invocation === null) skipped.push(slug(config));
          continue;
        }
        if (slot.status === "new") {
          try {
            await timed(slot, "prepareMs", async () => {
              await input.prepareTarget?.(config);
            });
          } catch (error) {
            failed.push(
              slug(config) + ": " +
                (error instanceof Error
                  ? error.message
                  : "target preparation failed"),
            );
            slot.status = "done";
            continue;
          }
          if (!(input.clock.now() < input.deadline)) {
            skipped.push(slug(config));
            slot.status = "done";
            continue;
          }
          addressed.push(slug(config));
          try {
            await timed(slot, "premergeMs", async () => {
              await input.premergeCi?.(config);
            });
          } catch (error) {
            console.log(
              JSON.stringify({
                kind: "sentinel_premerge_ci",
                repository: slug(config),
                decision: "failed",
                detail: error instanceof Error
                  ? error.message
                  : "pre-merge CI dispatch failed",
              }),
            );
          }
          const capabilities = input.resolveTargetCapabilities?.(config) ??
            input;
          slot.before = input.progressComments === undefined
            ? null
            : input.progressBaseline ??
              await timed(slot, "progressMs", progressBaseline);
          const github = input.composeGithub(config);
          const deps = {
            clock: input.clock,
            state: input.state,
            configs: [config],
            controllerSha: input.controllerSha,
            github,
            githubCooldown: input.githubCooldown,
            incidents: capabilities.incidents,
            replay: capabilities.replay,
            model: input.model,
            budget: input.budget,
            ciMinutes: input.ciMinutes,
            externalImplementations: input.externalImplementations,
            recordWaitCauses: input.recordWaitCauses,
            legacyReviewCutoff: input.legacyReviewCutoff ?? null,
          };
          const options = {
            ...cycleOptions,
            deadline: input.deadline,
            stepLimit: input.stepLimit,
            modelStartsEnabled: input.modelStartsEnabled,
            // A model-disabled bootstrap execution performs intake, maintenance
            // and health only: it never walks the work queue (issue #297).
            bootstrap,
            runStartedAt: origin,
            // #328: the records this run's repository cells step.
            ...(input.excludeRecords === undefined
              ? {}
              : { excludeRecords: input.excludeRecords }),
          };
          if (input.runCycle !== undefined) {
            // The existing deterministic test seam; never used by production.
            const runCycle = input.runCycle;
            outcome = await timed(
              slot,
              "cycleMs",
              () => runCycle(deps, options),
            );
            slot.timing!.advances++;
            slot.status = "done";
            return true;
          }
          slot.invocation = createRepairInvocation(deps, options);
          slot.unsubscribe = github.onReviewCompletion?.((key) => {
            slot.completions.add(key);
            if (slot.status === "waiting") slot.status = "ready";
            notify();
          }) ?? null;
          slot.status = "ready";
        }
        if (slot.completions.size > 0) {
          const read = await input.state.readRepair();
          if (!read.ok || read.value.status !== "found") {
            throw new Error("review completion state unavailable");
          }
          for (const record of read.value.snapshot.work) {
            if (
              record.repository.owner !== config.repository.owner ||
              record.repository.name !== config.repository.name ||
              record.repository.installationId !==
                config.repository.installationId ||
              record.nextStep !== "review" || record.target.pr === null ||
              record.target.head === null
            ) continue;
            if (
              slot.completions.has(
                reviewOperationKey(
                  record.target.pr,
                  record.target.head,
                  standingReviewAttempt(record),
                ),
              )
            ) slot.wake.add(record.id);
          }
          slot.completions.clear();
        }
        const invocation = slot.invocation!;
        const woken = [...slot.wake];
        const result = await timed(
          slot,
          "cycleMs",
          () => invocation.advance(woken),
        );
        slot.timing!.advances++;
        slot.wake.clear();
        if (result.kind !== "progress") {
          outcome = result.outcome;
          slot.status = result.kind === "done" ? "done" : "waiting";
          // No lost completion between the awaited operation and its waiting state.
          if (slot.status === "waiting" && slot.completions.size > 0) {
            slot.status = "ready";
          }
        }
        return true;
      }
      return false;
    } catch (error) {
      failedAdvance = true;
      fault = error;
      throw error;
    } finally {
      advancing = false;
    }
  };
  const waitForReady = (signal: AbortSignal): Promise<void> => {
    if (
      signal.aborted ||
      slots.some((slot) => slot.status === "new" || slot.status === "ready")
    ) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        listeners.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      listeners.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  };
  const finish = async (): Promise<ActionsTargetCyclesResultV1> => {
    try {
      // Native drains overlap, but each settled target's continuation runs
      // immediately and serially instead of waiting for unrelated producers.
      const pending = new Map(slots.map((slot, index) => [
        index,
        // finish reuses the same memoized drain, including any rejection.
        Promise.resolve(slot.invocation?.drain()).then(
          () => index,
          () => index,
        ),
      ]));
      const outcomes = new Map<number, RepairCycleOutcomeV1>();
      const faults = new Map<number, unknown>();
      // With no invocation (the planner's runCycle seam) every cycle settled
      // inside `advance`, so no lifecycle work runs between the targets'
      // progress comments and they share one after-state read. A settled
      // invocation's continuation may write before the next target's
      // comments, so real invocations keep one read each.
      const afterState = slots.every((slot) => slot.invocation === null)
        ? sharedSnapshot()
        : snapshot;
      while (pending.size > 0) {
        const index = await Promise.race(pending.values());
        pending.delete(index);
        const slot = slots[index];
        try {
          const invocation = slot.invocation;
          if (invocation !== null) {
            outcomes.set(
              index,
              await timed(slot, "finishMs", () => invocation.finish()),
            );
          }
        } catch (error) {
          faults.set(index, error);
        }
        const progressComments = input.progressComments;
        const before = slot.before;
        if (progressComments !== undefined && before !== null) {
          try {
            await timed(slot, "progressMs", async () => {
              const after = await afterState();
              if (after !== null) {
                await progressComments(slot.config, before, after);
              }
            });
          } catch { /* advisory progress comments never fail lifecycle work */ }
        }
        if (slot.timing !== null) {
          logTargetTiming(slug(slot.config), slot.timing);
        }
      }
      // Keep the public disposition and first-fault precedence in setting
      // order, independently of native completion order. Every drain is done.
      for (const index of slots.keys()) {
        if (outcomes.has(index)) outcome = outcomes.get(index)!;
        if (!failedAdvance && faults.has(index)) {
          failedAdvance = true;
          fault = faults.get(index);
        }
      }
      if (failedAdvance) throw fault;
      return { outcome, addressed, skipped, failed };
    } finally {
      for (const slot of slots) slot.unsubscribe?.();
      notify();
      input.report?.({
        outcome,
        addressed: [...addressed],
        skipped: [...skipped],
        failed: [...failed],
      });
    }
  };
  return { advance, wake, waitForReady, finish: () => finalized ??= finish() };
}
