/**
 * CI outage notice marker (2026-10-25 redesign, C5.4).
 *
 * The launcher's outage observation (`ops/hosted-autonomy-outage-observation.ts`)
 * keeps one issue per target whose default-branch tip has only never-started
 * CI on Sentinel's own tracker, marked on its first body line. It is an owner
 * notice (restore Actions billing or raise the spending limit), not a repair:
 * no code change fixes it, so intake never admits it as a self task
 * (`isCiOutageNotice`). Only a notice filed by Sentinel's own automation is
 * skipped; an issue anyone else opens with the same first line is ordinary
 * work.
 */

/** First body line prefix of an outage notice: `<prefix><owner>/<name> -->`. */
export const CI_OUTAGE_MARKER_PREFIX = "<!-- sentinel:ci-outage:";

/** The App identity that files outage notices. */
export const CI_OUTAGE_AUTHOR = "ubiquity-sentinel[bot]";

/**
 * Sentinel's own automation identities on its own tracker: the App, or the
 * native workflow token the maintenance job falls back to for the self scope.
 */
export const CI_OUTAGE_AUTHORS: readonly string[] = [
  CI_OUTAGE_AUTHOR,
  "github-actions[bot]",
];

/** The marker line of the outage notice for one target repository. */
export function ciOutageMarker(
  repository: { owner: string; name: string },
): string {
  return `${CI_OUTAGE_MARKER_PREFIX}${repository.owner}/${repository.name} -->`;
}

/** The `owner/name` a marker line names, or null for any other line. */
export function ciOutageMarkerSlug(firstLine: string): string | null {
  const match = /^<!-- sentinel:ci-outage:([^/\s]+\/[^/\s]+) -->$/.exec(
    firstLine,
  );
  return match === null ? null : match[1];
}

/** True for an outage notice Sentinel filed (never a repair task). */
export function isCiOutageNotice(
  issue: { body: string; author: string | null },
): boolean {
  return issue.author !== null && CI_OUTAGE_AUTHORS.includes(issue.author) &&
    ciOutageMarkerSlug(issue.body.split(/\r?\n/, 1)[0] ?? "") !== null;
}
