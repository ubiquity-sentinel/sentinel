/**
 * The serial pass's unchanged-input gate (issue #326).
 *
 * Before the pass steps a ranked record it compares the record's current
 * fingerprint (`step-inputs.ts`) with the stamp its last settled step left.
 * An equal fingerprint whose deadline has not elapsed is skipped with no
 * write, no charge and no per-record read beyond the repository's one batched
 * read. A record stepped by this pass settles when its step deferred or
 * yielded; its new stamp is pending until the next trusted write of this pass
 * carries it, or the one closing write `flush` performs when nothing else
 * wrote. Every skip is counted by reason for the pass summary.
 */
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { PassLiveInputs } from "./loop-live-inputs.ts";
import { persistTransition } from "./loop-state.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  RunBoundsV1,
  StepResultV1,
} from "./loop-types.ts";
import {
  type PassSummaryCountsV1,
  passSummaryLine,
} from "./pass-summary-line.ts";
import { rearmedObservation } from "./step-observation.ts";
import {
  type PendingStepInputsV1,
  stepContent,
  stepDeadline,
  stepFingerprint,
  type StepInputGatesV1,
} from "./step-inputs.ts";

export class StepInputGate {
  readonly pending = new Map<string, PendingStepInputsV1>();
  private readonly live: PassLiveInputs;
  private readonly unchanged = new Set<string>();
  private readonly waiting = new Set<string>();
  private readonly stepped = new Set<string>();

  constructor(
    private readonly deps: RepairCycleDepsV1,
    private readonly bounds: RunBoundsV1,
    private readonly gates: StepInputGatesV1,
  ) {
    this.live = new PassLiveInputs(deps, bounds);
  }

  /** One batched read per repository holding any of these records. */
  async prime(records: readonly WorkRecordV1[]): Promise<void> {
    if (this.deps.clock.now() >= this.bounds.runDeadline) return;
    await this.live.prime(records);
  }

  /** Records the ranking skipped because their explicit wait is running. */
  noteWaiting(skipped: Record<string, string>): void {
    for (const [id, reason] of Object.entries(skipped)) {
      if (reason === "waiting" && !this.stepped.has(id)) this.waiting.add(id);
    }
  }

  /**
   * True when `record` is skipped on unchanged inputs. Reads the record's
   * inputs (once per pass) first, so a record stepped below settles against
   * the inputs observed before its step.
   */
  async skips(context: LoopContextV1, record: WorkRecordV1): Promise<boolean> {
    if (this.unchanged.has(record.id)) return true;
    if (this.stepped.has(record.id)) return false;
    const inputs = await this.live.inputsFor(record);
    const stamp = record.stepInputs;
    if (
      inputs === null || stamp === undefined ||
      this.deps.clock.now() >= stamp.deadline
    ) return false;
    const digest = await stepFingerprint(
      this.deps,
      this.gates,
      context.snapshot,
      record,
      inputs,
    );
    if (digest !== stamp.digest) return false;
    this.unchanged.add(record.id);
    this.waiting.delete(record.id);
    return true;
  }

  /** The record is about to be stepped: its earlier settlement is void. */
  beginStep(id: string): void {
    this.pending.delete(id);
    this.unchanged.delete(id);
    this.waiting.delete(id);
    this.stepped.add(id);
  }

  /**
   * Settle the stepped record: a deferral, progress that yields the record
   * to a later invocation, or progress that only re-armed an observation
   * wait of `before` (the row the step was selected as; see
   * `step-observation.ts`) stamps the record's current content with the
   * inputs read before its step. Any other result keeps no stamp pending.
   */
  async settle(
    context: LoopContextV1,
    id: string,
    result: StepResultV1,
    before?: WorkRecordV1,
  ): Promise<void> {
    const record = context.snapshot.work.find((row) => row.id === id);
    const settled = result.kind === "deferred" ||
      (result.kind === "progress" &&
        (result.yield === true ||
          (before !== undefined && record !== undefined &&
            rearmedObservation(before, record, this.deps.clock.now()))));
    if (
      !settled || record === undefined || record.nextStep === "done" ||
      record.nextStep === "blocked"
    ) {
      this.pending.delete(id);
      return;
    }
    const inputs = await this.live.inputsFor(record);
    if (inputs === null) {
      this.pending.delete(id);
      return;
    }
    const now = this.deps.clock.now();
    const digest = await stepFingerprint(
      this.deps,
      this.gates,
      context.snapshot,
      record,
      inputs,
    );
    this.pending.set(id, {
      content: stepContent(record),
      stamp: { digest, deadline: stepDeadline(record, now) },
    });
  }

  /**
   * The pass's one closing write for stamps no other write carried. Advisory:
   * nothing is written past the run deadline or when no pending stamp still
   * describes its record, and a refused write only drops the stamps (those
   * records are stepped again by a later pass).
   */
  async flush(context: LoopContextV1): Promise<void> {
    const applicable = [...this.pending].some(([id, settled]) => {
      const record = context.snapshot.work.find((row) => row.id === id);
      return record !== undefined && stepContent(record) === settled.content &&
        (record.stepInputs?.digest !== settled.stamp.digest ||
          record.stepInputs.deadline !== settled.stamp.deadline);
    });
    if (!applicable || this.deps.clock.now() >= this.bounds.runDeadline) {
      this.pending.clear();
      return;
    }
    try {
      await persistTransition(this.deps, context, () => {});
    } catch { /* advisory */ }
    this.pending.clear();
  }

  summary(): PassSummaryCountsV1 {
    const unchanged = this.unchanged.size;
    const waiting = [...this.waiting].filter((id) => !this.stepped.has(id))
      .length;
    return {
      recordsRead: this.live.metrics.recordsRead,
      recordsStepped: this.stepped.size,
      recordsSkipped: unchanged + waiting,
      skipReasons: { unchanged_inputs: unchanged, waiting },
      batchReads: this.live.metrics.batchReads,
      batchUnavailable: this.live.metrics.batchUnavailable,
    };
  }

  /**
   * Print the one advisory pass summary when the pass read, stepped or
   * skipped any record (a pass over no live record prints nothing); never
   * throws.
   */
  log(): void {
    try {
      const summary = this.summary();
      if (
        summary.recordsRead + summary.recordsStepped + summary.recordsSkipped +
            summary.batchReads + summary.batchUnavailable === 0
      ) return;
      const line = passSummaryLine(summary);
      if (line !== null) console.log(line);
    } catch { /* advisory only */ }
  }
}
