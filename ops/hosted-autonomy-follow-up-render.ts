/**
 * Identity and rendering of one review follow-up issue per unresolved
 * P1/P2/P3 finding (owner directive 2026-10-31). Each issue carries a v2
 * first-line marker naming its finding, so a re-run never files the same
 * (receipt, finding) twice. Legacy v1 markers (one combined issue per PR)
 * remain recognized: an already-filed combined issue suppresses every
 * finding of that PR. Pure text only; the launcher owns every read and write.
 */
import type {
  ReviewFindingV1,
  ReviewReceiptV1,
} from "../src/contracts/review-receipt.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";

/** Well inside the runtime's 16,384-character task-statement bound. */
export const FOLLOW_UP_MAX_BODY_CHARS = 12_000;
export const FOLLOW_UP_MAX_TITLE_CHARS = 120;
export const FOLLOW_UP_MAX_FINDING_CHARS = 1500;
/** Depth 3 is filed, but opted out so it cannot re-enter Sentinel. */
export const FOLLOW_UP_MAX_DEPTH = 3;

const MARKER_V1_RE =
  /^<!-- sentinel:review-followup:v1 repo=([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}) pr=([1-9][0-9]{0,9}) receipt=([A-Za-z0-9:_.-]{1,200}) depth=([1-9][0-9]?) -->$/;
const MARKER_V2_RE =
  /^<!-- sentinel:review-followup:v2 repo=([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}) pr=([1-9][0-9]{0,9}) receipt=([A-Za-z0-9:_.-]{1,200}) finding=([A-Za-z0-9_.-]{1,128}) depth=([1-9][0-9]?) -->$/;

export interface FollowUpMarkerV1 {
  owner: string;
  name: string;
  pullRequest: number;
  receiptId: string;
  depth: number;
  /** v1 is the historical combined issue; v2 names one finding. */
  version: "v1" | "v2";
  /** The finding fingerprint on a v2 marker, null on a v1 marker. */
  finding: string | null;
}

export interface FollowUpMarkerInputV1 {
  owner: string;
  name: string;
  pullRequest: number;
  receiptId: string;
  depth: number;
  /** Omitted or null emits the legacy v1 marker. */
  finding?: string | null;
}

/** The exact first-line marker, or null when an identity cannot be encoded. */
export function followUpMarker(input: FollowUpMarkerInputV1): string | null {
  const finding = input.finding ?? null;
  const marker = finding === null
    ? `<!-- sentinel:review-followup:v1 repo=${input.owner}/${input.name} pr=${input.pullRequest} receipt=${input.receiptId} depth=${input.depth} -->`
    : `<!-- sentinel:review-followup:v2 repo=${input.owner}/${input.name} pr=${input.pullRequest} receipt=${input.receiptId} finding=${finding} depth=${input.depth} -->`;
  const parsed = parseFollowUpMarker(marker);
  return parsed !== null && parsed.owner === input.owner &&
      parsed.name === input.name &&
      parsed.pullRequest === input.pullRequest &&
      parsed.receiptId === input.receiptId && parsed.depth === input.depth &&
      parsed.version === (finding === null ? "v1" : "v2") &&
      parsed.finding === finding
    ? marker
    : null;
}

/** Parse one exact v1 or v2 marker line; anything else is null. */
export function parseFollowUpMarker(line: string): FollowUpMarkerV1 | null {
  const v2 = MARKER_V2_RE.exec(line);
  if (v2 !== null) {
    return {
      owner: v2[1],
      name: v2[2],
      pullRequest: Number(v2[3]),
      receiptId: v2[4],
      depth: Number(v2[6]),
      version: "v2",
      finding: v2[5],
    };
  }
  const v1 = MARKER_V1_RE.exec(line);
  if (v1 === null) return null;
  return {
    owner: v1[1],
    name: v1[2],
    pullRequest: Number(v1[3]),
    receiptId: v1[4],
    depth: Number(v1[5]),
    version: "v1",
    finding: null,
  };
}

interface MarkerCandidateV1 {
  repository: Pick<RepositoryIdentityV1, "owner" | "name">;
  pullRequest: number;
  receipt: Pick<ReviewReceiptV1, "id">;
}

/** True when a first line names this candidate's PR, at any receipt or depth. */
export function markerNamesCandidate(
  line: string,
  candidate: MarkerCandidateV1,
): boolean {
  const marker = parseFollowUpMarker(line);
  return marker !== null && marker.owner === candidate.repository.owner &&
    marker.name === candidate.repository.name &&
    marker.pullRequest === candidate.pullRequest;
}

/**
 * True when an existing App issue already covers one finding. A v1 combined
 * marker covers every finding of its PR (already-filed legacy behavior); a v2
 * marker covers exactly its (receipt, finding) pair at any depth.
 */
export function markerCoversFinding(
  line: string,
  candidate: MarkerCandidateV1,
  finding: string,
): boolean {
  const marker = parseFollowUpMarker(line);
  if (
    marker === null || marker.owner !== candidate.repository.owner ||
    marker.name !== candidate.repository.name ||
    marker.pullRequest !== candidate.pullRequest
  ) return false;
  return marker.version === "v1" ||
    (marker.receiptId === candidate.receipt.id &&
      marker.finding === finding);
}

// C0 controls except tab and LF, DEL, C1 controls, zero-width and bidi
// controls, line/paragraph separators and the BOM.
const STRIP =
  // deno-lint-ignore no-control-regex
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
const ZWSP = "\u200b";

