/** Trusted delivery policy changes commit shape, never the expected PR head. */
import { parseTargetDeliveryMethodV1 } from "../src/host/target-policy.ts";
import { closingIssueNumber } from "../src/github/port-merge-policy.ts";
import type { createHostedAutonomyRequest } from "./hosted-autonomy-github-listing.ts";
import type { HostedAutonomyGitHubV1 } from "./hosted-autonomy-types.ts";

export function createHostedAutonomyMerge(
  request: ReturnType<typeof createHostedAutonomyRequest>,
  scope: string,
  configuredMethod: unknown,
): HostedAutonomyGitHubV1["merge"] {
  // Validate before any remote effect; malformed policy is never a fallback.
  const policy = parseTargetDeliveryMethodV1(configuredMethod);
  return async (number, head, message) => {
    let method = policy;
    if (method === "squash") {
      const repo = await request("GET", `/repos/${scope}`);
      if (repo === null || typeof repo !== "object") return null;
      const allowed = (repo as Record<string, unknown>)["allow_squash_merge"];
      if (typeof allowed !== "boolean") return null;
      if (!allowed) method = "merge";
    }
    const body: Record<string, unknown> = { sha: head, merge_method: method };
    if (method === "squash") {
      const pull = await request("GET", `/repos/${scope}/pulls/${number}`);
      if (pull === null || typeof pull !== "object") return null;
      const pr = pull as Record<string, unknown>;
      const prHead = pr["head"] as Record<string, unknown> | null | undefined;
      const title = pr["title"];
      const issue = typeof pr["body"] === "string"
        ? closingIssueNumber(pr["body"])
        : null;
      if (
        pr["number"] !== number || prHead?.["sha"] !== head ||
        typeof title !== "string" || title.trim().length === 0 || issue === null
      ) return null;
      // Do not inherit GitHub's commit-list body (including base-refresh
      // bookkeeping), or append carried evidence to this exact closing message.
      body["commit_title"] = title;
      body["commit_message"] = `Resolves #${issue}`;
    } else if (message !== undefined) {
      body["commit_message"] = message;
    }
    const response = await request(
      "PUT",
      `/repos/${scope}/pulls/${number}/merge`,
      body,
    );
    if (response === null || typeof response !== "object") return null;
    const obj = response as Record<string, unknown>;
    return {
      merged: obj["merged"] === true,
      sha: typeof obj["sha"] === "string" ? obj["sha"] : null,
    };
  };
}
