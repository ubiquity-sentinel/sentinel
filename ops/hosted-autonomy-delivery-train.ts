/**
 * One validated delivery train per repository per pass (sentinel #330).
 *
 * Landing k ready reviewed records one merge at a time moved the base k
 * times, so each next record refreshed, re-ran its CI and could be reviewed
 * again: k serial refresh+CI cycles over k passes. A train lands them on one
 * CI run instead. For each foreign, non-Gateway repository the delivery pass:
 *
 * 1. collects the ready reviewed records (`trainShaped`, `trainMemberGate`,
 *    `trainAdmissionRefusal`) in line order (oldest `createdAt`, then id);
 * 2. composes T' = tip ⊕ p1 ⊕ … ⊕ pk with the deterministic merge-tree
 *    executor; a member that conflicts or whose patch would not be carried
 *    byte for byte leaves the train (it keeps the single head-of-line
 *    refresh) and never holds it; each member's commit and patch digest is
 *    its recorded proof against the base it will land on;
 * 3. persists the train intent, publishes T' on the operation-bound train
 *    ref `refs/heads/sentinel-trains/<operation id>` (the push runs the
 *    target's own CI; a configured `triggerCi` requests it explicitly) and
 *    reads its CI through the existing read path (backup stand-ins and
 *    never-started runs exactly as every merge gate reads them);
 * 4. when green, merges the k pull requests in order, each under its own
 *    expected-head guard and per-target merge method, each preceded by a
 *    persisted merge intent and followed by its verified landing (parent
 *    exactly the tip the previous member left, tree exactly the train
 *    commit's tree after that member), so its review stays bound by its
 *    carried patch and no merge is ever unrecorded;
 * 5. when red, drops the newest member (its wait reason: the failed run id
 *    and check name) and retries once in the same pass; a second red
 *    dissolves the train. An unreadable or pending CI is not red: the train
 *    waits, at most `DELIVERY_TRAIN_CI_WAIT_MS`.
 *
 * While a repository's train is open nothing else of that repository is
 * merged by the per-record path (it would move the tip under the train). The
 * run-window deadline is checked at the top of every iteration; an admitted
 * merge still settles. Self and Gateway records never train: their merge
 * writes delivery state and ends the delivery phase exactly as before.
 */
import { isGatewayVpsRepository } from "../src/repair/vps-delivery.ts";
import { hostedRepositoryKey, isHostedSelf } from "./hosted-autonomy-policy.ts";
import { hostedPassDeadlineReached } from "./hosted-autonomy-scopes.ts";
import {
  trainAdmissionRefusal,
  trainCiVerdict,
  trainMemberGate,
  trainShaped,
} from "./hosted-autonomy-train-members.ts";
import { mergeTrain } from "./hosted-autonomy-train-merge.ts";
import {
  type DeliveryTrainPassInputV1,
  type DeliveryTrainPassV1,
  newTrain,
  type Outcome,
  staleWith,
  TrainRun,
} from "./hosted-autonomy-train-run.ts";
import {
  DELIVERY_TRAIN_CI_WAIT_MS,
  DELIVERY_TRAIN_MAX_DROPS,
  DELIVERY_TRAIN_MAX_MEMBERS,
  type DeliveryTrainComposerV1,
  type DeliveryTrainDropV1,
  type DeliveryTrainMemberV1,
  type DeliveryTrainRefV1,
  type DeliveryTrainV1,
} from "./hosted-autonomy-train-types.ts";
import type { HostedAutonomyPassContextV1 } from "./hosted-autonomy-scopes.ts";
import type { HostedAutonomyRecordV1 } from "./hosted-autonomy-types.ts";

export type {
  DeliveryTrainPassInputV1,
  DeliveryTrainPassV1,
} from "./hosted-autonomy-train-run.ts";

