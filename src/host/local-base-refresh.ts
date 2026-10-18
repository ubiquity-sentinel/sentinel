import {
  isNativeQueueTarget,
  type NativeQueueGuardV1,
} from "../github/native-queue-guard.ts";
import type { Clock } from "../contracts/ports.ts";
import type {
  ExistingPrTakeoverPort,
  TakeoverEffectAuthorization,
} from "../contracts/existing-pr-takeover.ts";
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import {
  type GitHubPullRequestV1,
  type GitHubRefV1,
  portError,
  type PortResultV1,
  type PrepareBaseRefreshRequestV1,
} from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { MaxText } from "../contracts/validation.ts";
import type { GitExecutorV1 } from "../github/git-executor.ts";
import { LOCAL_REPOSITORY } from "./local-policy.ts";

// ---------------------------------------------------------------------------
// Deterministic candidate-base refresh adapter (optional port capability)
// ---------------------------------------------------------------------------

/** Narrow read-only observation the base-refresh adapter needs from the port. */
export interface BaseRefreshObserverV1 {
  readonly nativeQueue?: NativeQueueGuardV1;
  readonly existingPrTakeover?: ExistingPrTakeoverPort;
  readPullRequest(
    number: number,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>>;
  readRef(ref: string): Promise<PortResultV1<GitHubRefV1 | null>>;
}

export interface PrepareBaseRefreshAdapterInputV1 {
  clock?: Clock;
  /** THE same trusted executor instance the port publishes through. */
  git: GitExecutorV1;
  /**
   * Exact repository this adapter restores candidate objects for. Omitted
   * callers keep the frozen sentinel self-identity, so every existing call
   * site is unchanged.
   */
  repository?: RepositoryIdentityV1;
  /** The exact port instance (or any exact observer over it). */
  observer: BaseRefreshObserverV1;
  /** Exact configured base branch the PR must target. */
  baseBranch: string;
  /** Trusted PR author login for this scope. */
  trustedPrAuthor: string;
  /**
   * Existing hosted exact-object restore capability. The local host omits it
   * because its persistent private source repository already owns the
   * candidate objects.
   */
  ensureCandidateObjects?: (
    input: {
      base: GitSha;
      head: GitSha;
      /**
       * Exact repository the objects belong to. A multi-target host owns one
       * source mirror and one authenticated remote per target, and the objects
       * of a foreign target exist only in that target's mirror and remote.
       */
      repository: RepositoryIdentityV1;
    },
  ) => Promise<PortResultV1<void>>;
  /**
   * Existing trusted gated fetch of the target's own configured base branch.
   *
   * Deterministic integration runs entirely in the local object store, so the
   * freshly observed `expectedBase` must exist locally before it is invoked.
   * On the UNPREPARED path only, the adapter calls this capability with that
   * exact base and requires the SAME target's authenticated remote and
   * configured base branch to deliver it through the shared cooldown gate.
   * The composed implementation fixes the repository, remote and branch: a
   * mismatched repository, a failed fetch or a fetched branch head that is not
   * the exact requested base fails closed and is never integrated. The
   * prepared recovery path never calls it, so the frozen observed base and the
   * byte-identical regeneration check stay unchanged. Omitted callers keep
   * today's local-object-only behavior.
   */
  ensureBaseObjects?: (
    input: {
      base: GitSha;
      /**
       * Exact repository the base belongs to. The composed capability fetches
       * only from THIS port's own validated repository identity.
       */
      repository: RepositoryIdentityV1;
    },
  ) => Promise<PortResultV1<void>>;
}

export type PrepareBaseRefreshV1 = (
  request: PrepareBaseRefreshRequestV1,
  takeover?: TakeoverEffectAuthorization,
) => Promise<PortResultV1<GitSha>>;

const STATIC_BASE_REFRESH_INPUT = "base refresh request is invalid";

const STATIC_BASE_REFRESH_PR =
  "base refresh requires the exact open trusted-author PR";

const STATIC_BASE_REFRESH_AUTHOR = "base refresh PR author is not trusted";

const STATIC_BASE_REFRESH_HEAD_REF = "base refresh head branch is not exact";

const STATIC_BASE_REFRESH_BASE_REF = "base refresh base branch is not exact";

const STATIC_BASE_REFRESH_HEAD = "base refresh PR head is not exact";

export const STATIC_BASE_REFRESH_BASE_MOVED =
  "base refresh configured base moved";

const STATIC_BASE_REFRESH_RESTORE =
  "base refresh candidate objects are unavailable";

const STATIC_BASE_REFRESH_UNSUPPORTED =
  "base refresh local integration is unavailable";

const STATIC_BASE_REFRESH_PREPARED = "base refresh prepared identity mismatch";

export const STATIC_BASE_REFRESH_BASE_OBJECTS =
  "base refresh target base objects are unavailable";

export const STATIC_BASE_REFRESH_BASE_REPOSITORY =
  "base refresh base repository is not exact";

/**
 * Trusted deterministic candidate-base generation over ONE executor instance.
 *
 * Every identity is re-observed immediately before generation: the PR must be
 * open, authored by the trusted login, carry the exact head branch and target
 * the exact configured base branch, the PR head must be the exact old
 * candidate (or, on recovery only, the exact persisted prepared commit), and
 * the current configured base ref must equal `expectedBase`. The old candidate
 * parents are ensured through the SAME restore capability the port uses before
 * the local integration runs. Nothing is merged or published here; a wrong,
 * foreign or moved identity fails closed with a bounded static error.
 */
export function createPrepareBaseRefresh(
  input: PrepareBaseRefreshAdapterInputV1,
): PrepareBaseRefreshV1 {
  const baseBranch = input.baseBranch;
  const trustedPrAuthor = input.trustedPrAuthor;
  return async (request, takeover) => {
    if (
      request === null || typeof request !== "object" ||
      !Number.isSafeInteger(request.pullRequestNumber) ||
      request.pullRequestNumber <= 0 ||
      typeof request.branch !== "string" ||
      request.branch.length === 0 ||
      request.branch.length > MaxText.branch ||
      !isGitSha(request.expectedHead) ||
      !isGitSha(request.previousBase) ||
      !isGitSha(request.expectedBase) ||
      (request.preparedHead !== undefined && !isGitSha(request.preparedHead))
    ) {
      return portError("invalid", STATIC_BASE_REFRESH_INPUT);
    }
    const queueCheck = async (): Promise<PortResultV1<void>> => {
      if (!isNativeQueueTarget(input.repository ?? LOCAL_REPOSITORY)) {
        return { ok: true, value: undefined };
      }
      const guard = input.observer.nativeQueue;
      if (guard === undefined) {
        return portError(
          "unavailable",
          "native queue custody capability missing",
        );
      }
      const result = await guard.inspectEffect({
        operation: "refresh",
        pullRequest: request.pullRequestNumber,
        branch: request.branch,
        expectedHead: request.expectedHead,
        deadline: (input.clock?.now() ?? Date.now()) + 30_000,
      });
      return result.status === "allow"
        ? { ok: true, value: undefined }
        : portError(
          "unavailable",
          `native queue custody hold: ${result.reason}`,
        );
    };
    const queued = await queueCheck();
    if (!queued.ok) return queued;
    const observed = await input.observer.readPullRequest(
      request.pullRequestNumber,
    );
    if (!observed.ok) return observed;
    if (observed.value === null) {
      return portError("not_found", STATIC_BASE_REFRESH_PR);
    }
    const pull = observed.value;
    if (pull.state !== "open") {
      return portError("conflict", STATIC_BASE_REFRESH_PR);
    }
    if (pull.author !== trustedPrAuthor && takeover === undefined) {
      return portError("conflict", STATIC_BASE_REFRESH_AUTHOR);
    }
    if (pull.headRef !== request.branch) {
      return portError("conflict", STATIC_BASE_REFRESH_HEAD_REF);
    }
    if (pull.baseRef !== baseBranch) {
      return portError("conflict", STATIC_BASE_REFRESH_BASE_REF);
    }
    // The head must be the exact old candidate, or on recovery exactly the
    // already persisted prepared commit. Nothing else is ever adopted.
    if (
      pull.head !== request.expectedHead &&
      pull.head !== request.preparedHead
    ) {
      return portError("conflict", STATIC_BASE_REFRESH_HEAD);
    }
    const base = await input.observer.readRef(`refs/heads/${baseBranch}`);
    if (!base.ok) return base;
    if (base.value === null) {
      return portError("conflict", STATIC_BASE_REFRESH_BASE_MOVED);
    }
    // An UNPREPARED refresh requires the exact current base. A prepared
    // recovery (exact preparedHead supplied) publishes the already frozen
    // deterministic candidate even if the configured base has since advanced:
    // the regeneration below still has to equal the saved prepared commit, and
    // the saved observed base is never rewritten. This is publication of an
    // existing candidate, not merge approval.
    if (
      base.value.sha !== request.expectedBase &&
      request.preparedHead === undefined
    ) {
      return portError("conflict", STATIC_BASE_REFRESH_BASE_MOVED);
    }
    if (input.ensureCandidateObjects !== undefined) {
      let ensured: PortResultV1<void>;
      try {
        ensured = await input.ensureCandidateObjects({
          base: request.previousBase,
          head: request.expectedHead,
          repository: input.repository ?? LOCAL_REPOSITORY,
        });
      } catch {
        return portError("unavailable", STATIC_BASE_REFRESH_RESTORE);
      }
      if (!ensured.ok) return ensured;
    }
    // The freshly observed base is brought into THIS target's object store
    // from its own authenticated remote and configured base branch before the
    // deterministic integration runs. Only an unprepared refresh fetches: a
    // prepared recovery regenerates from the already frozen observed base and
    // must never observe a later branch movement.
    if (
      input.ensureBaseObjects !== undefined &&
      request.preparedHead === undefined
    ) {
      let ensuredBase: PortResultV1<void>;
      try {
        ensuredBase = await input.ensureBaseObjects({
          base: request.expectedBase,
          repository: input.repository ?? LOCAL_REPOSITORY,
        });
      } catch {
        return portError("unavailable", STATIC_BASE_REFRESH_BASE_OBJECTS);
      }
      if (!ensuredBase.ok) return ensuredBase;
    }
    const integrateBase = input.git.integrateBase?.bind(input.git);
    if (integrateBase === undefined) {
      return portError("unavailable", STATIC_BASE_REFRESH_UNSUPPORTED);
    }
    const beforeIntegrate = await queueCheck();
    if (!beforeIntegrate.ok) return beforeIntegrate;
    // This proof is issued and consumed by the same host port. A caller object
    // or a foreign original PR author never substitutes for App authority.
    const custody = input.observer.existingPrTakeover;
    if (custody !== undefined) {
      const allowed = await custody.authorizeBoundary({
        kind: "refresh",
        request,
      }, takeover);
      if (!allowed.ok) return allowed;
    } else if (takeover !== undefined) {
      return portError(
        "unavailable",
        "existing PR refresh custody unavailable",
      );
    }
    const integrated = await integrateBase(
      request.expectedHead,
      request.expectedBase,
    );
    if (!integrated.ok) return integrated;
    // The regenerated deterministic commit is byte-identical to the persisted
    // recovery identity or the request is refused: an unrelated head can never
    // be adopted through this capability.
    if (
      request.preparedHead !== undefined &&
      integrated.value !== request.preparedHead
    ) {
      return portError("invalid", STATIC_BASE_REFRESH_PREPARED);
    }
    const afterIntegrate = await queueCheck();
    if (!afterIntegrate.ok) return afterIntegrate;
    return integrated;
  };
}
