import type { GitSha } from "../src/contracts/brands.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import { HOSTED_CONTROLLER_REPOSITORY } from "../src/contracts/hosted-controller-deployment.ts";
import { HOSTED_RUNTIME_ID } from "../src/contracts/hosted-supervisor.ts";
import {
  type CurrentMatrixIndexPortV1,
  type CurrentMatrixIndexV1,
  MATRIX_INDEX_RELEASE_REF,
  type MatrixHistoryPointV1,
  type MatrixProducerLocationV1,
  type MatrixProducerPlanMembershipV1,
  parseCurrentMatrixIndexV1,
  parseMatrixProducerPlanMembershipV1,
} from "../src/contracts/maintenance-index.ts";
import type {
  PortResultV1,
  StateReadResultV1,
} from "../src/contracts/ports.ts";
import type { ReleaseStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";

export type MatrixReleaseSnapshot = Extract<
  StateReadResultV1<ReleaseStateSnapshotV1>,
  { status: "found" }
>;
type ParentReader = (
  head: GitSha,
) => Promise<PortResultV1<StateReadResultV1<ReleaseStateSnapshotV1>>>;
const point = (row: MatrixReleaseSnapshot): MatrixHistoryPointV1 => ({
  head: row.head,
  sequence: row.snapshot.sequence,
});

async function location(
  row: MatrixReleaseSnapshot,
): Promise<MatrixProducerLocationV1 | null> {
  const runtime = row.snapshot.hostedRuntimes.find((r) =>
    r.id === HOSTED_RUNTIME_ID
  );
  const saved = runtime?.lastExecutionProof;
  if (
    !runtime || runtime.execution !== null || !saved ||
    saved.outcome === "not_started" || saved.execution.purpose !== "ordinary" ||
    saved.execution.releaseId !== null ||
    runtime.generation > saved.execution.generation
  ) {
    return null;
  }
  const bytes = new TextEncoder().encode(
    canonicalStringify({ ...saved, observedAt: 0 }),
  );
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return {
    ...point(row),
    execution: saved.execution,
    proofFingerprint: Array.from(
      new Uint8Array(hash),
      (x) => x.toString(16).padStart(2, "0"),
    ).join(""),
  };
}

/** Durable discovery ranges, never a replacement for producer consumption. */
export class CurrentMatrixScan {
  private dirty = false;
  private plansTrusted = true;
  private readonly learnedPlans = new Map<
    string,
    MatrixProducerPlanMembershipV1
  >();
  private constructor(
    private readonly port: CurrentMatrixIndexPortV1,
    private readonly expectedHead: GitSha | null,
    private readonly index: CurrentMatrixIndexV1,
    private readonly current: MatrixReleaseSnapshot,
    private readonly readParent: ParentReader,
    private readonly fault: (message: string) => Error,
  ) {}

  static async open(input: {
    port: CurrentMatrixIndexPortV1;
    current: MatrixReleaseSnapshot;
    readParent: ParentReader;
    fault: (message: string) => Error;
  }): Promise<CurrentMatrixScan | null> {
    let loaded: Awaited<ReturnType<CurrentMatrixIndexPortV1["read"]>>;
    try {
      loaded = await input.port.read();
    } catch {
      return null;
    }
    // Missing capability/read/corruption never means empty history. The caller
    // retains the complete original walk and does not overwrite unknown data.
    if (!loaded.ok) return null;
    let index: CurrentMatrixIndexV1;
    if (loaded.value.index === null && loaded.value.head === null) {
      index = {
        version: "v1",
        kind: "current_matrix_index",
        controller: HOSTED_CONTROLLER_REPOSITORY,
        releaseRef: MATRIX_INDEX_RELEASE_REF,
        anchor: point(input.current),
        ranges: [],
        producers: [],
      };
    } else {
      if (loaded.value.index === null || loaded.value.head === null) {
        return null;
      }
      try {
        index = parseCurrentMatrixIndexV1(loaded.value.index);
      } catch {
        return null;
      }
      // Every reused boundary is a freshly read strict ancestor of this exact
      // captured release head; a future/divergent index is left untouched.
      const points = [
        index.anchor,
        ...index.ranges.flatMap((r) =>
          r.next === null ? [r.from, r.through] : [r.from, r.through, r.next]
        ),
      ];
      const checked = new Set<string>();
      const sources = new Map<string, MatrixReleaseSnapshot>();
      for (const at of points) {
        if (checked.has(at.head)) continue;
        checked.add(at.head);
        const found = at.head === input.current.head
          ? { ok: true as const, value: input.current }
          : await input.readParent(at.head);
        if (
          !found.ok || found.value.status !== "found" ||
          found.value.head !== at.head ||
          found.value.snapshot.sequence !== at.sequence
        ) return null;
        sources.set(at.head, found.value);
      }
      for (const range of index.ranges) {
        if (
          sources.get(range.through.head)?.snapshot.stateHead !==
            (range.next?.head ?? null)
        ) return null;
      }
      index.anchor = point(input.current);
    }
    return new CurrentMatrixScan(
      input.port,
      loaded.value.head,
      index,
      input.current,
      input.readParent,
      input.fault,
    );
  }

  private async read(at: MatrixHistoryPointV1): Promise<MatrixReleaseSnapshot> {
    const read = await this.readParent(at.head);
    if (
      !read.ok || read.value.status !== "found" ||
      read.value.head !== at.head ||
      read.value.snapshot.sequence !== at.sequence
    ) {
      throw this.fault("current matrix history ancestry unavailable");
    }
    return read.value;
  }

  private async remember(
    row: MatrixReleaseSnapshot,
    next: MatrixHistoryPointV1 | null,
  ) {
    const from = point(row);
    this.index.ranges.push({ from, through: from, next });
    this.index.ranges.sort((a, b) => b.from.sequence - a.from.sequence);
    const merged: CurrentMatrixIndexV1["ranges"] = [];
    for (const range of this.index.ranges) {
      const prior = merged.at(-1);
      if (
        prior?.next?.head === range.from.head &&
        prior.next.sequence === range.from.sequence
      ) {
        prior.next = range.next;
        prior.through = range.through;
      } else {
        merged.push(range);
      }
    }
    this.index.ranges = merged;
    const producer = await location(row);
    if (producer !== null) {
      const existing = this.index.producers.find((p) =>
        canonicalStringify(p.execution) ===
          canonicalStringify(producer.execution) &&
        p.proofFingerprint === producer.proofFingerprint
      );
      const learned = this.learnedPlans.get(this.producerKey(producer));
      if (learned !== undefined) producer.plan = learned;
      else if (existing?.plan !== undefined) producer.plan = existing.plan;
      if (existing === undefined) this.index.producers.push(producer);
      else if (existing.sequence < producer.sequence) {
        Object.assign(existing, producer);
      }
    }
    this.dirty = true;
  }

  private producerKey(producer: MatrixProducerLocationV1): string {
    return canonicalStringify({
      execution: producer.execution,
      proofFingerprint: producer.proofFingerprint,
    });
  }

  /** Only an authenticated complete plan can teach a positive membership. */
  async rememberPlan(
    row: MatrixReleaseSnapshot,
    input: MatrixProducerPlanMembershipV1,
  ): Promise<void> {
    if (!this.plansTrusted) return;
    const producer = await location(row);
    if (producer === null) return;
    const plan = parseMatrixProducerPlanMembershipV1(input);
    const key = this.producerKey(producer);
    const existing = this.index.producers.find((p) =>
      this.producerKey(p) === key
    );
    const prior = this.learnedPlans.get(key) ?? existing?.plan;
    if (
      prior !== undefined &&
      canonicalStringify(prior) !== canonicalStringify(plan)
    ) {
      // A sidecar contradiction cannot turn a freshly proved consumer result
      // into a failure or authorize replacing unknown acceleration metadata.
      this.plansTrusted = false;
      this.learnedPlans.clear();
      return;
    }
    // An uncached source enters the index only after its parent was proved.
    this.learnedPlans.set(key, plan);
    if (existing !== undefined && existing.plan === undefined) {
      existing.plan = plan;
      this.dirty = true;
    }
  }

  /** Positive membership refuses irrelevant work; never authorizes an effect. */
  async planMembership(
    row: MatrixReleaseSnapshot,
    reservationIds: readonly string[],
  ): Promise<"unknown" | "matching" | "disjoint"> {
    if (!this.plansTrusted || reservationIds.length === 0) return "unknown";
    const source = await location(row);
    if (source === null) return "unknown";
    const producer = this.index.producers.find((p) =>
      p.head === source.head && p.sequence === source.sequence &&
      this.producerKey(p) === this.producerKey(source)
    );
    if (producer?.plan === undefined) return "unknown";
    return reservationIds.every((id) =>
        !producer.plan!.reservationIds.includes(id)
      )
      ? "disjoint"
      : "matching";
  }

  /** Yields strict source snapshots; only previously verified nonproducers skip. */
  async *walk(step: () => boolean): AsyncGenerator<MatrixReleaseSnapshot> {
    let row = this.current;
    const seen = new Set<string>();
    while (true) {
      if (seen.has(row.head)) throw this.fault("current matrix history cycle");
      seen.add(row.head);
      const range = this.index.ranges.find((r) =>
        row.snapshot.sequence <= r.from.sequence &&
        row.snapshot.sequence > (r.next?.sequence ?? 0)
      );
      if (range !== undefined) {
        const producers = this.index.producers.filter((p) =>
          p.sequence <= row.snapshot.sequence &&
          p.sequence > (range.next?.sequence ?? 0)
        )
          .sort((a, b) => b.sequence - a.sequence);
        for (const producer of producers) {
          // Reused discovery keeps the same reserve as an uncached walk,
          // before each read, including reads that may fail or be unavailable.
          if (!step()) return;
          const source = producer.head === row.head
            ? row
            : await this.read(producer);
          const actual = await location(source);
          const recorded = {
            head: producer.head,
            sequence: producer.sequence,
            execution: producer.execution,
            proofFingerprint: producer.proofFingerprint,
          };
          if (
            actual === null ||
            canonicalStringify(actual) !== canonicalStringify(recorded)
          ) {
            throw this.fault("current matrix producer ancestry changed");
          }
          yield source;
        }
        if (range.next === null || !step()) return;
        row = await this.read(range.next);
        continue;
      }
      yield row;
      const parent = row.snapshot.stateHead;
      if (parent === null) {
        if (row.snapshot.sequence !== 1) {
          throw this.fault("current matrix history root unavailable");
        }
        await this.remember(row, null);
        return;
      }
      if (!step()) return;
      if (seen.has(parent)) throw this.fault("current matrix history cycle");
      const prior = await this.read({
        head: parent,
        sequence: row.snapshot.sequence - 1,
      });
      // Advance durable discovery only after the parent/sequence proof passed.
      await this.remember(row, point(prior));
      row = prior;
    }
  }

  async save(): Promise<void> {
    if (!this.dirty || !this.plansTrusted) return;
    // A conflict/lost response affects acceleration only. No retry or overwrite;
    // a fresh invocation reads the winning sidecar and authoritative state.
    let outcome = "unavailable";
    try {
      const saved = await this.port.write({
        expectedHead: this.expectedHead,
        index: this.index,
      });
      if (saved.ok) outcome = saved.value.status;
    } catch { /* The original history remains the recovery source. */ }
    try {
      console.log(JSON.stringify({
        kind: "sentinel_current_matrix_index",
        outcome,
        ranges: this.index.ranges.length,
        producers: this.index.producers.length,
      }));
    } catch { /* Advisory output cannot change recovery. */ }
  }
}
