/**
 * Review follow-up issues (owner decision 2026-10-16: "kick the can down the
 * road and merge with some tech debt to keep moving forward"). After a trusted
 * merge, the P1/P2/P3 findings the latest current-head review left unresolved
 * are filed as ONE new issue per merged PR in the target repository, listing
 * each finding with its file:line. Pure planning and rendering only; the
 * launcher pass (`hosted-autonomy-follow-up-pass.ts`) owns every read and the
 * one write, and nothing here touches state.
 *
 * One aggregated issue per PR keeps a review's findings together, costs one
 * Sentinel admission rather than one per finding, and gives a deterministic
 * idempotency key: the body's first line is a marker naming the repository
 * and PR. Receipt and depth remain audit data, but a newer receipt can never
 * create a second follow-up for that PR.
 */
import { BLOCKING_SEVERITIES } from "../src/contracts/review-receipt.ts";
import type { ReleaseRequestV1 } from "../src/contracts/release.ts";
import type {
  ReviewFindingV1,
  ReviewReceiptV1,
} from "../src/contracts/review-receipt.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import {
  HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
  hostedRepositoryKey,
  sameRepository,
} from "./hosted-autonomy-policy.ts";
import {
  carriedRequestReceipt,
  identityBoundReviews,
  reviewBlocksMerge,
} from "./hosted-autonomy-spent-delivery.ts";
import { latestPullReview } from "../src/repair/carried-review.ts";
import { MERGED_OFF_TIP_PREFIX } from "../src/repair/merge-off-tip.ts";
import {
  REVIEW_ROUND_CEILING_CARRIED_OFF_TIP_PREFIX,
} from "../src/repair/review-round-cap.ts";

/** Requests created before 2026-10-16T00:00Z (the owner decision) never count. */
export const FOLLOW_UP_EPOCH = 1792108800000;
/** Historical bound retained for compatibility with older callers. */
export const FOLLOW_UP_WINDOW_MS = 72 * 60 * 60 * 1000;
/** Issues created per pass; an unproven create counts. */
export const FOLLOW_UP_MAX_CREATES_PER_PASS = 2;
/** Live merge verifications per pass. */
export const FOLLOW_UP_MAX_MERGE_CHECKS_PER_PASS = 4;
/** Candidates not already filed that one pass may look at. */
export const FOLLOW_UP_MAX_CANDIDATES_PER_PASS = 8;
/** Listing pages (100 items each) per repository and pass. */
export const FOLLOW_UP_MAX_LISTING_PAGES = 5;
/** GitHub's issue-list page size used by the follow-up surface. */
export const FOLLOW_UP_LISTING_PAGE_SIZE = 100;
/** Margin between the launcher's request clock and GitHub's `created_at`. */
export const FOLLOW_UP_LISTING_SKEW_MS = 10 * 60 * 1000;
/** Wall-clock budget of one pass, checked before every GitHub call. */
export const FOLLOW_UP_PASS_BUDGET_MS = 60_000;
export const FOLLOW_UP_MAX_FINDINGS = 20;
export const FOLLOW_UP_MAX_FINDING_CHARS = 1500;
/** Well inside the runtime's 16,384-character task-statement bound. */
export const FOLLOW_UP_MAX_BODY_CHARS = 12_000;
export const FOLLOW_UP_MAX_TITLE_CHARS = 120;
/** Depth 3 is filed, but opted out so it cannot re-enter Sentinel. */
export const FOLLOW_UP_MAX_DEPTH = 3;

const MARKER_RE =
  /^<!-- sentinel:review-followup:v1 repo=([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}) pr=([1-9][0-9]{0,9}) receipt=([A-Za-z0-9:_.-]{1,200}) depth=([1-9][0-9]?) -->$/;

export interface FollowUpMarkerV1 {
  owner: string;
  name: string;
  pullRequest: number;
  receiptId: string;
  depth: number;
}

/** The exact first-line marker, or null when an identity cannot be encoded. */
export function followUpMarker(input: FollowUpMarkerV1): string | null {
  const marker =
    `<!-- sentinel:review-followup:v1 repo=${input.owner}/${input.name} pr=${input.pullRequest} receipt=${input.receiptId} depth=${input.depth} -->`;
  const parsed = parseFollowUpMarker(marker);
  return parsed !== null && parsed.owner === input.owner &&
      parsed.name === input.name &&
      parsed.pullRequest === input.pullRequest &&
      parsed.receiptId === input.receiptId && parsed.depth === input.depth
    ? marker
    : null;
}