/**
 * The reviewer's text made inert for a title or issue body: controls
 * (including CR) removed, every `@` followed by a zero-width space (no
 * mention, including `@codex`), every `#` before a digit broken (no issue
 * reference and so no closing keyword) and a line-leading `/` guarded (no
 * slash command).
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

interface LocationV1 {
  /** Markdown link for the body, or a static unlinked placeholder. */
  where: string;
  /** Plain `path[:a-b]` for the title, or null. */
  label: string | null;
  /** The finding message without the trailing `<path>:a-b` line. */
  message: string;
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
): LocationV1 {
  const message = finding.message.replace(/\s+$/, "");
  const path = finding.path;
  if (!safePath(path)) {
    return { where: "(unlinked location)", label: null, message };
  }
  const lines = message.split("\n");
  const last = (lines.at(-1) ?? "").trim();
  const range = last.startsWith(`${path}:`)
    ? /^([1-9][0-9]{0,6})(?:-([1-9][0-9]{0,6}))?$/.exec(
      last.slice(path.length + 1),
    )
    : null;
  if (range === null) {
    return { where: `\`${path}\``, label: path, message };
  }
  const start = Number(range[1]);
  const end = range[2] === undefined ? start : Number(range[2]);
  if (end < start) {
    return { where: `\`${path}\``, label: path, message };
  }
  const label = start === end ? `${path}:${start}` : `${path}:${start}-${end}`;
  const url =
    `https://github.com/${repository.owner}/${repository.name}/blob/${head}/${path}#L${start}-L${end}`;
  return {
    where: `[\`${label}\`](${url})`,
    label,
    message: lines.slice(0, -1).join("\n").replace(/\s+$/, ""),
  };
}

export interface FollowUpIssueCandidateV1 {
  repository: RepositoryIdentityV1;
  pullRequest: number;
  receipt: ReviewReceiptV1;
  sourceIssue: number | null;
}

export interface FollowUpIssueV1 {
  title: string;
  body: string;
  /** The finding fingerprint this issue concerns. */
  findingKey: string;
  /** Historical fields: exactly one finding is listed, none omitted. */
  listed: number;
  omitted: number;
}

/** The stable identity of one finding inside its stored review receipt. */
export function followUpFindingKey(finding: ReviewFindingV1): string {
  return finding.fingerprint;
}

/** The first line of the finding text without a duplicated severity prefix. */
function findingHeadline(message: string): string {
  const first = (message.split("\n", 1)[0] ?? "").replace(/\s+$/, "");
  return first.replace(/^\s*\[P[0-3]\]\s*/i, "").trim() ||
    "(finding without a title)";
}

/**
 * Render the one follow-up issue of one unresolved P1/P2/P3 finding, or null
 * when nothing may be filed (a resolved or P0 finding, an identity the marker
 * cannot encode, or a depth outside 1..FOLLOW_UP_MAX_DEPTH). Depth 3 is
 * marked opt-out by the launcher.
 */
export function renderFollowUpIssue(input: {
  candidate: FollowUpIssueCandidateV1;
  finding: ReviewFindingV1;
  mergeRevision: string;
  depth: number;
}): FollowUpIssueV1 | null {
  const { candidate, finding, mergeRevision, depth } = input;
  const { repository, pullRequest, receipt } = candidate;
  if (
    depth < 1 || depth > FOLLOW_UP_MAX_DEPTH || finding.resolved ||
    finding.severity === "P0"
  ) return null;
  const findingKey = followUpFindingKey(finding);
  const marker = followUpMarker({
    owner: repository.owner,
    name: repository.name,
    pullRequest,
    receiptId: receipt.id,
    depth,
    finding: findingKey,
  });
  if (marker === null || !/^[0-9a-f]{40}$/.test(mergeRevision)) return null;
  const head = receipt.pullRequest.head;
  const located = locate(finding, repository, head);
  const prefix = `[${finding.severity}] `;
  const suffix = located.label === null ? "" : ` (${located.label})`;
  const headline = cut(
    inertText(findingHeadline(located.message)).replace(/\s+/g, " ").trim(),
    Math.max(1, FOLLOW_UP_MAX_TITLE_CHARS - prefix.length - suffix.length),
  );
  const title = cut(
    `${prefix}${headline}${suffix}`,
    FOLLOW_UP_MAX_TITLE_CHARS,
  );
  const header = [
    marker,
    "",
    `Pull request #${pullRequest} was merged by Sentinel as \`${mergeRevision}\`. Its latest current-head review had no unresolved P0 finding, so it merged; the review left the P1/P2/P3 finding below unresolved. Only P0 findings block a merge (owner directive 2026-10-24), so it is filed here as follow-up work.`,
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
    "\n\nFiled by the Sentinel launcher from the stored review receipt. The reviewer's text is quoted inert. Fix each finding with a regression test where practical.";
  const inert = inertText(located.message);
  const framing = `\n### ${finding.severity} at ${located.where}\n\n`;
  const room = FOLLOW_UP_MAX_BODY_CHARS - header.length - framing.length -
    footer.length - 16;
  const limit = Math.max(
    0,
    Math.min(FOLLOW_UP_MAX_FINDING_CHARS, room),
  );
  const detail = inert.length > limit
    ? `${cut(inert, limit)}\n[truncated]`
    : inert;
  const body = header + framing + fenced(detail) + footer;
  if (body.length > FOLLOW_UP_MAX_BODY_CHARS) return null;
  return { title, body, findingKey, listed: 1, omitted: 0 };
}