/** Build, publish and read the CI of one repository's train. */
class RepositoryTrain extends TrainRun {
  async build(group: readonly HostedAutonomyRecordV1[]): Promise<Outcome> {
    const tip = await this.context.readTip(this.scope);
    if (this.late()) return "deferred";
    if (tip === null) return "done";
    const admitted: {
      record: HostedAutonomyRecordV1;
      receiptId: string;
    }[] = [];
    for (const record of group) {
      if (this.late()) return "deferred";
      if (admitted.length >= DELIVERY_TRAIN_MAX_MEMBERS) break;
      if (this.held.has(record.id) || !trainShaped(this.context, record)) {
        continue;
      }
      const drop = this.ledger.drops.find((row) =>
        row.recordId === record.id && row.head === record.target.head &&
        row.tip === tip
      );
      if (drop !== undefined) {
        this.act(
          `delivery:${record.id}:train_wait:run=${
            drop.runId ?? "unknown"
          }:check=${drop.check ?? "unknown"}`,
        );
        continue;
      }
      const gate = await trainMemberGate(
        this.context,
        this.scope,
        record,
        null,
      );
      if (this.late()) return "deferred";
      // A refused record keeps the per-record path, which reports it.
      if (gate.refusal !== null) continue;
      const refusal = await trainAdmissionRefusal(this.scope, record);
      if (this.late()) return "deferred";
      if (refusal !== null) continue;
      admitted.push({ record, receiptId: gate.receipt.id });
    }
    // One reviewed head already on the tip merges exactly as before.
    if (
      admitted.length === 0 ||
      (admitted.length === 1 && admitted[0].record.target.base === tip)
    ) return "done";
    let steps = null;
    try {
      steps = await this.composer.compose({
        tip,
        members: admitted.map(({ record }) => ({
          head: record.target.head!,
          base: record.target.base!,
        })),
      });
    } catch {
      steps = null;
    }
    if (this.late()) return "deferred";
    if (steps === null || steps.length !== admitted.length) {
      this.act(`train:${this.key}:compose_unavailable`);
      return "done";
    }
    const members: DeliveryTrainMemberV1[] = [];
    steps.forEach((step, index) => {
      const { record, receiptId } = admitted[index];
      if (step.status !== "joined") {
        this.act(`delivery:${record.id}:train_left:${step.status}`);
        return;
      }
      members.push({
        recordId: record.id,
        pullRequest: record.target.pr!,
        head: record.target.head!,
        base: record.target.base!,
        receiptId,
        commit: step.commit,
        patch: step.patch,
        landedOn: null,
        revision: null,
      });
    });
    if (
      members.length === 0 || (members.length === 1 && members[0].base === tip)
    ) return "done";
    return await this.start(
      newTrain(this.key, tip, 1, members, this.context.deps.clock.now()),
      this.ledger.drops,
    );
  }

  /** Persist the train intent, report each member's proof, publish it. */
  async start(
    train: DeliveryTrainV1,
    drops: readonly DeliveryTrainDropV1[],
    stale: readonly DeliveryTrainRefV1[] = this.ledger.stale,
  ): Promise<Outcome> {
    if (!await this.persist({ ...this.ledger, drops, stale, train })) {
      return "done";
    }
    this.act(
      `train:${train.operationId}:built:attempt=${train.attempt}:tip=${train.tip}:sha=${train.sha}:members=${
        train.members.map((m) => m.recordId).join(",")
      }`,
    );
    for (const m of train.members) {
      this.act(
        `delivery:${m.recordId}:train_member:op=${train.operationId}:reviewed=${m.head}@${m.base}:commit=${m.commit}:patch=${m.patch}`,
      );
    }
    return await this.publish();
  }