/** Parse one exact marker line; anything else is null. */
export function parseFollowUpMarker(line: string): FollowUpMarkerV1 | null {
  const match = MARKER_RE.exec(line);
  if (match === null) return null;
  return {
    owner: match[1],
    name: match[2],
    pullRequest: Number(match[3]),
    receiptId: match[4],
    depth: Number(match[5]),
  };
}

/** True when a first line is this candidate's marker, at any depth. */
export function markerNamesCandidate(
  line: string,
  candidate: FollowUpCandidateV1,
): boolean {
  const marker = parseFollowUpMarker(line);
  return marker !== null && marker.owner === candidate.repository.owner &&
    marker.name === candidate.repository.name &&
    marker.pullRequest === candidate.pullRequest;
}

/** One merged PR whose latest review left P1/P2/P3 findings unresolved. */
export interface FollowUpCandidateV1 {
  request: ReleaseRequestV1;
  repository: RepositoryIdentityV1;
  pullRequest: number;
  receipt: ReviewReceiptV1;
  findings: readonly ReviewFindingV1[];
  sourceIssue: number | null;
}

const OFF_TIP_MERGE_RE = /^merge ([0-9a-f]{40}) has parents /;

/** Parks that record an off-tip merge with the same detail suffix. */
const OFF_TIP_PARK_PREFIXES = [
  REVIEW_ROUND_CEILING_CARRIED_OFF_TIP_PREFIX,
  // The runtime's merge CAS park for any merge off its reviewed base.
  MERGED_OFF_TIP_PREFIX,
] as const;

/** The trusted merge revision recorded by an off-tip park, or null. */
function offTipParkMergeRevision(
  record: RepairStateSnapshotV1["work"][number],
): string | null {
  if (record.nextStep !== "blocked" || record.blocker?.kind !== "other") {
    return null;
  }
  const message = record.blocker.message;
  const prefix = OFF_TIP_PARK_PREFIXES.find((p) => message.startsWith(p));
  if (prefix === undefined) return null;
  return OFF_TIP_MERGE_RE.exec(message.slice(prefix.length))?.[1] ?? null;
}

/** Build the same candidate shape for a merge parked without a request. */
function offTipParkCandidate(
  snapshot: Pick<RepairStateSnapshotV1, "reviews">,
  record: RepairStateSnapshotV1["work"][number],
): FollowUpCandidateV1 | null {
  const mergeRevision = offTipParkMergeRevision(record);
  const pullRequest = record.target.pr;
  const head = record.target.head;
  const base = record.target.base;
  if (
    mergeRevision === null || record.source.kind !== "issue" ||
    record.related.issueNumber === null || pullRequest === null ||
    head === null || base === null || record.blocker === null
  ) return null;
  const receipt = latestPullReview(
    snapshot,
    record,
    HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
  );
  if (
    receipt === null || receipt.resultId === null ||
    receipt.completedAt === null || reviewBlocksMerge(receipt)
  ) return null;
  const request: ReleaseRequestV1 = {
    version: "v1",
    kind: "release_request",
    id: `off-tip:${record.id}:${mergeRevision}`,
    target: { repository: record.repository, environment: "production" },
    revision: mergeRevision as ReleaseRequestV1["revision"],
    source: {
      pullRequest,
      reviewRequestId: receipt.requestId,
      reviewReceiptId: receipt.id,
      head,
      base,
    },
    status: "fulfilled",
    failureReason: null,
    createdAt: record.blocker.since,
  };
  const findings = receipt.findings.filter((finding) =>
    !finding.resolved && !BLOCKING_SEVERITIES.includes(finding.severity)
  );
  if (findings.length === 0) return null;
  return {
    request,
    repository: record.repository,
    pullRequest,
    receipt,
    findings,
    sourceIssue: receipt.taskAcceptance?.issueNumber ??
      record.related.issueNumber,
  };
}

/**
 * Production release requests (open, or fulfilled by a release) created at or
 * after the owner-decision epoch, plus carried off-tip parks, newest first,
 * one per (repository, PR). The lower bound is fixed rather than anchored at
 * `now`: a launcher installed after a request was created must still see it.
 * The findings come from the LATEST identity-bound completed App review of
 * the request's exact PR, head and base, which must have zero uncounted
 * findings and no unresolved P0; only its unresolved P1/P2/P3 findings count,
 * and a request without one is not a candidate.
 */
