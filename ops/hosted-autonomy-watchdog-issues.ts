/**
 * The throughput watchdog's issue capability on Sentinel's own repository,
 * over the trusted App token finalize already holds for the self state. It
 * reuses the existing trusted issue port (`hosted-autonomy-github-issues.ts`)
 * for the create (with labels, confirmed by the App-authored echo) and the
 * title/body edit, and adds one complete bounded listing of the OPEN issues
 * and pull requests (oldest first; a malformed or repeated item, or a full
 * page at the bound, refuses the whole listing). Nothing here changes
 * Sentinel state, closes, comments on or labels an existing item.
 */
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import {
  parseThroughputWatchdogMarkerV1,
  referencedIssueNumbersV1,
  type ThroughputWatchdogIssuesV1,
  type ThroughputWatchdogListingV1,
} from "../src/host/throughput-watchdog-issue.ts";
import { HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR } from "./hosted-autonomy-policy.ts";
import {
  API_BASE,
  type createHostedAutonomyRequest,
  LISTING_PAGE_SIZE,
  MAX_COMPARE_RESPONSE_BYTES,
  MAX_LISTING_PAGES,
} from "./hosted-autonomy-github-listing.ts";
import {
  createHostedCapabilityIssues,
  createHostedFollowUpIssues,
  parseIssueItem,
} from "./hosted-autonomy-github-issues.ts";

/** Characters of a pull request body scanned for issue references. */
export const WATCHDOG_PULL_BODY_SCAN = 4096;

export function createHostedWatchdogIssues(
  request: ReturnType<typeof createHostedAutonomyRequest>,
  repository: RepositoryIdentityV1,
): ThroughputWatchdogIssuesV1 {
  const scope = `${repository.owner}/${repository.name}`;
  const repositoryUrl = `${API_BASE}/repos/${scope}`;
  const followUps = createHostedFollowUpIssues(request, repository);
  const capability = createHostedCapabilityIssues(request, repository);
  return {
    async listOpen() {
      const out: ThroughputWatchdogListingV1 = { issues: [], pulls: [] };
      const seen = new Set<number>();
      for (let page = 1; page <= MAX_LISTING_PAGES; page++) {
        const raw = await request(
          "GET",
          `/repos/${scope}/issues?state=open&sort=created&direction=asc&per_page=${LISTING_PAGE_SIZE}&page=${page}`,
          undefined,
          MAX_COMPARE_RESPONSE_BYTES,
        );
        if (!Array.isArray(raw) || raw.length > LISTING_PAGE_SIZE) return null;
        for (const entry of raw) {
          const item = parseIssueItem(entry, repositoryUrl);
          if (item === null) return null;
          const row = entry as Record<string, unknown>;
          const body = row["body"] ?? null;
          const title = row["title"];
          if (
            seen.has(item.number) ||
            row["state"] !== "open" || typeof title !== "string" ||
            (body !== null && typeof body !== "string")
          ) return null;
          seen.add(item.number);
          if (item.pullRequest) {
            const text = `${title}\n${
              ((body as string | null) ?? "").slice(0, WATCHDOG_PULL_BODY_SCAN)
            }`;
            out.pulls.push({
              number: item.number,
              title,
              references: referencedIssueNumbersV1(text),
            });
            continue;
          }
          const thresholdId = parseThroughputWatchdogMarkerV1(
            body as string | null,
          );
          if (thresholdId === null) continue;
          out.issues.push({
            number: item.number,
            thresholdId,
            appAuthored: item.author === HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
          });
        }
        if (raw.length < LISTING_PAGE_SIZE) return out;
      }
      // A full last page at the bound proves nothing about the rest.
      return null;
    },
    create: (input) =>
      followUps.create({
        title: input.title,
        body: input.body,
        labels: input.labels,
      }),
    update: (number, input) => capability.update(number, input),
  };
}
