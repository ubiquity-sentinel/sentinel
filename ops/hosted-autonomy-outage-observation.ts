/**
 * CI outage observation (2026-10-25 redesign, C5.4).
 *
 * Since 2026-10-24 06:40 UTC GitHub has started no Passport Actions job: every
 * check on every commit is a completed `failure` with no runner and no steps
 * (the billing or spending-limit shape). Nothing in Sentinel's code can fix
 * that, and nothing told the owner. Once per maintenance pass this state-free
 * pass reads, for each foreign target with waiting work (or an open notice),
 * the default-branch tip and classifies its checks with the injected
 * never-started predicate (C2, `classifyTip`). It keeps exactly one notice per
 * such target on Sentinel's OWN tracker:
 * - the tip's checks never started (at least one never-started failure, no
 *   started check, nothing undetermined): file the notice, or update its body
 *   when the tip or the counts changed;
 * - a check started on the tip again: close the App's notice with one comment;
 * - anything else (pending, unreadable): change nothing.
 *
 * The notice carries the marker `<!-- sentinel:ci-outage:<owner>/<repo> -->`
 * on its first line, the tip, the number of never-started checks, the number
 * of Sentinel records waiting in that repository and one plain owner action.
 * It contains no private content, writes no state and is never admitted as a
 * repair task (`isCiOutageNotice`). Every refusal is an action, never a
 * failure of the maintenance pass.
 */
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import {
  CI_OUTAGE_AUTHORS,
  ciOutageMarker,
  ciOutageMarkerSlug,
} from "../src/repair/ci-outage-notice.ts";
import { isHostedSelf } from "./hosted-autonomy-policy.ts";
import { createHostedAutonomyScopes } from "./hosted-autonomy-scopes.ts";
import { readRepairSafely } from "./hosted-autonomy-state.ts";
import type { HostedAutonomyDepsV1 } from "./hosted-autonomy-types.ts";
import {
  API_BASE,
  type createHostedAutonomyRequest,
  LISTING_PAGE_SIZE,
  MAX_COMPARE_RESPONSE_BYTES,
} from "./hosted-autonomy-github-listing.ts";

/** Wall-clock budget of the pass inside the maintenance pass. */
export const OUTAGE_PASS_BUDGET_MS = 60_000;

/** Open-issue pages read at most from Sentinel's own tracker. */
const MAX_NOTICE_PAGES = 10;

/** One check run of a tip, as its complete listing reports it. */
export interface OutageCheckRunV1 {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

/** The C2 start class of one completed failed Actions check run. */
export type CheckStartV1 = "started" | "not_started" | "unknown";

/** A tip's checks by start class (skipped and cancelled count nowhere). */
export interface OutageTipStartV1 {
  neverStarted: number;
  started: number;
  unknown: number;
}

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);
const RAN = new Set(["success", "neutral"]);

/**
 * Classify a tip's complete check listing with the injected never-started
 * predicate. Only a completed failure asks the predicate (C2 reads the
 * Actions job only there); a running or passed check started; a queued one
 * is undetermined; a skipped, cancelled or stale one counts nowhere, because
 * a billing outage also skips every job that `needs:` the failed one.
 */
export async function classifyTipChecks(
  runs: readonly OutageCheckRunV1[],
  isNeverStarted: (run: OutageCheckRunV1) => Promise<CheckStartV1>,
): Promise<OutageTipStartV1> {
  const start: OutageTipStartV1 = { neverStarted: 0, started: 0, unknown: 0 };
  for (const run of runs) {
    if (run.status === "in_progress") start.started++;
    else if (run.status !== "completed") start.unknown++;
    else if (RAN.has(run.conclusion ?? "")) start.started++;
    else if (FAILED.has(run.conclusion ?? "")) {
      let kind: CheckStartV1 = "unknown";
      try {
        kind = await isNeverStarted(run);
      } catch {
        kind = "unknown";
      }
      if (kind === "not_started") start.neverStarted++;
      else if (kind === "started") start.started++;
      else start.unknown++;
    }
  }
  return start;
}

