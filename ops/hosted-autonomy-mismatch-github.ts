import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import type { MismatchDispositionObservationsV1 } from "./runtime-mismatch-recovery-disposition.ts";
import {
  API_BASE,
  createHostedAutonomyRequest,
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
} from "./hosted-autonomy-github-listing.ts";

/** Read-only mismatch evidence from exactly the repository's own API surface. */
export function createHostedMismatchDispositionObservations(
  token: string,
  repository: RepositoryIdentityV1,
): MismatchDispositionObservationsV1 {
  const scope = `${repository.owner}/${repository.name}`;
  const request = createHostedAutonomyRequest(token);
  /** Exact 404 proves absence; only the named identity proves presence. */
  const probeAbsent = async (
    path: string,
    present: (body: Record<string, unknown>) => boolean,
  ): Promise<boolean | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "sentinel-hosted-autonomy",
        },
        signal: controller.signal,
      });
      // Only an exact 404 proves absence; any other failure is unreadable.
      if (response.status === 404) return true;
      if (response.status < 200 || response.status >= 300) return null;
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) return null;
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== "object" || parsed === null) return null;
      return present(parsed as Record<string, unknown>) ? false : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    readRefAbsent: (ref: string) =>
      probeAbsent(
        `/repos/${scope}/git/ref/${ref.replace(/^refs\//, "")}`,
        (body) => typeof body["ref"] === "string",
      ),
    readCommitAbsent: (sha: string) =>
      /^[0-9a-f]{40}$/.test(sha)
        ? probeAbsent(
          `/repos/${scope}/git/commits/${sha}`,
          (body) => body["sha"] === sha,
        )
        : Promise.resolve(null),
    async listPullsByHead(branch: string) {
      const pulls = await request(
        "GET",
        `/repos/${scope}/pulls?state=all&head=${
          encodeURIComponent(`${repository.owner}:${branch}`)
        }&per_page=100`,
      );
      if (!Array.isArray(pulls)) return null;
      // A full page is not a proven complete listing; refuse it.
      if (pulls.length >= 100) return null;
      const parsed: { number: number; state: string; head: string | null }[] =
        [];
      for (const item of pulls) {
        if (typeof item !== "object" || item === null) return null;
        const obj = item as Record<string, unknown>;
        const number = Number(obj["number"]);
        const state = obj["state"];
        if (!Number.isSafeInteger(number) || number <= 0) return null;
        if (typeof state !== "string") return null;
        const head = obj["head"];
        const headRef = typeof head === "object" && head !== null
          ? (head as Record<string, unknown>)["ref"]
          : null;
        parsed.push({
          number,
          state,
          head: typeof headRef === "string" ? headRef : null,
        });
      }
      return parsed;
    },
    async readRunTerminal(runId: number) {
      const run = await request("GET", `/repos/${scope}/actions/runs/${runId}`);
      if (run === null || typeof run !== "object") return null;
      const status = (run as Record<string, unknown>)["status"];
      if (typeof status !== "string") return null;
      return status === "completed";
    },
  };
}
