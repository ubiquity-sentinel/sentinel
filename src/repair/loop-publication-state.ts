/** Repair loop internals: publication state. */
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { candidateBranch, pullRequestIntentKey } from "./keys.ts";
import { CHECK_POLL_MS, checkGithubCooldown } from "./loop-bounds.ts";
import { requestReviewFor } from "./loop-review-request.ts";
import { persistWork } from "./loop-state.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import { markTerminalBlocked, setIntent, setWait } from "./transitions.ts";

/** Continue an exactly proved publication: request review or create the PR. */
export function continuePublication(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  config: RepositoryConfigV1,
): Promise<StepResultV1> {
  if (record.target.pr !== null) {
    return requestReviewFor(deps, context, record, record.target.pr);
  }
  return createPullRequestFor(deps, context, record, config);
}

export async function createPullRequestFor(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  config: RepositoryConfigV1,
): Promise<StepResultV1> {
  const now = deps.clock.now();
  const head = record.target.head!;
  const branch = candidateBranch(record.id);
  // PR creation is a GitHub write: gate before the PR intent is written (a
  // cooling installation never writes a pull_request intent it cannot act on).
  const cooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (cooling.kind === "state_error") {
    return { kind: "state_error", detail: cooling.detail };
  }
  if (cooling.kind === "deferred") {
    return { kind: "deferred", detail: cooling.detail };
  }
  // The organization's anti-spam policy expects the pull request author to be
  // assigned to the source issue first: the trusted publication identity is
  // assigned BEFORE the pull_request intent is written and before any create
  // or replacement publication. The call is idempotent and best-effort — the
  // observed policy exempts an organization-owned author, and GitHub refuses
  // to assign a GitHub App at all — so a refusal never blocks publication and
  // never fabricates an assignment.
  const issueNumber = record.related.issueNumber;
  if (issueNumber !== null) {
    await deps.github.assignIssue(issueNumber);
  }
  const intent = {
    kind: "pull_request" as const,
    key: pullRequestIntentKey(head),
    startedAt: now,
    branch,
    expectedHead: head,
    observedBase: record.target.base,
    pr: null,
    requestId: null,
    resultId: null,
  };
  const withIntent = setIntent(record, intent, now);
  const persisted = await persistWork(deps, context, withIntent);
  if (persisted.kind !== "progress") return persisted;

  // The PR intent write is awaited wall-clock time: before the PR creation
  // mutation the total deadline is rechecked. The durable pull_request intent
  // makes the next run reconcile the exact head ref and create the PR once.
  if (deps.clock.now() >= context.bounds.runDeadline) {
    return {
      kind: "margin",
      detail: "PR creation crossed the total run deadline",
    };
  }

  const title = record.source.kind === "incident"
    ? `Sentinel repair: ${record.source.id}`
    : `Sentinel repair: issue ${record.related.issueNumber}`;
  // Owner directive, 2026-09-23 (docs/DECISIONS.md): an issue-backed repair
  // publishes exactly the GitHub closing keyword as its whole body, so the
  // pull request is linked to the source issue and the merge closes it. A
  // record with no issue reference keeps a non-closing descriptive body.
  const body = record.related.issueNumber === null
    ? `Sentinel repair for ${record.source.kind} ${record.source.id}`
    : `Resolves #${record.related.issueNumber}`;
  const created = await deps.github.createPullRequest({
    title: title.slice(0, 200),
    headRef: branch,
    baseRef: config.baseBranch,
    body,
    expectedBase: record.target.base,
    expectedHeadRef: head,
  });
  if (!created.ok) {
    // The saved pull_request intent must stay durable: the response may have
    // been lost after the write, and the next run reconciles the exact head
    // ref before repeating rather than blindly retrying an ambiguous write.
    return persistWork(
      deps,
      context,
      setWait(
        withIntent,
        { reason: "unavailable", since: now, until: now + CHECK_POLL_MS },
        now,
      ),
    );
  }
  if (created.value.outcome === "ambiguous") {
    return { kind: "progress" }; // reconciled next run by deterministic head ref
  }
  if (created.value.number === null || created.value.head !== head) {
    return persistWork(
      deps,
      context,
      markTerminalBlocked(
        record,
        "other",
        "PR publication identity mismatch",
        now,
      ),
    );
  }
  const withPr: WorkRecordV1 = {
    ...record,
    target: { ...record.target, pr: created.value.number },
    updatedAt: now,
  };
  const acknowledged = await persistWork(deps, context, withPr);
  if (acknowledged.kind !== "progress") return acknowledged;
  return requestReviewFor(deps, context, withPr, created.value.number);
}