  async publish(): Promise<Outcome> {
    const train = this.train;
    let dispatchAlreadyApplied = false;
    const ci = this.context.deps.ciMinutes;
    if (ci === undefined) {
      this.act(`train:${train.operationId}:ci_capability_missing`);
      return "done";
    }
    if (ci.active) {
      if (this.context.deadlineAt === undefined) return "done";
      // Publishing intents can outlive their job's private object directory.
      // Regenerate only from persisted reviewed identities before admission.
      let restored = null;
      try {
        restored = await this.composer.compose({
          tip: train.tip,
          members: train.members.map((member) => ({
            head: member.head,
            base: member.base,
          })),
        });
      } catch {
        restored = null;
      }
      if (this.late()) return "deferred";
      if (
        restored === null || restored.length !== train.members.length ||
        restored.some((step) => step.status !== "joined")
      ) {
        this.act(`train:${train.operationId}:restore_unavailable`);
        return "done";
      }
      const final = restored.at(-1);
      if (
        final?.status !== "joined" || final.commit !== train.sha ||
        restored.some((step, index) =>
          step.status !== "joined" ||
          step.commit !== train.members[index].commit ||
          step.patch !== train.members[index].patch
        )
      ) {
        this.act(`train:${train.operationId}:restore_identity_mismatch`);
        return "done";
      }
      const admission = await ci.reserve({
        repository: this.scope.repository,
        kind: "train_push",
        head: train.sha,
        base: train.tip,
        ref: train.ref,
        pr: null,
      }, this.context.deadlineAt);
      if (
        admission.kind !== "admitted" && admission.kind !== "inactive" &&
        admission.kind !== "reconciled"
      ) {
        this.act(`train:${train.operationId}:ci_minute_hold`);
        return "done";
      }
      // Reserve the explicit dispatch before advancing the persisted phase:
      // a budget hold must leave it on the ordinary publishing/retry path.
      if (this.composer.triggerCi !== undefined) {
        const dispatch = await ci.reserve({
          repository: this.scope.repository,
          kind: "train_dispatch",
          head: train.sha,
          base: train.tip,
          ref: train.ref,
          pr: null,
        }, this.context.deadlineAt);
        if (dispatch.kind === "reconciled") dispatchAlreadyApplied = true;
        else if (dispatch.kind !== "admitted" && dispatch.kind !== "inactive") {
          this.act(`train:${train.operationId}:ci_minute_hold`);
          return "done";
        }
      }
    }
    let outcome: "applied" | "rejected" | "ambiguous";
    try {
      outcome = await this.composer.publish({ ref: train.ref, sha: train.sha });
    } catch {
      outcome = "ambiguous";
    }
    // An ambiguous push stays `publishing`; the next pass pushes it again.
    if (outcome === "ambiguous") {
      this.act(`train:${train.operationId}:publish_ambiguous`);
      return "done";
    }
    if (outcome === "rejected") return await this.end("publish_rejected");
    if (
      !await this.persist({
        ...this.ledger,
        train: { ...train, phase: "published" },
      })
    ) return "done";
    this.act(`train:${train.operationId}:published:ref=${train.ref}`);
    if (this.composer.triggerCi !== undefined && !dispatchAlreadyApplied) {
      let requested = false;
      try {
        requested = await this.composer.triggerCi({
          ref: train.ref,
          sha: train.sha,
        });
      } catch {
        requested = false;
      }
      this.act(
        `train:${train.operationId}:ci_requested:${
          requested ? "accepted" : "refused"
        }`,
      );
    }
    return await this.awaitCi();
  }

  async awaitCi(): Promise<Outcome> {
    if (this.late()) return "deferred";
    const train = this.train;
    const tip = await this.context.readTip(this.scope);
    if (this.late()) return "deferred";
    if (tip === null) {
      this.act(`train:${train.operationId}:base_unreadable`);
      return "done";
    }
    if (tip !== train.tip) return await this.end("dissolved:base_moved");
    const verdict = await trainCiVerdict(this.surface, train.sha, train.tip);
    if (this.late()) return "deferred";
    if (verdict.kind === "green") {
      this.act(`train:${train.operationId}:ci_green`);
      if (
        !await this.persist({
          ...this.ledger,
          train: { ...train, phase: "merging" },
        })
      ) return "done";
      return await mergeTrain(this);
    }
    if (verdict.kind === "red") return await this.red(verdict);
    const now = this.context.deps.clock.now();
    if (!(now - train.createdAt <= DELIVERY_TRAIN_CI_WAIT_MS)) {
      // Never red: the members fall back to the per-record path, and train
      // again only on a moved tip or a new head.
      return await this.end(
        "dissolved:ci_unavailable",
        [
          ...this.ledger.drops,
          ...train.members.map((m) => ({
            recordId: m.recordId,
            head: m.head,
            tip: train.tip,
            runId: null,
            check: "ci_unavailable",
            at: now,
          })),
        ].slice(-DELIVERY_TRAIN_MAX_DROPS),
      );
    }
    this.act(
      `train:${train.operationId}:ci_${verdict.kind}${
        verdict.kind === "unavailable" && verdict.cause !== undefined
          ? `:${verdict.cause}`
          : ""
      }`,
    );
    return "done";
  }

  /** Drop the newest member and retry once; a second red dissolves. */
  async red(
    verdict: { runId: number | null; check: string | null },
  ): Promise<Outcome> {
    const train = this.train;
    const now = this.context.deps.clock.now();
    const reason = `run=${verdict.runId ?? "unknown"}:check=${
      verdict.check ?? "unknown"
    }`;
    this.act(`train:${train.operationId}:ci_red:${reason}`);
    const drop = (m: DeliveryTrainMemberV1): DeliveryTrainDropV1 => {
      this.act(`delivery:${m.recordId}:train_dropped:${reason}`);
      return {
        recordId: m.recordId,
        head: m.head,
        tip: train.tip,
        runId: verdict.runId,
        check: verdict.check,
        at: now,
      };
    };
    if (train.attempt === 1 && train.members.length > 1) {
      const drops = [...this.ledger.drops, drop(train.members.at(-1)!)]
        .slice(-DELIVERY_TRAIN_MAX_DROPS);
      // The red train's ref ends with it; the retry gets its own ref.
      const started = await this.start(
        newTrain(this.key, train.tip, 2, train.members.slice(0, -1), now),
        drops,
        staleWith(this.ledger.stale, train),
      );
      await this.sweep();
      return started;
    }
    // No second bisect in the same pass: each member waits for a moved tip
    // or a new head before it trains again.
    return await this.end(
      "dissolved:ci_red",
      [...this.ledger.drops, ...train.members.map(drop)]
        .slice(-DELIVERY_TRAIN_MAX_DROPS),
    );
  }

