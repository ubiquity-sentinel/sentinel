/** One authoritative coordinator; only native session settlement overlaps. */
import { createRepairInvocation, type RepairInvocationV1 } from "../main.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import type { RepairCycleOutcomeV1 } from "../repair/loop.ts";
import { OPERATION_MARGIN_MS } from "../repair/loop-bounds.ts";
import { reviewOperationKey } from "../repair/keys.ts";
import { standingReviewAttempt } from "../repair/loop-review-records.ts";
import type {
  ActionsTargetCyclesInputV1,
  ActionsTargetCyclesResultV1,
} from "./actions-target-cycles.ts";

export function createActionsTargetFlow(input: ActionsTargetCyclesInputV1) {
  const origin = input.runOrigin ?? input.clock.now();
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
  }));
  const slug = (config: RepositoryConfigV1) =>
    config.repository.owner + "/" + config.repository.name;
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
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const wake = (config: RepositoryConfigV1, ids: readonly string[]) => {
    const slot = slots.find((entry) =>
      entry.config.repository.owner === config.repository.owner &&
      entry.config.repository.name === config.repository.name &&
      entry.config.repository.installationId ===
        config.repository.installationId
    );
    if (slot === undefined || slot.status === "done") return;
    for (const id of ids) slot.wake.add(id);
    if (slot.status === "waiting") slot.status = "ready";
    notify();
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
            await input.prepareTarget?.(config);
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
            await input.premergeCi?.(config);
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
            : input.progressBaseline ?? await snapshot();
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
            externalImplementations: input.externalImplementations,
            legacyReviewCutoff: input.legacyReviewCutoff ?? null,
          };
          const options = {
            deadline: input.deadline,
            stepLimit: input.stepLimit,
            modelStartsEnabled: input.modelStartsEnabled,
            runStartedAt: origin,
          };
          if (input.runCycle !== undefined) {
            // The existing deterministic test seam; never used by production.
            outcome = await input.runCycle(deps, options);
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
        const result = await slot.invocation!.advance([...slot.wake]);
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
      while (pending.size > 0) {
        const index = await Promise.race(pending.values());
        pending.delete(index);
        const slot = slots[index];
        try {
          if (slot.invocation !== null) {
            outcomes.set(index, await slot.invocation.finish());
          }
        } catch (error) {
          faults.set(index, error);
        }
        if (input.progressComments !== undefined && slot.before !== null) {
          try {
            const after = await snapshot();
            if (after !== null) {
              await input.progressComments(slot.config, slot.before, after);
            }
          } catch { /* advisory progress comments never fail lifecycle work */ }
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