/** Only never-started checks: at least one, none started, none undetermined. */
export function isOutageTip(start: OutageTipStartV1): boolean {
  return start.neverStarted > 0 && start.started === 0 && start.unknown === 0;
}

/** One open issue of Sentinel's tracker whose first line is a notice marker. */
export interface OutageNoticeV1 {
  number: number;
  author: string;
  body: string;
}

/** Sentinel's own tracker, as the outage pass uses it. */
export interface OutageTrackerV1 {
  /** Every open issue (never a PR) carrying a notice marker, or null. */
  listOpenNotices(): Promise<readonly OutageNoticeV1[] | null>;
  /** The new issue's number when GitHub echoes it exactly; else null. */
  file(input: { title: string; body: string }): Promise<number | null>;
  /** True when the issue now has exactly this body. */
  update(number: number, body: string): Promise<boolean>;
  /** Comment once, then close; true when the issue ends closed. */
  close(number: number, comment: string): Promise<boolean>;
}

export interface HostedOutageObservationInputV1 {
  /** Sentinel's own tracker (`ubiquity-sentinel/sentinel`), or null. */
  tracker: OutageTrackerV1 | null;
  /**
   * The injected never-started classification of one target tip (C2), or
   * null when its checks cannot be read completely.
   */
  classifyTip(
    repository: RepositoryIdentityV1,
    tip: string,
  ): Promise<OutageTipStartV1 | null>;
}

const slugOf = (repository: { owner: string; name: string }) =>
  `${repository.owner}/${repository.name}`;

/** The notice for one target in an outage (plain language, no private text). */
export function ciOutageNotice(input: {
  repository: { owner: string; name: string };
  tip: string;
  neverStarted: number;
  waiting: number;
}): { title: string; body: string } {
  const slug = slugOf(input.repository);
  return {
    title: `GitHub Actions cannot start CI on ${slug}`,
    body: [
      ciOutageMarker(input.repository),
      "",
      `GitHub Actions has not started any CI job on \`${slug}\` at ${input.tip}. Every check there completed as a failure without a runner and without a single step, the shape GitHub reports when Actions billing is unavailable or the spending limit is reached.`,
      "",
      `- Tip: ${input.tip}`,
      `- Checks that never started: ${input.neverStarted}`,
      `- Sentinel records waiting in this repository: ${input.waiting}`,
      "",
      `Owner action: restore Actions billing or raise the spending limit for ${input.repository.owner}.`,
      "",
      "Until a check can start, Sentinel cannot judge, review or merge any repair there. It charges nothing for the wait. This issue closes itself when a check starts on the tip again.",
      "",
      "Kept automatically by Sentinel's maintenance pass; it writes no state.",
    ].join("\n"),
  };
}

/** The close comment once a check started on the tip again. */
export function ciOutageRecoveredComment(
  repository: { owner: string; name: string },
  tip: string,
): string {
  return `A check started on \`${
    slugOf(repository)
  }\` at ${tip}, so GitHub Actions runs jobs there again. Closing this notice; Sentinel continues with CI, review and merges on its normal path.`;
}

interface OutageTargetV1 {
  repository: RepositoryIdentityV1;
  waiting: number;
}

/**
 * Foreign repositories the pass reads: those with waiting work (at `work`,
 * `review` or `delivery`) and those an open notice names. The repository
 * identity is a waiting record's (else any record's) from the repair state;
 * a noticed repository Sentinel never worked is not resolved.
 */
