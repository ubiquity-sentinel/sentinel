/**
 * The launcher's follow-up pass: after the maintenance chain, file the
 * remaining P2/P3 findings of each trusted merge as one new issue in the
 * target repository (see `hosted-autonomy-follow-ups.ts`). It is state-free:
 * it reads the repair snapshot, writes no state, plans no matrix cell and
 * touches no release; its only external write is the bounded issue create
 * over the target repository's own sentinel App surface.
 *
 * Idempotency needs no state. Before any create the repository's created-since
 * listing is read, and an App-authored issue whose first line names the same
 * repository and PR (at any receipt or depth) means it is already filed. A
 * listing proves absence only strictly newer than its oldest item, including
 * the request/GitHub clock margin. An unproven create counts against the pass
 * bound and the next listing settles it (passes are serialised by the
 * supervisor's concurrency group).
 */
import { QUEUE_PROOF_ACTIVATED } from "../src/github/queue-runtime-policy.ts";
import { isGatewayVpsRepository } from "../src/repair/vps-delivery.ts";
import { releaseRequestMatchesDelivery } from "../src/repair/loop-records.ts";
import { resolveHostedDelivery } from "./hosted-autonomy-delivery-proof.ts";
import { readRepairSafely } from "./hosted-autonomy-state.ts";
import { createHostedAutonomyScopes } from "./hosted-autonomy-scopes.ts";
import { baseAndHeadAreMerged } from "./hosted-autonomy-delivery.ts";
import {
  HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
  HOSTED_AUTONOMY_TRUSTED_AUTHORS,
} from "./hosted-autonomy-policy.ts";
import {
  FOLLOW_UP_LISTING_PAGE_SIZE,
  FOLLOW_UP_LISTING_SKEW_MS,
  FOLLOW_UP_MAX_CANDIDATES_PER_PASS,
  FOLLOW_UP_MAX_CREATES_PER_PASS,
  FOLLOW_UP_MAX_DEPTH,
  FOLLOW_UP_MAX_LISTING_PAGES,
  FOLLOW_UP_MAX_MERGE_CHECKS_PER_PASS,
  FOLLOW_UP_PASS_BUDGET_MS,
  type FollowUpCandidateV1,
  markerNamesCandidate,
  parseFollowUpMarker,
  planFollowUpCandidates,
  renderFollowUpIssue,
} from "./hosted-autonomy-follow-ups.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyPullV1,
  HostedIssueListingItemV1,
} from "./hosted-autonomy-types.ts";

/**
 * The exact trusted merge a follow-up requires: merged by the sentinel App
 * under the request's own merge commit, the request's head, a trusted author,
 * the repository's base branch, both reviewed parents bound and the revision
 * integrated. A hand merge (for example by the owner) never gets a follow-up.
 */
export function followUpMergeVerified(
  pull: HostedAutonomyPullV1 | null,
  candidate: FollowUpCandidateV1,
  baseBranch: string | null,
): boolean {
  const { request } = candidate;
  if (isGatewayVpsRepository(candidate.repository) && QUEUE_PROOF_ACTIVATED) {
    return false;
  }
  return pull !== null && baseBranch !== null && pull.merged === true &&
    pull.mergeCommitSha === request.revision &&
    pull.headSha === request.source.head &&
    typeof pull.author === "string" &&
    HOSTED_AUTONOMY_TRUSTED_AUTHORS.includes(pull.author) &&
    pull.mergedBy === HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR &&
    pull.baseRef === baseBranch && pull.revisionOnBaseBranch &&
    baseAndHeadAreMerged(pull, request.source.base, request.source.head);
}

/**
 * Run the bounded follow-up pass; its actions only, never a state change.
 * `passDeadline` is the maintenance pass's own deadline (its start plus
 * `HOSTED_AUTONOMY_PASS_DEADLINE_MS`): the follow-ups run after every
 * continued phase of that pass and never start a read or a create past it,
 * so a pass that is already late leaves them to the next one.
 */
