/**
 * The launcher's per-pass source-issue facts (`context.closedIssues`): the
 * `hostedIssueKey` of every source issue a read of this pass found closed.
 * Bookkeeping, the retry grants and the delivery pass consult them; a failed
 * or unreadable read is no evidence and adds nothing.
 *
 * A retired record (`isHostedRetired`, the terminal park of a record whose
 * source issue closed) costs no read: every rule that consults these facts
 * selects records by a shape the retirement park never has (a retryable or
 * re-admissible blocker, a CI park, an owner gate, a delivery step), and the
 * retirement plan skips a retired record whatever its issue reads, so its
 * key changes no verdict. Its key is still read while another record that is
 * not retired shares it (a decomposition part), exactly as before.
 *
 * The remaining reads are independent GETs and run at most
 * `CLOSED_ISSUE_READ_CONCURRENCY` at a time (live 2026-10-24: 388 sequential
 * reads, in a context phase of 85 seconds), started and applied in record
 * order, so for the same answers the facts, the `seen` ids and the actions
 * are exactly those of the sequential reads.
 */
import { queueRecordProtected } from "./hosted-autonomy-queue-context.ts";
import type { HostedAutonomyPassContextV1 } from "./hosted-autonomy-scopes.ts";
import { hostedIssueKey } from "./hosted-autonomy-policy.ts";
import { isHostedRetired } from "./hosted-autonomy-closures.ts";
import type { HostedAutonomyRecordV1 } from "./hosted-autonomy-types.ts";

/** Source-issue reads in flight at once (far below GitHub's limits). */
export const CLOSED_ISSUE_READ_CONCURRENCY = 4;

type IssueRead =
  | { kind: "unreadable" }
  | { kind: "read"; open: boolean | null }
  | { kind: "threw"; error: unknown };

/** `read` over `items`, at most `limit` at a time, results in item order. */
async function readInOrder<T, R>(
  items: readonly T[],
  limit: number,
  read: (item: T) => Promise<R>,
): Promise<({ ok: true; value: R } | { ok: false; error: unknown })[]> {
  const results: ({ ok: true; value: R } | { ok: false; error: unknown })[] =
    new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { ok: true, value: await read(items[index]!) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/**
 * Read-only source facts shared by bookkeeping and the later retry grant. A
 * pass that continues after a write passes the ids it already read (`seen`):
 * each record's issue is read once per pass, and the facts already held are
 * kept.
 */
export async function readHostedClosedIssues(
  context: HostedAutonomyPassContextV1,
  seen?: Set<string>,
): Promise<void> {
  const { snapshot, scopeFor, actions } = context;
  const closedIssues = new Set<string>(
    seen === undefined ? [] : context.closedIssues,
  );
  // Keys some record other than a retired one still carries.
  const live = new Set<string>();
  for (const record of snapshot.work) {
    const issueNumber = record.related.issueNumber;
    if (
      record.nextStep !== "done" && issueNumber !== null &&
      !isHostedRetired(record)
    ) live.add(hostedIssueKey(record.repository, issueNumber));
  }
  const pending: { record: HostedAutonomyRecordV1; issueNumber: number }[] = [];
  for (const record of snapshot.work) {
    if (record.nextStep === "done") continue;
    if (queueRecordProtected(record, context.deps.queueCustody)) continue;
    const issueNumber = record.related.issueNumber;
    if (issueNumber === null || seen?.has(record.id)) continue;
    if (
      isHostedRetired(record) &&
      !live.has(hostedIssueKey(record.repository, issueNumber))
    ) continue;
    pending.push({ record, issueNumber });
  }
  const reads = await readInOrder(
    pending,
    CLOSED_ISSUE_READ_CONCURRENCY,
    async ({ record, issueNumber }): Promise<IssueRead> => {
      try {
        const scope = await scopeFor(record.repository);
        if (scope.surface === null) return { kind: "unreadable" };
        let open: boolean | null = null;
        try {
          open = await scope.surface.readIssueOpen(issueNumber);
        } catch {
          open = null;
        }
        return { kind: "read", open };
      } catch (error) {
        return { kind: "threw", error };
      }
    },
  );
  for (const [index, { record, issueNumber }] of pending.entries()) {
    seen?.add(record.id);
    const outcome = reads[index]!;
    const read: IssueRead = outcome.ok
      ? outcome.value
      : { kind: "threw", error: outcome.error };
    // A scope that could not be built fails the pass as the sequential
    // reads did, after the facts of the records before it.
    if (read.kind === "threw") throw read.error;
    if (read.kind === "unreadable") {
      actions.push(`record:${record.id}:surface_unreadable`);
    } else if (read.open === false) {
      closedIssues.add(hostedIssueKey(record.repository, issueNumber));
    }
  }
  context.closedIssues = closedIssues;
}