function outageTargets(
  work: readonly { repository: RepositoryIdentityV1; nextStep: string }[],
  noticed: ReadonlySet<string>,
): OutageTargetV1[] {
  const targets = new Map<string, OutageTargetV1>();
  for (const record of work) {
    if (isHostedSelf(record.repository)) continue;
    const slug = slugOf(record.repository);
    const waiting = record.nextStep === "work" ||
      record.nextStep === "review" || record.nextStep === "delivery";
    const known = targets.get(slug);
    if (known === undefined) {
      targets.set(slug, {
        repository: record.repository,
        waiting: waiting ? 1 : 0,
      });
    } else if (waiting) {
      // A waiting record's identity is the one its work is addressed under.
      if (known.waiting === 0) known.repository = record.repository;
      known.waiting++;
    }
  }
  return [...targets.entries()]
    .filter(([slug, target]) => target.waiting > 0 || noticed.has(slug))
    .sort(([a], [b]) => a < b ? -1 : 1)
    .map(([, target]) => target);
}

/** Run the outage observation; its actions only, never a state change. */
export async function runHostedOutageObservationPass(
  deps: HostedAutonomyDepsV1,
  input: HostedOutageObservationInputV1,
  passDeadline: number = Number.POSITIVE_INFINITY,
): Promise<string[]> {
  const actions: string[] = [];
  const started = deps.clock.now();
  if (!Number.isSafeInteger(started)) return actions;
  const deadline = Math.min(started + OUTAGE_PASS_BUDGET_MS, passDeadline);
  const inBudget = () => {
    const now = deps.clock.now();
    return Number.isSafeInteger(now) && now < deadline;
  };
  if (!inBudget()) return actions;
  const tracker = input.tracker;
  if (tracker === null) return ["ci-outage:skipped:tracker_absent"];
  const read = await readRepairSafely(deps.state);
  if (read === null || !read.ok || read.value.status !== "found") {
    return actions;
  }
  let notices: readonly OutageNoticeV1[] | null = null;
  try {
    notices = await tracker.listOpenNotices();
  } catch {
    notices = null;
  }
  if (notices === null) return ["ci-outage:notices_unreadable"];
  const bySlug = new Map<string, OutageNoticeV1[]>();
  for (const notice of notices) {
    const slug = ciOutageMarkerSlug(notice.body.split(/\r?\n/, 1)[0] ?? "");
    if (slug === null) continue;
    bySlug.set(slug, [...(bySlug.get(slug) ?? []), notice]);
  }
  const { scopeFor, readTip } = createHostedAutonomyScopes(deps);
  const targets = outageTargets(
    read.value.snapshot.work,
    new Set(bySlug.keys()),
  );
  for (const target of targets) {
    const slug = slugOf(target.repository);
    const tag = `ci-outage:${slug}`;
    if (!inBudget()) {
      actions.push(`${tag}:deadline`);
      break;
    }
    try {
      const open = bySlug.get(slug) ?? [];
      const owned = open.filter((notice) =>
        CI_OUTAGE_AUTHORS.includes(notice.author)
      );
      const own = owned[0];
      const tip = await readTip(await scopeFor(target.repository));
      if (tip === null) {
        actions.push(`${tag}:tip_unreadable`);
        continue;
      }
      const start = await input.classifyTip(target.repository, tip);
      if (start === null) {
        actions.push(`${tag}:checks_unreadable`);
        continue;
      }
      if (!inBudget()) {
        actions.push(`${tag}:deadline`);
        break;
      }
      if (isOutageTip(start)) {
        if (target.waiting === 0 && own === undefined) continue;
        const notice = ciOutageNotice({
          repository: target.repository,
          tip,
          neverStarted: start.neverStarted,
          waiting: target.waiting,
        });
        if (own !== undefined) {
          if (own.body === notice.body) {
            actions.push(`${tag}:outage:open=#${own.number}`);
          } else {
            const updated = await tracker.update(own.number, notice.body);
            actions.push(
              `${tag}:outage:${
                updated ? "updated" : "update_failed"
              }=#${own.number}`,
            );
          }
        } else if (open.length > 0) {
          // Someone else's issue already carries the marker: no duplicate.
          actions.push(`${tag}:outage:foreign_notice=#${open[0].number}`);
        } else {
          const number = await tracker.file(notice);
          actions.push(
            number === null
              ? `${tag}:outage:file_failed`
              : `${tag}:outage:filed=#${number}`,
          );
        }
      } else if (start.started > 0) {
        // Every notice Sentinel filed for this target closes (an earlier race
        // may have left a second one).
        for (const notice of owned) {
          const closed = await tracker.close(
            notice.number,
            ciOutageRecoveredComment(target.repository, tip),
          );
          actions.push(
            `${tag}:recovered:${
              closed ? "closed" : "close_failed"
            }=#${notice.number}`,
          );
        }
      }
    } catch {
      actions.push(`${tag}:unexpected_error`);
    }
  }
  return actions;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** One open, non-PR issue of exactly this repository, with its body. */
function parseNotice(
  raw: unknown,
  repositoryUrl: string,
): OutageNoticeV1 | null {
  const item = record(raw);
  if (item === null) return null;
  const number = item["number"];
  const author = record(item["user"])?.["login"];
  const body = item["body"] ?? "";
  if (
    typeof number !== "number" || !Number.isSafeInteger(number) ||
    number <= 0 || item["repository_url"] !== repositoryUrl ||
    typeof author !== "string" || author.length === 0 ||
    typeof body !== "string" || item["pull_request"] !== undefined
  ) return null;
  return { number, author, body };
}

/**
 * Sentinel's own tracker over the launcher's App-token request: the open
 * issues listing, one issue create, one body update and one comment plus
 * close. Every answer must name exactly this repository; anything unproven is
 * null or false.
 */
export function createHostedOutageTracker(
  request: ReturnType<typeof createHostedAutonomyRequest>,
  repository: { owner: string; name: string },
): OutageTrackerV1 {
  const scope = slugOf(repository);
  const repositoryUrl = `${API_BASE}/repos/${scope}`;
  return {
    async listOpenNotices() {
      const notices: OutageNoticeV1[] = [];
      for (let page = 1; page <= MAX_NOTICE_PAGES; page++) {
        const raw = await request(
          "GET",
          `/repos/${scope}/issues?state=open&per_page=${LISTING_PAGE_SIZE}&page=${page}`,
          undefined,
          MAX_COMPARE_RESPONSE_BYTES,
        );
        if (!Array.isArray(raw) || raw.length > LISTING_PAGE_SIZE) return null;
        for (const entry of raw) {
          // The listing returns pull requests too; they are never notices.
          if (record(entry)?.["pull_request"] !== undefined) continue;
          const notice = parseNotice(entry, repositoryUrl);
          if (notice === null) return null;
          const first = notice.body.split(/\r?\n/, 1)[0] ?? "";
          if (ciOutageMarkerSlug(first) !== null) notices.push(notice);
        }
        if (raw.length < LISTING_PAGE_SIZE) return notices;
      }
      return null;
    },
    async file(input) {
      const raw = await request("POST", `/repos/${scope}/issues`, {
        title: input.title,
        body: input.body,
      });
      const created = parseNotice(raw, repositoryUrl);
      if (
        created === null || !CI_OUTAGE_AUTHORS.includes(created.author) ||
        record(raw)?.["title"] !== input.title || created.body !== input.body
      ) return null;
      return created.number;
    },
    async update(number, body) {
      if (!Number.isSafeInteger(number) || number <= 0) return false;
      const raw = await request("PATCH", `/repos/${scope}/issues/${number}`, {
        body,
      });
      const updated = parseNotice(raw, repositoryUrl);
      return updated !== null && updated.number === number &&
        updated.body === body;
    },
    async close(number, comment) {
      if (!Number.isSafeInteger(number) || number <= 0) return false;
      // The comment explains the close; a failed comment never keeps it open.
      await request("POST", `/repos/${scope}/issues/${number}/comments`, {
        body: comment,
      });
      const raw = await request("PATCH", `/repos/${scope}/issues/${number}`, {
        state: "closed",
        state_reason: "completed",
      });
      const closed = record(raw);
      return closed !== null && closed["number"] === number &&
        closed["state"] === "closed";
    },
  };
}
