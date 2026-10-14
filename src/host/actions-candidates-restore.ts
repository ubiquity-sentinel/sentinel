/** Hosted actions-candidates-restore responsibility. */
import { isGitSha } from "../contracts/brands.ts";
import type { GitSha } from "../contracts/brands.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { GitHubApiClient } from "../github/client.ts";
import {
  baseRefreshIntentKey,
  candidatePreservationRef,
} from "../repair/keys.ts";
import { DenoReplayRuntime } from "../replay/runtime.ts";
import { githubGitAuthEnv } from "./local.ts";
import {
  GIT_MAX_OUTPUT_BYTES,
  GIT_TIMEOUT_MS,
  isDurableCandidateBranch,
  isPreservationRef,
  sameRepository,
  SELF_REPOSITORY,
  STATIC_BINDING,
  STATIC_FETCH,
  STATIC_INPUT,
  STATIC_REMOTE,
} from "./actions-candidates-shared.ts";
import type {
  ActionsCandidateRestoreRequestV1,
  ActionsCandidateRestorerInputV1,
  ActionsCandidateRestorerV1,
} from "./actions-candidates-shared.ts";

/**
 * Exact persisted base-refresh recovery binding.
 *
 * After the prepared result was persisted, the push may or may not have
 * happened: the durable record still points at the OLD candidate while its
 * intent carries the exact deterministic `resultId` (the remote ref then
 * carries either the old candidate or that exact prepared commit). This
 * helper returns that exact commit ONLY when every old binding still matches
 * (branch, PR, expected head, non-null observed base and no request id), so a
 * remote head is accepted solely for that one exact persisted operation. The
 * durable record is never altered here, and the base-refresh adapter separately
 * recomputes the deterministic commit and requires equality with the persisted
 * result, so an unrelated head is never adopted.
 */
function baseRefreshRestoreTarget(record: WorkRecordV1): GitSha | null {
  const intent = record.intent;
  if (intent === null || intent.kind !== "base_refresh") return null;
  if (intent.resultId === null || !isGitSha(intent.resultId)) return null;
  if (intent.requestId !== null) return null;
  if (intent.branch === null || intent.pr === null) return null;
  if (record.target.branch === null || record.target.pr === null) return null;
  if (intent.branch !== record.target.branch) return null;
  if (intent.pr !== record.target.pr) return null;
  if (intent.expectedHead !== record.target.head) return null;
  if (intent.observedBase === null) return null;
  return intent.resultId;
}

/** One exact restore destination plus the SHA(s) it may legitimately carry. */
interface RestoreTargetV1 {
  ref: string;
  accepted: GitSha[];
}

/**
 * Recompute the exact operation/task/ref binding for one request pair.
 *
 * A record WITHOUT candidate state keeps the legacy task-branch restoration
 * (including the exact persisted base-refresh prepared commit). A record WITH
 * candidate state is restored ONLY through its operation-bound refs: the
 * retained original descriptor, a pending `candidate_preservation` intent ref
 * or a persisted `base_refresh` result ref. A missing/mismatched descriptor or
 * intent yields no target, so the caller can never fall back to a different
 * mutable PR/task head.
 */
async function restorableTargets(
  record: WorkRecordV1,
  base: GitSha,
  head: GitSha,
): Promise<RestoreTargetV1[]> {
  const candidateState = record.target.candidateState;
  const intent = record.intent;
  const newShape = candidateState !== undefined ||
    (intent !== null && intent.kind === "candidate_preservation");
  if (!newShape) {
    if (record.target.base !== base || record.target.head !== head) return [];
    if (!isDurableCandidateBranch(record.target.branch)) return [];
    const ref = `refs/heads/${record.target.branch}`;
    const accepted: GitSha[] = [head];
    const prepared = baseRefreshRestoreTarget(record);
    if (prepared !== null && prepared !== head) accepted.push(prepared);
    return [{ ref, accepted }];
  }
  const targets: RestoreTargetV1[] = [];
  const preserved = candidateState?.preserved ?? null;
  if (preserved !== null) {
    const expectedRef = await candidatePreservationRef(
      record.repository,
      record.id,
      preserved.operationKey,
    );
    if (
      expectedRef === preserved.ref && preserved.base === base &&
      preserved.head === head
    ) {
      targets.push({ ref: preserved.ref, accepted: [preserved.head] });
    }
  }
  if (intent !== null && intent.kind === "candidate_preservation") {
    if (
      isPreservationRef(intent.branch) && intent.expectedHead === head &&
      intent.observedBase === base
    ) {
      const expectedRef = await candidatePreservationRef(
        record.repository,
        record.id,
        intent.key,
      );
      if (expectedRef === intent.branch) {
        targets.push({ ref: intent.branch, accepted: [head] });
      }
    }
  }
  if (intent !== null && intent.kind === "base_refresh") {
    // The new-format shape must carry the SAME full binding the preserver
    // revalidates: exact PR/branch/old-head target, no request id, the
    // deterministic refresh key and the retained original descriptor whose
    // derived ref is the only accepted remote identity.
    const resultId = intent.resultId;
    const observedBase = intent.observedBase;
    const preserved = candidateState?.preserved ?? null;
    if (
      resultId !== null && isGitSha(resultId) &&
      observedBase !== null && observedBase === base && resultId === head &&
      intent.requestId === null &&
      intent.pr !== null && intent.branch !== null &&
      intent.pr === record.target.pr &&
      intent.branch === record.target.branch &&
      intent.expectedHead !== null &&
      intent.expectedHead === record.target.head &&
      intent.key ===
        baseRefreshIntentKey(intent.pr, intent.expectedHead, observedBase) &&
      preserved !== null && preserved.base === record.target.base &&
      preserved.head === record.target.head
    ) {
      const preservedRef = await candidatePreservationRef(
        record.repository,
        record.id,
        preserved.operationKey,
      );
      const ref = await candidatePreservationRef(
        record.repository,
        record.id,
        intent.key,
      );
      if (preservedRef === preserved.ref && isPreservationRef(ref)) {
        targets.push({ ref, accepted: [resultId] });
      }
    }
  }
  return targets;
}

