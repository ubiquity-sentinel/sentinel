/**
 * The upkeep deferral owner-issue capability (#327) on Sentinel's own
 * repository, over the trusted App token finalize already holds for the self
 * state and the watchdog issues. It reuses the existing trusted issue port
 * (`hosted-autonomy-github-issues.ts`): the bounded open App-authored marker
 * listing, the App-authored confirmed create (no label) and the confirmed
 * title/body edit, plus one issue read to re-check a recorded number. Nothing
 * here changes Sentinel state, closes, comments on or labels an issue.
 */
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import {
  UPKEEP_DEFERRAL_ISSUE_MARKER,
  type UpkeepDeferralIssuesV1,
} from "../src/host/upkeep-deferral-issue.ts";
import { HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR } from "./hosted-autonomy-policy.ts";
import {
  API_BASE,
  type createHostedAutonomyRequest,
} from "./hosted-autonomy-github-listing.ts";
import {
  createHostedCapabilityIssues,
  createHostedFollowUpIssues,
  findOpenMarkedIssue,
  hasIssueMarker,
  parseIssueItem,
} from "./hosted-autonomy-github-issues.ts";

export function createHostedUpkeepIssues(
  request: ReturnType<typeof createHostedAutonomyRequest>,
  repository: RepositoryIdentityV1,
): UpkeepDeferralIssuesV1 {
  const scope = `${repository.owner}/${repository.name}`;
  const repositoryUrl = `${API_BASE}/repos/${scope}`;
  const followUps = createHostedFollowUpIssues(request, repository);
  const capability = createHostedCapabilityIssues(request, repository);
  return {
    async isOpenMarked(number) {
      if (!Number.isSafeInteger(number) || number <= 0) return false;
      const raw = await request("GET", `/repos/${scope}/issues/${number}`);
      const item = parseIssueItem(raw, repositoryUrl);
      if (item === null || item.number !== number) return null;
      const row = raw as Record<string, unknown>;
      const state = row["state"];
      if (state !== "open" && state !== "closed") return null;
      const body = row["body"];
      return state === "open" && !item.pullRequest &&
        item.author === HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR &&
        typeof body === "string" &&
        hasIssueMarker(body, UPKEEP_DEFERRAL_ISSUE_MARKER);
    },
    findOpenMarked: () =>
      findOpenMarkedIssue(request, repository, UPKEEP_DEFERRAL_ISSUE_MARKER),
    create: (input) =>
      followUps.create({ title: input.title, body: input.body }),
    update: (number, input) => capability.update(number, input),
  };
}