  async advance(group: readonly HostedAutonomyRecordV1[]): Promise<Outcome> {
    const train = this.ledger.train;
    if (train === null) return await this.build(group);
    if (train.phase === "publishing") return await this.publish();
    if (train.phase === "published") return await this.awaitCi();
    return await mergeTrain(this);
  }
}

/**
 * The train phase of the delivery pass (see the module): runs before the
 * per-record merges and names the records that path leaves alone.
 */
export async function runDeliveryTrains(
  input: DeliveryTrainPassInputV1,
): Promise<DeliveryTrainPassV1> {
  const { context } = input;
  const deps = context.deps.deliveryTrain;
  const held = new Set<string>();
  if (deps === undefined) return { stop: null, held };
  const groups = new Map<string, HostedAutonomyRecordV1[]>();
  for (const record of input.order) {
    if (
      !input.eligible(record) || isHostedSelf(record.repository) ||
      isGatewayVpsRepository(record.repository)
    ) continue;
    const key = hostedRepositoryKey(record.repository);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (hostedPassDeadlineReached(context)) {
      return { stop: input.defer(), held };
    }
    const scope = await context.scopeFor(group[0].repository);
    let composer: DeliveryTrainComposerV1 | null = null;
    try {
      composer = deps.composerFor(group[0].repository);
    } catch {
      composer = null;
    }
    if (scope.surface === null || scope.baseBranch === null || !composer) {
      continue;
    }
    let read = null;
    try {
      read = await deps.journal.read(group[0].repository);
    } catch {
      read = null;
    }
    if (read === null) {
      context.actions.push(`train:${scope.key}:journal_unavailable`);
      continue;
    }
    const run = new RepositoryTrain(input, deps, scope, composer, read, held);
    // Ended train refs an earlier pass could not delete (bounded).
    await run.sweep();
    // A landed member's merged pull is the closure's, never merged again.
    for (const record of group) {
      if (
        read.ledger.landings.some((landing) =>
          landing.recordId === record.id &&
          landing.pullRequest === record.target.pr &&
          landing.head === record.target.head &&
          landing.base === record.target.base
        )
      ) held.add(record.id);
    }
    const outcome = await run.advance(group);
    const open = run.ledger.train;
    if (open !== null) {
      for (const record of group) {
        if (held.has(record.id)) continue;
        held.add(record.id);
        context.actions.push(
          `delivery:${record.id}:train_in_flight:op=${open.operationId}`,
        );
      }
    }
    if (outcome === "deferred") return { stop: input.defer(), held };
  }
  return { stop: null, held };
}

/** The delivery pass's counters, from its own action lines. */
export function deliveryPassCounts(actions: readonly string[]): {
  trainsBuilt: number;
  targetCiRunsTriggered: number;
  mergesCompleted: number;
} {
  const trains =
    actions.filter((line) => /^train:[0-9a-f]{24}:published:/.test(line))
      .length;
  return {
    trainsBuilt: trains,
    targetCiRunsTriggered: trains,
    mergesCompleted: actions.filter((line) => line.startsWith("merge:"))
      .length,
  };
}

/**
 * Fill the cycle's throughput collector (#338) from the delivery pass's own
 * lines since `from`, and name them once in the summary when trains or
 * metrics are configured (finalize records them; absent: nothing changes).
 */
export function finishDeliveryPassCounts(
  context: HostedAutonomyPassContextV1,
  from: number,
): void {
  const { deps, actions } = context;
  if (deps.deliveryTrain === undefined && deps.metrics === undefined) return;
  const counts = deliveryPassCounts(actions.slice(from));
  try {
    deps.metrics?.addCount("trainsBuilt", counts.trainsBuilt);
    deps.metrics?.addCount(
      "targetCiRunsTriggered",
      counts.targetCiRunsTriggered,
    );
    deps.metrics?.addCount("mergesCompleted", counts.mergesCompleted);
  } catch { /* advisory: a collector fault never changes delivery */ }
  actions.push(
    `delivery-summary:trains_built=${counts.trainsBuilt}:target_ci_runs=${counts.targetCiRunsTriggered}:merges=${counts.mergesCompleted}`,
  );
}
