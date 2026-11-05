/**
 * Post-merge delivery gate (sentinel #337): merge is not delivery.
 *
 * After a foreign pull request merged and every existing closure proof holds,
 * the target's trusted `requiredForDelivery` checks must complete green on
 * the exact merge commit before the source issue is closed and the record is
 * marked done. A still-running or not-yet-reported check keeps the record in
 * `delivery` with a bounded `deployment` wait; a failed check (or one that
 * never completed within the bound) parks the record with the check name and
 * id as the precise blocker and posts one progress comment on the issue. The
 * review and merge gates are unchanged; an empty policy changes nothing.
 */
import { isGitSha } from "../src/contracts/brands.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import type {
  PortResultV1,
  StateWriteResultV1,
} from "../src/contracts/ports.ts";
import { parseRepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type { GitSha } from "../src/contracts/brands.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import { targetDeliveryCheckPolicyV1 } from "../src/host/target-delivery-checks.ts";
import {
  progressMarker,
  progressStage,
} from "../src/host/progress-comments.ts";
import { isGreenConclusion } from "../src/repair/ci-rejection.ts";
import { markBlocked, setWait } from "../src/repair/transitions.ts";
import { isHostedSelf } from "./hosted-autonomy-policy.ts";
import { queueRecordProtected } from "./hosted-autonomy-queue-context.ts";
import type { HostedAutonomyPassContextV1 } from "./hosted-autonomy-scopes.ts";
import { failed, readRepairSafely, skipped } from "./hosted-autonomy-state.ts";
import type {
  HostedAutonomyGitHubV1,
  HostedAutonomyRecordV1,
  HostedAutonomyResultV1,
  HostedDeliveryCheckV1,
} from "./hosted-autonomy-types.ts";

/** How long after the merge a required delivery check may stay incomplete. */
export const DELIVERY_CHECK_WAIT_MS = 2 * 60 * 60 * 1000;
/** Blocker prefix of a delivery check that completed non-green. */
export const DELIVERY_CHECK_FAILED_PREFIX = "delivery check failed";
/** Blocker prefix of a delivery check still incomplete at its deadline. */
export const DELIVERY_CHECK_TIMEOUT_PREFIX = "delivery check did not complete";

/** One required check as the delivery receipt records it. */
export interface DeliveryCheckReceiptV1 {
  readonly name: string;
  readonly conclusion: string;
  readonly id: number;
}

export type DeliveryCheckDecisionV1 =
  | { readonly kind: "proceed"; readonly receipt: DeliveryCheckReceiptV1[] }
  | {
    readonly kind: "wait";
    readonly pending: string[];
    readonly since: number;
    readonly until: number;
  }
  | {
    readonly kind: "blocked";
    readonly message: string;
    readonly name: string;
    readonly conclusion: string | null;
    readonly id: number | null;
  };

function latestByName(
  observed: readonly HostedDeliveryCheckV1[],
): Map<string, HostedDeliveryCheckV1> {
  const latest = new Map<string, HostedDeliveryCheckV1>();
  for (const check of observed) {
    const key = check.name.trim().toLowerCase();
    const prior = latest.get(key);
    const at = check.startedAt ?? -Infinity;
    const priorAt = prior?.startedAt ?? -Infinity;
    // A rerun (later start) overrides an older result of the same name.
    if (
      prior === undefined || at > priorAt ||
      (at === priorAt && check.id > prior.id)
    ) latest.set(key, check);
  }
  return latest;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Pure delivery decision for one merge commit. Every required name is judged
 * by its latest observation: completed green (success, skipped, neutral)
 * passes; completed with any other conclusion fails; anything else, or no
 * observation at all, is pending until `since + DELIVERY_CHECK_WAIT_MS`.
 * `since` is the earliest of the record's existing `deployment` wait and the
 * first observation on the commit, so a rewritten wait cannot extend it.
 * Failures are judged before pending, so a queued check never masks one.
 */
export function decideDeliveryChecks(
  required: readonly string[],
  observed: readonly HostedDeliveryCheckV1[],
  commit: string,
  waitSince: number | null,
  now: number,
): DeliveryCheckDecisionV1 {
  const latest = latestByName(observed);
  const receipt: DeliveryCheckReceiptV1[] = [];
  const pending: string[] = [];
  for (const name of required) {
    const check = latest.get(name.trim().toLowerCase());
    if (check === undefined || check.status !== "completed") {
      pending.push(name);
      continue;
    }
    if (!isGreenConclusion(check.conclusion)) {
      const conclusion = check.conclusion ?? "unknown";
      return {
        kind: "blocked",
        message: `${DELIVERY_CHECK_FAILED_PREFIX}: ${
          oneLine(name)
        } (${conclusion}) id ${check.id} on merge ${commit.slice(0, 12)}`,
        name,
        conclusion,
        id: check.id,
      };
    }
    receipt.push({ name, conclusion: check.conclusion!, id: check.id });
  }
  if (pending.length === 0) return { kind: "proceed", receipt };
  const started = observed
    .map((check) => check.startedAt)
    .filter((at): at is number => at !== null && Number.isSafeInteger(at));
  const since = Math.min(now, waitSince ?? now, ...started);
  const until = since + DELIVERY_CHECK_WAIT_MS;
  if (now >= until) {
    const name = pending[0];
    const check = latest.get(name.trim().toLowerCase());
    return {
      kind: "blocked",
      message: `${DELIVERY_CHECK_TIMEOUT_PREFIX}: ${oneLine(name)} (${
        check === undefined ? "not reported" : check.status
      })${check === undefined ? "" : ` id ${check.id}`} on merge ${
        commit.slice(0, 12)
      }`,
      name,
      conclusion: null,
      id: check?.id ?? null,
    };
  }
  return { kind: "wait", pending, since, until };
}

/** The receipt as one action segment: `name=conclusion@id`, comma-joined. */
export function deliveryReceiptText(
  receipt: readonly DeliveryCheckReceiptV1[],
): string {
  return receipt.map((item) =>
    `${encodeURIComponent(item.name)}=${item.conclusion}@${item.id}`
  ).join(",");
}

interface PendingComment {
  readonly surface: HostedAutonomyGitHubV1;
  readonly issueNumber: number;
  readonly body: string;
}

/** What the gate decided for this pass's closure candidates. */
export interface DeliveryCheckGateV1 {
  /** Plan ids whose delivery checks passed (or whose policy is empty). */
  readonly proceed: Set<string>;
  /** Records to write: a new `deployment` wait or a delivery park. */
  readonly updates: Map<string, HostedAutonomyRecordV1>;
  readonly comments: PendingComment[];
}

function requiredFor(
  context: HostedAutonomyPassContextV1,
  repository: RepositoryIdentityV1,
): readonly string[] {
  return context.deps.requiredForDelivery?.(repository) ??
    targetDeliveryCheckPolicyV1(repository).requiredForDelivery;
}

/**
 * Gate every closure candidate on its delivery checks. A self record (its
 * accepted release is its delivery) and a target with an empty policy always
 * proceed exactly as before. An unreadable pull, merge commit or check
 * listing is no evidence: the record neither closes nor changes.
 */
export async function gateDeliveryChecks(
  context: HostedAutonomyPassContextV1,
  plans: readonly { id: string; issueNumber: number }[],
  records: readonly HostedAutonomyRecordV1[],
): Promise<DeliveryCheckGateV1> {
  const gate: DeliveryCheckGateV1 = {
    proceed: new Set(),
    updates: new Map(),
    comments: [],
  };
  const { actions, deps } = context;
  for (const plan of plans) {
    const record = records.find((item) => item.id === plan.id);
    if (record === undefined) continue;
    const required = isHostedSelf(record.repository)
      ? []
      : requiredFor(context, record.repository);
    if (required.length === 0) {
      gate.proceed.add(plan.id);
      continue;
    }
    const scope = await context.scopeFor(record.repository);
    const surface = scope.surface;
    const pull = record.target.pr === null
      ? null
      : await context.readPull(scope, record.target.pr);
    const commit = pull?.merged === true ? pull.mergeCommitSha : null;
    let observed: readonly HostedDeliveryCheckV1[] | null = null;
    if (
      surface !== null && commit !== null && isGitSha(commit) &&
      surface.readDeliveryChecks !== undefined
    ) {
      try {
        observed = await surface.readDeliveryChecks(commit);
      } catch {
        observed = null;
      }
    }
    if (observed === null || commit === null) {
      actions.push(`delivery-checks:${record.id}:unavailable`);
      continue;
    }
    const now = deps.clock.now();
    const decision = decideDeliveryChecks(
      required,
      observed,
      commit,
      record.wait?.reason === "deployment" ? record.wait.since : null,
      now,
    );
    if (decision.kind === "proceed") {
      actions.push(
        `delivery-checks:${record.id}:passed:${
          deliveryReceiptText(decision.receipt)
        }`,
      );
      gate.proceed.add(plan.id);
      continue;
    }
    // A record held by queue custody is never rewritten here; it stays open.
    if (queueRecordProtected(record, deps.queueCustody)) {
      actions.push(`delivery-checks:${record.id}:protected`);
      continue;
    }
    if (decision.kind === "wait") {
      actions.push(
        `delivery-checks:${record.id}:pending:${
          decision.pending.map(encodeURIComponent).join(",")
        }`,
      );
      // A parked record whose failed check is being rerun stays parked until
      // the rerun completes; only a live delivery record takes the wait.
      if (
        record.nextStep === "delivery" && (
          record.wait?.reason !== "deployment" ||
          record.wait.since !== decision.since ||
          record.wait.until !== decision.until
        )
      ) {
        gate.updates.set(
          record.id,
          setWait(record, {
            reason: "deployment",
            since: decision.since,
            until: decision.until,
          }, now),
        );
      }
      continue;
    }
    actions.push(
      `delivery-checks:${record.id}:failed:${
        encodeURIComponent(decision.name)
      }:${decision.conclusion ?? "incomplete"}:id=${decision.id ?? "none"}`,
    );
    // The same park already recorded: no rewrite and no repeated comment. A
    // rerun that turns green later proceeds to closure from this park.
    if (
      record.nextStep === "blocked" &&
      record.blocker?.message === decision.message
    ) continue;
    const parked = markBlocked(record, "other", decision.message, now);
    gate.updates.set(record.id, parked);
    const stage = progressStage(parked);
    if (surface !== null && stage !== null) {
      gate.comments.push({
        surface,
        issueNumber: plan.issueNumber,
        body: `${
          progressMarker(record.id, stage.key)
        }\nSentinel merged pull request #${record.target.pr}, but the ${
          oneLine(decision.name)
        } delivery check on the merge commit ${
          decision.conclusion === null
            ? "did not complete"
            : `ended ${decision.conclusion}`
        }${
          decision.id === null ? "" : ` (id ${decision.id})`
        }. The issue stays open and this repair is parked until the delivery is fixed.`,
      });
    }
  }
  return gate;
}

/**
 * Post the gate's progress comments once, after the state write that parked
 * their records succeeded. The park itself is the dedup: a record already
 * parked with the same delivery blocker is neither rewritten nor commented
 * again, and the marker matches the runtime progress commenter's stage key.
 */
export async function postDeliveryCheckComments(
  context: HostedAutonomyPassContextV1,
  comments: readonly PendingComment[],
): Promise<void> {
  for (const comment of comments) {
    let posted = false;
    try {
      posted = await comment.surface.commentIssue?.(
        comment.issueNumber,
        comment.body,
      ) === true;
    } catch {
      posted = false;
    }
    context.actions.push(
      `delivery-checks:comment:issue=${comment.issueNumber}:${
        posted ? "posted" : "unavailable"
      }`,
    );
  }
}

/** Write only the gate's record updates (no closure applied this pass). */
export async function persistDeliveryCheckUpdates(
  context: HostedAutonomyPassContextV1,
  gate: DeliveryCheckGateV1,
): Promise<HostedAutonomyResultV1> {
  const { deps, snapshot, observedHead, actions, revisions } = context;
  const now = deps.clock.now();
  if (!Number.isSafeInteger(now) || now < snapshot.updatedAt) {
    return skipped("clock_invalid", observedHead, actions);
  }
  let next;
  try {
    next = parseRepairStateSnapshotV1({
      ...snapshot,
      stateHead: observedHead,
      sequence: snapshot.sequence + 1,
      updatedAt: now,
      work: snapshot.work.map((item) => gate.updates.get(item.id) ?? item),
    });
  } catch {
    return skipped("snapshot_invalid", observedHead, actions);
  }
  let write: PortResultV1<StateWriteResultV1> | null;
  try {
    write = await deps.state.writeRepair(next, observedHead as GitSha);
  } catch {
    return failed("write_unavailable", observedHead, actions);
  }
  if (write === null || !write.ok) {
    return failed("write_unavailable", observedHead, actions);
  }
  if (write.value.status === "conflict") {
    return skipped("write_conflict", observedHead, actions);
  }
  if (write.value.status === "ambiguous") {
    return failed("write_ambiguous", observedHead, actions);
  }
  const readback = await readRepairSafely(deps.state);
  if (
    readback === null || !readback.ok || readback.value.status !== "found" ||
    readback.value.head !== write.value.head ||
    canonicalStringify(readback.value.snapshot) !== canonicalStringify(next)
  ) return failed("readback_unverified", observedHead, actions);
  await postDeliveryCheckComments(context, gate.comments);
  return {
    kind: "hosted_autonomy",
    status: "applied",
    reason: "applied",
    beforeHead: observedHead,
    appliedHead: write.value.head,
    actions,
    revisions,
  };
}