export async function runHostedFollowUpPass(
  deps: HostedAutonomyDepsV1,
  passDeadline: number = Number.POSITIVE_INFINITY,
): Promise<string[]> {
  const actions: string[] = [];
  if (deps.queueCustody?.ready === false) return actions;
  const started = deps.clock.now();
  if (!Number.isSafeInteger(started)) return actions;
  // A deadline that is not a number counts as already passed.
  const deadline = Math.min(started + FOLLOW_UP_PASS_BUDGET_MS, passDeadline);
  if (!(started < deadline)) {
    actions.push("followup:deadline");
    return actions;
  }
  const read = await readRepairSafely(deps.state);
  if (read === null || !read.ok || read.value.status !== "found") {
    return actions;
  }
  const observed = read.value;
  const candidates = planFollowUpCandidates(observed.snapshot, started);
  if (candidates.length === 0) return actions;
  const inBudget = () => {
    const now = deps.clock.now();
    return Number.isSafeInteger(now) && now < deadline;
  };
  const { scopeFor, readPull } = createHostedAutonomyScopes(deps);
  const listings = new Map<
    string,
    readonly HostedIssueListingItemV1[] | null
  >();
  let looked = 0;
  let checks = 0;
  let creates = 0;
  for (const candidate of candidates) {
    const tag = `followup:${candidate.request.id}:pr=${candidate.pullRequest}`;
    const scope = await scopeFor(candidate.repository);
    const port = scope.surface?.followUpIssues;
    // A surface without the capability files nothing and reports nothing.
    if (scope.surface === null || port === undefined) continue;
    // 1. Already filed? One listing per repository and pass. A five-page
    //    prefix proves only down to its oldest item; candidates whose clock
    //    margin crosses that horizon remain unproven instead of blocking newer ones.
    let listing = listings.get(scope.key);
    if (listing === undefined) {
      if (!inBudget()) {
        actions.push(`${tag}:deadline`);
        break;
      }
      const sinceMs = Math.min(
        ...candidates.filter((other) =>
          other.repository.owner === candidate.repository.owner &&
          other.repository.name === candidate.repository.name &&
          other.repository.installationId ===
            candidate.repository.installationId
        ).map((other) => other.request.createdAt),
      ) - FOLLOW_UP_LISTING_SKEW_MS;
      try {
        listing = await port.listCreatedSince({
          sinceMs,
          maxPages: FOLLOW_UP_MAX_LISTING_PAGES,
        });
      } catch {
        listing = null;
      }
      listings.set(scope.key, listing ?? null);
    }
    if (listing === null || listing === undefined) {
      actions.push(`${tag}:listing_unproven`);
      continue;
    }
    const existing = listing.find((item) =>
      !item.pullRequest && item.author === HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR &&
      markerNamesCandidate(item.firstLine, candidate)
    );
    if (existing !== undefined) {
      actions.push(`${tag}:exists=#${existing.number}`);
      continue;
    }
    const oldestListed = listing.length >=
        FOLLOW_UP_MAX_LISTING_PAGES * FOLLOW_UP_LISTING_PAGE_SIZE
      ? listing.at(-1)?.createdAt ?? null
      : null;
    // A missing marker is not absence proof at a capped page boundary: an
    // omitted item may share its timestamp or lie within the clock margin.
    if (
      oldestListed !== null &&
      candidate.request.createdAt - FOLLOW_UP_LISTING_SKEW_MS <= oldestListed
    ) {
      actions.push(`${tag}:listing_unproven`);
      continue;
    }
    if (
      looked >= FOLLOW_UP_MAX_CANDIDATES_PER_PASS ||
      checks >= FOLLOW_UP_MAX_MERGE_CHECKS_PER_PASS ||
      creates >= FOLLOW_UP_MAX_CREATES_PER_PASS
    ) {
      actions.push(`${tag}:deferred`);
      continue;
    }
    looked++;
    // 2. The live merge must be the trusted one the request records.
    if (!inBudget()) {
      actions.push(`${tag}:deadline`);
      break;
    }
    checks++;
    const pull = await readPull(scope, candidate.pullRequest);
    const gateway = isGatewayVpsRepository(candidate.repository);
    const record = read.value.snapshot.work.find((row) =>
      releaseRequestMatchesDelivery(candidate.request, row)
    );
    const gatewayProof = async () => {
      if (record === undefined) return null;
      const currentPull = await readPull(scope, candidate.pullRequest);
      const proof = await resolveHostedDelivery(
        { deps, snapshot: observed.snapshot, observedHead: observed.head },
        record,
        scope,
        currentPull,
        "follow_up",
        candidate.request.revision,
      );
      if (
        proof?.kind === "legacy" &&
        !followUpMergeVerified(currentPull, candidate, scope.baseBranch)
      ) return null;
      return proof !== null && proof.reviewReceiptId === candidate.receipt.id &&
          proof.reviewRequestId === candidate.request.source.reviewRequestId &&
          proof.taskDigest === candidate.receipt.taskAcceptance?.taskDigest
        ? proof
        : null;
    };
    if (
      gateway
        ? await gatewayProof() === null
        : !followUpMergeVerified(pull, candidate, scope.baseBranch)
    ) {
      actions.push(`${tag}:merge_unverified`);
      continue;
    }
    // 3. Depth: depth 3 is filed with the Sentinel opt-out label.
    let depth = 1;
    if (candidate.sourceIssue !== null) {
      if (!inBudget()) {
        actions.push(`${tag}:deadline`);
        break;
      }
      let origin = null;
      try {
        origin = await port.readIssueOrigin(candidate.sourceIssue);
      } catch {
        origin = null;
      }
      if (origin === null) {
        actions.push(`${tag}:source_unreadable`);
        continue;
      }
      const marker = parseFollowUpMarker(origin.firstLine);
      if (
        origin.author === HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR && marker !== null
      ) depth = marker.depth + 1;
    }
    if (depth > FOLLOW_UP_MAX_DEPTH) {
      actions.push(`${tag}:depth_exhausted`);
      continue;
    }
    // 4. Render, create and verify the echo.
    const issue = renderFollowUpIssue({
      candidate,
      mergeRevision: candidate.request.revision,
      depth,
    });
    if (issue === null) {
      actions.push(`${tag}:render_refused`);
      continue;
    }
    if (!inBudget()) {
      actions.push(`${tag}:deadline`);
      break;
    }
    // Depth/source reads cannot turn an old proof into authority for a changed task.
    if (gateway && await gatewayProof() === null) {
      actions.push(`${tag}:merge_unverified`);
      continue;
    }
    creates++;
    let number: number | null = null;
    try {
      number = await port.create({
        title: issue.title,
        body: issue.body,
        ...(depth === 3 ? { labels: ["sentinel:skip"] } : {}),
      });
    } catch {
      number = null;
    }
    actions.push(
      number === null ? `${tag}:create_unproven` : `${tag}:filed=#${number}`,
    );
  }
  return actions;
}
