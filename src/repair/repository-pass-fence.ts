/**
 * Effect fences of a fan-out repository pass (issue #328).
 *
 * The pass runs the ordinary step loop with read capabilities only. Every
 * capability that writes outside the pass's private fork (a GitHub write, a
 * model start, a replay, a budget reservation or settlement, a durable
 * cooldown record) is replaced by a fence that performs nothing, answers a
 * typed `unavailable` (or the budget's `disabled`), and marks the current
 * interval of the pass as needing the trusted writer. The pass then discards
 * every fork write of that interval, so no row of a step that needed an
 * effect ever reaches a delta.
 */
import { portError } from "../contracts/ports.ts";
import type { GitHubPort } from "../contracts/ports.ts";
import type { RepairCycleDepsV1 } from "./loop-types.ts";

export const FENCE_DETAIL =
  "repository pass defers effects to the trusted writer";

/** GitHub port members that write, publish, merge, close or review. */
const GITHUB_EFFECTS = new Set<string>([
  "prepareBaseRefresh",
  "pushHead",
  "createPullRequest",
  "requestReview",
  "mergePullRequest",
  "closeIssue",
  "closeAlreadySatisfiedTask",
  "assignIssue",
  "preserveCandidate",
  "drainReviews",
]);
/** In-process review completion notifications belong to the review owner. */
const GITHUB_WITHHELD = new Set<string>(["onReviewCompletion"]);
/**
 * Existing-PR takeover members that authorize or perform an effect. Its
 * discovery and proof reads pass through, and the capability stays present,
 * so the #326 step fingerprint (which records which capabilities exist)
 * equals the serial pass's. The native queue guard only inspects and proves
 * (it decides; it never performs an effect) and passes through unchanged.
 */
const TAKEOVER_EFFECTS = new Set<string>([
  "authorizeBoundary",
  "authorizeAdoption",
  "preserveNativeHead",
  "authorizeEffect",
]);

export class RepositoryPassFence {
  /** Effects attempted since the last `take()`. */
  private attempted = 0;
  /** Effects attempted over the whole pass. */
  total = 0;

  hit(): void {
    this.attempted++;
    this.total++;
  }

  /** True when the interval since the last call attempted an effect. */
  take(): boolean {
    const hit = this.attempted > 0;
    this.attempted = 0;
    return hit;
  }
}

function fenced(fence: RepositoryPassFence) {
  return () => {
    fence.hit();
    return Promise.resolve(portError("unavailable", FENCE_DETAIL));
  };
}

/** A read-through view of `target` whose `effects` members are fenced. */
function fenceMembers<T extends object>(
  target: T,
  effects: ReadonlySet<string>,
  fence: RepositoryPassFence,
): T {
  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property, object);
      if (typeof property === "string" && effects.has(property)) {
        return value === undefined ? undefined : fenced(fence);
      }
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}

function fenceGithub(github: GitHubPort, fence: RepositoryPassFence) {
  const takeover = github.existingPrTakeover === undefined
    ? undefined
    : fenceMembers(github.existingPrTakeover, TAKEOVER_EFFECTS, fence);
  return new Proxy(github, {
    get(target, property, _receiver) {
      if (typeof property === "string" && GITHUB_WITHHELD.has(property)) {
        return undefined;
      }
      if (property === "existingPrTakeover") return takeover;
      const value = Reflect.get(target, property, target);
      if (typeof property === "string" && GITHUB_EFFECTS.has(property)) {
        return value === undefined ? undefined : fenced(fence);
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
    has(target, property) {
      if (typeof property === "string" && GITHUB_WITHHELD.has(property)) {
        return false;
      }
      return Reflect.has(target, property);
    },
  });
}

/**
 * The step-loop dependencies of one repository pass: `state` is the private
 * fork, `configs` only the repository's own configuration, and every effect
 * capability is fenced. Reads (issues, pulls, checks, refs, the batched live
 * inputs, incidents, fixture identities) pass through unchanged.
 */
export function fencedRepositoryDeps(
  deps: RepairCycleDepsV1,
  state: RepairCycleDepsV1["state"],
  configs: RepairCycleDepsV1["configs"],
  fence: RepositoryPassFence,
): RepairCycleDepsV1 {
  const refuse = fenced(fence);
  return {
    ...deps,
    state,
    configs,
    github: fenceGithub(deps.github, fence),
    githubCooldown: {
      beforeRequest: (scope) => deps.githubCooldown.beforeRequest(scope),
      recordRateLimit: () => {
        fence.hit();
        return Promise.resolve(
          portError("rate_limited", "repository pass read was rate limited"),
        );
      },
    },
    model: {
      ...(deps.model.modelId === undefined
        ? {}
        : { modelId: deps.model.modelId }),
      runModel: refuse,
    },
    replay: { runReplay: refuse },
    budget: {
      reserveModelStart: () => {
        fence.hit();
        return Promise.resolve({ status: "disabled", detail: FENCE_DETAIL });
      },
      settleModelStart: () => {
        fence.hit();
        return Promise.resolve({ status: "unavailable", detail: FENCE_DETAIL });
      },
    },
    externalImplementations: true,
  };
}