export function planFollowUpCandidates(
  snapshot: Pick<RepairStateSnapshotV1, "releaseRequests" | "reviews" | "work">,
  now: number,
): FollowUpCandidateV1[] {
  const requests = snapshot.releaseRequests
    .filter((request) =>
      request.target.environment === "production" &&
      (request.status === "open" || request.status === "fulfilled") &&
      request.createdAt >= FOLLOW_UP_EPOCH && request.createdAt <= now
    );
  const candidates: FollowUpCandidateV1[] = [];
  for (const request of requests) {
    const repository = request.target.repository;
    const pullRequest = request.source.pullRequest;
    // A refreshed head merged under a carried review files the findings of
    // the review it carried (the request names that exact receipt).
    const receipt = identityBoundReviews(
      snapshot.reviews,
      repository,
      pullRequest,
      request.source.head,
      request.source.base,
    ).at(-1) ?? carriedRequestReceipt(snapshot.reviews, request) ?? undefined;
    if (receipt === undefined || reviewBlocksMerge(receipt)) continue;
    const findings = receipt.findings.filter((finding) =>
      !finding.resolved && !BLOCKING_SEVERITIES.includes(finding.severity)
    );
    if (findings.length === 0) continue;
    const record = snapshot.work.find((item) =>
      sameRepository(item.repository, repository) &&
      item.target.pr === pullRequest &&
      item.target.head === request.source.head
    );
    candidates.push({
      request,
      repository,
      pullRequest,
      receipt,
      findings,
      sourceIssue: receipt.taskAcceptance?.issueNumber ??
        record?.related.issueNumber ?? null,
    });
  }
  for (const record of snapshot.work) {
    const candidate = offTipParkCandidate(snapshot, record);
    if (
      candidate !== null && candidate.request.createdAt >= FOLLOW_UP_EPOCH &&
      candidate.request.createdAt <= now
    ) candidates.push(candidate);
  }
  candidates.sort((a, b) =>
    b.request.createdAt - a.request.createdAt ||
    (a.request.id < b.request.id ? -1 : a.request.id > b.request.id ? 1 : 0)
  );
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${
      hostedRepositoryKey(candidate.repository)
    }#${candidate.pullRequest}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// C0 controls except tab and LF, DEL, C1 controls, zero-width and bidi
// controls, line/paragraph separators and the BOM.
const STRIP =
  // deno-lint-ignore no-control-regex
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
const ZWSP = "\u200b";

/**
 * The reviewer's text made inert for an issue body: controls (including CR)
 * removed, every `@` followed by a zero-width space (no mention, including
 * `@codex`), every `#` before a digit broken (no issue reference and so no
 * closing keyword) and a line-leading `/` guarded (no slash command).
 */
export function inertText(text: string): string {
  return text.replace(STRIP, "")
    .replace(/@/g, `@${ZWSP}`)
    .replace(/#(?=[0-9])/g, `#${ZWSP}`)
    .replace(/^([ \t]*)\//gm, `$1${ZWSP}/`);
}

/** A tilde fence longer than any tilde run in the text. */
function fenced(text: string): string {
  const longest = Math.max(
    2,
    ...[...text.matchAll(/~+/g)].map((match) => match[0].length),
  );
  const fence = "~".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

/** Cut at most `max` UTF-16 units without splitting a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return text.slice(0, end);
}

const SAFE_PATH = /^[A-Za-z0-9._/-]{1,512}$/;

function safePath(path: string | null): path is string {
  return path !== null && SAFE_PATH.test(path) && !path.startsWith("/") &&
    !path.split("/").includes("..");
}

/**
 * The location of one finding and its message without the trailing
 * `<path>:a-b` line the reviewer stores there. A path outside the safe shape
 * is never linked or echoed outside the inert fence.
 */
function locate(
  finding: ReviewFindingV1,
  repository: Pick<RepositoryIdentityV1, "owner" | "name">,
  head: string,
): { where: string; message: string } {
  const message = finding.message.replace(/\s+$/, "");
  const path = finding.path;
  if (!safePath(path)) return { where: "(unlinked location)", message };
  const lines = message.split("\n");
  const last = (lines.at(-1) ?? "").trim();
  const range = last.startsWith(`${path}:`)
    ? /^([1-9][0-9]{0,6})(?:-([1-9][0-9]{0,6}))?$/.exec(
      last.slice(path.length + 1),
    )
    : null;
  if (range === null) return { where: `\`${path}\``, message };
  const start = Number(range[1]);
  const end = range[2] === undefined ? start : Number(range[2]);
  if (end < start) return { where: `\`${path}\``, message };
  const label = start === end ? `${path}:${start}` : `${path}:${start}-${end}`;
  const url =
    `https://github.com/${repository.owner}/${repository.name}/blob/${head}/${path}#L${start}-L${end}`;
  return {
    where: `[\`${label}\`](${url})`,
    message: lines.slice(0, -1).join("\n").replace(/\s+$/, ""),
  };
}

export interface FollowUpIssueV1 {
  title: string;
  body: string;
  /** Findings listed in the body. */
  listed: number;
  /** Findings left out by the bounds and counted in the body. */
  omitted: number;
}

/**
 * Render the one follow-up issue of a merged PR, or null when nothing may be
 * filed (no finding, an identity the marker cannot encode, or a depth outside
 * 1..FOLLOW_UP_MAX_DEPTH). Depth 3 is marked opt-out by the launcher.
 * Trailing findings that do not fit the bounds are dropped deterministically
 * into one "more findings" line.
 */
export function renderFollowUpIssue(input: {
  candidate: FollowUpCandidateV1;
  mergeRevision: string;
  depth: number;
}): FollowUpIssueV1 | null {
  const { candidate, mergeRevision, depth } = input;
  const { repository, pullRequest, receipt, findings } = candidate;
  if (depth < 1 || depth > FOLLOW_UP_MAX_DEPTH || findings.length === 0) {
    return null;
  }
  const marker = followUpMarker({
    owner: repository.owner,
    name: repository.name,
    pullRequest,
    receiptId: receipt.id,
    depth,
  });
  if (marker === null || !/^[0-9a-f]{40}$/.test(mergeRevision)) return null;
  const head = receipt.pullRequest.head;
  const count = findings.length;
  const noun = count === 1 ? "finding" : "findings";
  const title = cut(
    `Review follow-ups from #${pullRequest}: ${count} P1/P2/P3 ${noun}`,
    FOLLOW_UP_MAX_TITLE_CHARS,
  );
  const header = [
    marker,
    "",
    `Pull request #${pullRequest} was merged by Sentinel as \`${mergeRevision}\`. Its latest current-head review had no unresolved P0 finding, so it merged; the review left the P1/P2/P3 ${noun} below unresolved. Only P0 findings block a merge (owner directive 2026-10-24), so the rest are filed here as follow-up work.`,
    "",
    `- Merged pull request: #${pullRequest}`,
    ...(candidate.sourceIssue === null
      ? []
      : [`- Original issue: #${candidate.sourceIssue}`]),
    `- Reviewed head: \`${head}\``,
    `- Review receipt: \`${receipt.id}\``,
    "",
  ].join("\n");
  const footer =
    "\nFiled by the Sentinel launcher from the stored review receipt. The reviewer's text is quoted inert. Fix each finding with a regression test where practical.";
  const more = (omitted: number) =>
    `\n${omitted} more ${
      omitted === 1 ? "finding is" : "findings are"
    } recorded only in review receipt \`${receipt.id}\`.\n`;
  const ordered = [...findings].sort((a, b) =>
    a.severity < b.severity ? -1 : a.severity > b.severity ? 1 : 0
  );
  const reserve = more(count).length + footer.length;
  let body = header;
  let listed = 0;
  for (const finding of ordered) {
    if (listed >= FOLLOW_UP_MAX_FINDINGS) break;
    const { where, message } = locate(finding, repository, head);
    const inert = inertText(message);
    const detail = inert.length > FOLLOW_UP_MAX_FINDING_CHARS
      ? `${cut(inert, FOLLOW_UP_MAX_FINDING_CHARS)}\n[truncated]`
      : inert;
    const section = `\n### ${listed + 1}. ${finding.severity} at ${where}\n\n${
      fenced(detail)
    }\n`;
    if (body.length + section.length + reserve > FOLLOW_UP_MAX_BODY_CHARS) {
      break;
    }
    body += section;
    listed++;
  }
  const omitted = count - listed;
  if (omitted > 0) body += more(omitted);
  body += footer;
  return { title, body, listed, omitted };
}
