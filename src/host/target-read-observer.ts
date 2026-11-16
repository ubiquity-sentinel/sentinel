/**
 * Which committed target reads failed in a way that looks transient, so a
 * pass whose every target read was unavailable defers only on a failure a
 * later run can outlast (actions-targets-deferral.ts). The observer wraps the
 * target resolvers' trusted transports and keeps one boolean per target
 * repository: whether its LAST read looked transient.
 *
 * - Transient: a thrown request (a network failure or deadline, a redirect the
 *   transport refuses, or a durable-cooldown refusal, which throws before any
 *   request), a 5xx, a 429, or a 403 with rate-limit evidence: `retry-after`,
 *   or what `classifyGitHubRateLimit` reads as a limit
 *   (`x-ratelimit-remaining: 0` or GitHub's secondary-limit message).
 * - Anything else is not: 401, 404, a 403 without that evidence, any other
 *   status, and a 2xx answer the resolver could not use. A target with no
 *   observed read (an injected resolver) is never transient.
 *
 * Every resolver returns right after the read that failed it, so a skipped
 * target's last read is the failing one. Observation never changes a
 * request, a response or a throw: a load with an observer is the same load.
 * Nothing but the boolean is kept: never a status, header or body.
 */
import type { HttpResponseV1, HttpTransportV1 } from "../github/http.ts";
import { classifyGitHubRateLimit } from "../github/rate-limit.ts";

/** Records reads made through observed transports, per target repository. */
export interface TargetReadObserverV1 {
  /** The same transport, observed. */
  readonly observe: (http: HttpTransportV1) => HttpTransportV1;
  /** True only when this repository's last observed read looked transient. */
  readonly transient: (
    target: { readonly owner: string; readonly name: string },
  ) => boolean;
}

/** True when one answered target read is a failure a later run can outlast. */
export async function transientTargetReadV1(
  response: HttpResponseV1,
  observedAt: number,
): Promise<boolean> {
  const status = response.status;
  if ((status >= 500 && status <= 599) || status === 429) return true;
  if (status !== 403) return false;
  if ((response.headers.get("retry-after") ?? "").trim() !== "") return true;
  try {
    return await classifyGitHubRateLimit(response, observedAt) !== null;
  } catch {
    return false;
  }
}

/** One observer for the target reads of one load. */
export function createTargetReadObserverV1(options: {
  /** Observation instant for the rate-limit classifier. */
  readonly now: () => number;
  readonly apiBaseUrl?: string;
}): TargetReadObserverV1 {
  const base = new URL(options.apiBaseUrl ?? "https://api.github.com")
    .pathname.replace(/\/$/, "");
  const last = new Map<string, boolean>();
  const repositoryOf = (url: string): string | null => {
    let path: string;
    try {
      path = new URL(url).pathname;
    } catch {
      return null;
    }
    const prefix = `${base}/repos/`;
    if (!path.startsWith(prefix)) return null;
    const [owner, name] = path.slice(prefix.length).split("/");
    return owner && name ? `${owner}/${name}` : null;
  };
  return {
    observe: (http) => async (request) => {
      const repository = repositoryOf(request.url);
      let response: HttpResponseV1;
      try {
        response = await http(request);
      } catch (error) {
        if (repository !== null) last.set(repository, true);
        throw error;
      }
      if (repository !== null) {
        let transient = false;
        try {
          transient = await transientTargetReadV1(response, options.now());
        } catch {
          transient = false;
        }
        last.set(repository, transient);
      }
      return response;
    },
    transient: (target) => last.get(`${target.owner}/${target.name}`) === true,
  };
}
