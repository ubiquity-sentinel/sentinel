/**
 * One repository's delivery train for one pass (sentinel #330): its ledger
 * head, the CAS ledger write that precedes every effect, the member lookup
 * and the deterministic operation identity. The phases are
 * `hosted-autonomy-delivery-train.ts` (build, publish, CI) and
 * `hosted-autonomy-train-merge.ts` (ordered merges and landings).
 */
import { createHash } from "node:crypto";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import {
  type HostedAutonomyPassContextV1,
  type HostedAutonomyScopeV1,
  hostedPassDeadlineReached,
} from "./hosted-autonomy-scopes.ts";
import {
  DELIVERY_TRAIN_REF_PREFIX,
  type DeliveryTrainComposerV1,
  type DeliveryTrainLedgerV1,
  type DeliveryTrainMemberV1,
  type DeliveryTrainV1,
  type HostedDeliveryTrainDepsV1,
  parseDeliveryTrainLedgerV1,
} from "./hosted-autonomy-train-types.ts";
import type {
  HostedAutonomyGitHubV1,
  HostedAutonomyRecordV1,
  HostedAutonomyResultV1,
} from "./hosted-autonomy-types.ts";

export interface DeliveryTrainPassInputV1 {
  context: HostedAutonomyPassContextV1;
  /** The delivery pass's line order (oldest `createdAt`, then id). */
  order: readonly HostedAutonomyRecordV1[];
  eligible(record: HostedAutonomyRecordV1): boolean;
  /** The pass's deadline deferral. */
  defer(): HostedAutonomyResultV1;
  /** Drop the pass's cached tip and tip CI of a repository at a merge. */
  dropTip(key: string): void;
}

export interface DeliveryTrainPassV1 {
  /** The deadline deferral when the window closed inside a train. */
  stop: HostedAutonomyResultV1 | null;
  /** Records the per-record merge path leaves alone this pass. */
  held: ReadonlySet<string>;
}

export type Outcome = "done" | "deferred";

/** Operation id: a pure function of the repository, tip, attempt, members. */
function operationId(
  key: string,
  tip: string,
  attempt: 1 | 2,
  members: readonly DeliveryTrainMemberV1[],
): string {
  return createHash("sha256").update(
    canonicalStringify({
      repository: key,
      tip,
      attempt,
      members: members.map((m) => [m.pullRequest, m.head]),
    }),
    "utf8",
  ).digest("hex").slice(0, 24);
}

export function newTrain(
  key: string,
  tip: string,
  attempt: 1 | 2,
  members: readonly DeliveryTrainMemberV1[],
  now: number,
): DeliveryTrainV1 {
  const op = operationId(key, tip, attempt, members);
  return {
    operationId: op,
    ref: `${DELIVERY_TRAIN_REF_PREFIX}${op}`,
    tip,
    attempt,
    sha: members.at(-1)!.commit,
    members,
    phase: "publishing",
    pendingMerge: null,
    createdAt: now,
  };
}

/** One repository's train for this pass: its ledger and every effect. */
export class TrainRun {
  readonly key: string;
  readonly surface: HostedAutonomyGitHubV1;
  head: string | null;
  ledger: DeliveryTrainLedgerV1;

  constructor(
    readonly input: DeliveryTrainPassInputV1,
    readonly deps: HostedDeliveryTrainDepsV1,
    readonly scope: HostedAutonomyScopeV1,
    readonly composer: DeliveryTrainComposerV1,
    read: { head: string | null; ledger: DeliveryTrainLedgerV1 },
    readonly held: Set<string>,
  ) {
    this.key = scope.key;
    this.surface = scope.surface!;
    this.head = read.head;
    this.ledger = read.ledger;
  }

  get context(): HostedAutonomyPassContextV1 {
    return this.input.context;
  }
  get train(): DeliveryTrainV1 {
    return this.ledger.train!;
  }
  late(): boolean {
    return hostedPassDeadlineReached(this.context);
  }
  act(line: string): void {
    this.context.actions.push(line);
  }

  /** The one ledger write (CAS on the observed head) before any effect. */
  async persist(next: DeliveryTrainLedgerV1): Promise<boolean> {
    if (parseDeliveryTrainLedgerV1(next) === null) {
      this.act(`train:${this.key}:ledger_invalid`);
      return false;
    }
    let written = null;
    try {
      written = await this.deps.journal.write({
        repository: this.scope.repository,
        expectedHead: this.head,
        ledger: next,
      });
    } catch {
      written = null;
    }
    if (written?.status === "applied") {
      this.head = written.head;
      this.ledger = next;
      return true;
    }
    this.act(`train:${this.key}:journal_${written?.status ?? "unavailable"}`);
    return false;
  }

  async end(reason: string): Promise<Outcome> {
    this.act(`train:${this.train.operationId}:${reason}`);
    await this.persist({ ...this.ledger, train: null });
    return "done";
  }

  /** The member's record exactly as the train admitted it. */
  record(member: DeliveryTrainMemberV1): HostedAutonomyRecordV1 | null {
    return this.context.snapshot.work.find((record) =>
      record.id === member.recordId && record.nextStep === "delivery" &&
      record.target.pr === member.pullRequest &&
      record.target.head === member.head && record.target.base === member.base
    ) ?? null;
  }

  async tree(sha: string): Promise<string | null> {
    try {
      return await this.surface.readCommitTree?.(sha) ?? null;
    } catch {
      return null;
    }
  }
}