export function createActionsCandidateRestorer(
  input: ActionsCandidateRestorerInputV1,
): ActionsCandidateRestorerV1 {
  const repository = input.repository ?? SELF_REPOSITORY;
  const remoteUrl = input.remoteUrl ??
    `https://github.com/${repository.owner}/${repository.name}.git`;
  const runtime = input.runtime ?? new DenoReplayRuntime(input.trustedPath);
  const auth = {
    authorizationHeader: () => Promise.resolve(portOk(`Bearer ${input.token}`)),
  };
  let client: GitHubApiClient | null = null;
  const github = (): GitHubApiClient => {
    client ??= new GitHubApiClient({
      repository: { ...repository },
      apiBaseUrl: input.apiBaseUrl ?? "https://api.github.com",
      http: input.http,
      auth,
      cooldownGate: input.gate,
      clock: input.clock,
    });
    return client;
  };

  const runGit = async (
    args: string[],
  ): Promise<{ code: number; stdout: string } | null> => {
    let result;
    try {
      result = await runtime.run({
        executable: input.gitExecutable,
        args: ["-c", "core.hooksPath=/dev/null", ...args],
        cwd: input.sourcePath,
        env: {
          PATH: input.trustedPath,
          HOME: input.scratch,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          ...githubGitAuthEnv(input.token, remoteUrl),
        },
        maxDurationMs: GIT_TIMEOUT_MS,
        maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
      });
    } catch {
      return null;
    }
    // Only a normal, fully settled, untruncated exit yields a usable result.
    if (result.outcome !== "exited" || !result.settled || result.truncated) {
      return null;
    }
    return {
      code: result.exitCode ?? 1,
      stdout: new TextDecoder().decode(result.stdout),
    };
  };

  const hasCommit = async (sha: GitSha): Promise<boolean> => {
    const read = await runGit([
      "rev-parse",
      "--verify",
      "--quiet",
      `${sha}^{commit}`,
    ]);
    return read !== null && read.code === 0 && read.stdout.trim() === sha;
  };

  return {
    async ensure(value: ActionsCandidateRestoreRequestV1) {
      const base = value?.base;
      const head = value?.head;
      if (!isGitSha(base) || !isGitSha(head)) {
        return portError("invalid", STATIC_INPUT);
      }
      // Already available local immutable objects: no network, state or model.
      if (await hasCommit(base) && await hasCommit(head)) {
        return portOk(undefined);
      }
      // The exact durable nonterminal self binding; missing/ambiguous refuses.
      const targets: RestoreTargetV1[] = [];
      try {
        const read = await input.state.readRepair();
        if (!read.ok || read.value.status !== "found") {
          return portError("unavailable", STATIC_BINDING);
        }
        for (const work of read.value.snapshot.work) {
          if (
            !sameRepository(work.repository, repository) ||
            work.nextStep === "done"
          ) {
            continue;
          }
          targets.push(...await restorableTargets(work, base, head));
        }
      } catch {
        return portError("unavailable", STATIC_BINDING);
      }
      if (targets.length !== 1) {
        return portError("unavailable", STATIC_BINDING);
      }
      const target = targets[0]!;
      // Authenticated exact remote identity through the SAME client/gate path.
      // The remote is observed ONCE and the accepted identity is selected from
      // that observation: the exact operation-bound head, or — only for the
      // exact validated legacy base_refresh binding — the exact persisted
      // prepared result. Every other head refuses.
      const before = await github().readRef(target.ref);
      if (!before.ok) return before;
      if (before.value === null) {
        return portError("unavailable", STATIC_REMOTE);
      }
      if (!target.accepted.includes(before.value.sha)) {
        return portError("conflict", STATIC_REMOTE);
      }
      const restoreTarget = before.value.sha;
      // Durable cooldown immediately before the one authenticated fetch.
      let cooled: PortResultV1<void>;
      try {
        cooled = await input.gate.beforeRequest(repository.installationId);
      } catch {
        return portError("unavailable", STATIC_FETCH);
      }
      if (!cooled.ok) return portError("unavailable", STATIC_FETCH);
      // At most one exact fetch of the fixed remote and exact durable ref.
      const fetched = await runGit([
        "fetch",
        "--no-tags",
        remoteUrl,
        target.ref,
      ]);
      if (fetched === null || fetched.code !== 0) {
        return portError("unavailable", STATIC_FETCH);
      }
      const fetchedHead = await runGit([
        "rev-parse",
        "--verify",
        "--quiet",
        "FETCH_HEAD^{commit}",
      ]);
      if (
        fetchedHead === null || fetchedHead.code !== 0 ||
        fetchedHead.stdout.trim() !== restoreTarget
      ) {
        return portError("unavailable", STATIC_FETCH);
      }
      // The requested candidate/base objects must exist after the exact fetch
      // (a prepared refresh commit contains both the old head and the new base).
      if (!(await hasCommit(base)) || !(await hasCommit(head))) {
        return portError("unavailable", STATIC_FETCH);
      }
      // Re-read the authenticated remote after the fetch: drift refuses.
      const after = await github().readRef(target.ref);
      if (
        !after.ok || after.value === null ||
        after.value.sha !== restoreTarget
      ) {
        return portError("unavailable", STATIC_REMOTE);
      }
      return portOk(undefined);
    },
  };
}
