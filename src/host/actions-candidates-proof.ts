/** Hosted actions-candidates-proof responsibility. */
import type { GitSha } from "../contracts/brands.ts";
import type { GitHubCooldownGateV1, PortResultV1 } from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { CandidatePreservationV1 } from "../contracts/work-record.ts";
import { GitReviewSnapshot } from "../github/review-snapshot.ts";
import { exactCommitAt, pathPresent } from "./actions-candidates-objects.ts";
import type { PreserverGitRunV1 } from "./actions-candidates-objects.ts";
import {
  STATIC_PRESERVE_LOCAL,
  STATIC_PRESERVE_PROOF,
} from "./actions-candidates-shared.ts";

/**
 * One bounded fresh-store durability proof. A NEW empty bare object store is
 * created in owned private scratch; exactly the fixed remote and exact
 * operation ref are fetched with bounded credential-scoped Git; `FETCH_HEAD`
 * must equal the candidate head and the exact head/base commit objects and
 * ancestry must be present without shallow, replace or alternate masking. The
 * trusted excluded `publishedHead` is fetched only when it is genuinely
 * missing and its exact identity is then re-proved. Publication is revalidated
 * credential-free inside this store. The exact task-owned store is removed
 * after every child process has settled.
 */
export async function freshStoreProof(input: {
  runGit: PreserverGitRunV1;
  gate: GitHubCooldownGateV1;
  /** Exact installation scope every gate admission is charged to. */
  installationId: number;
  remoteUrl: string;
  ref: string;
  candidate: CandidatePreservationV1;
  publishedHead: GitSha | null;
  protectedPaths: readonly string[];
  sourcePath: string;
  restoreSource: boolean;
  trustedPath: string;
  gitExecutable: string;
  scratch: string;
}): Promise<PortResultV1<void>> {
  const {
    runGit,
    gate,
    installationId,
    remoteUrl,
    ref,
    candidate,
    publishedHead,
    protectedPaths,
    sourcePath,
    restoreSource,
    trustedPath,
    gitExecutable,
    scratch,
  } = input;
  let store: string;
  try {
    store = await Deno.makeTempDir({
      dir: scratch,
      prefix: "sentinel-candidate-store-",
    });
  } catch {
    return portError("unavailable", STATIC_PRESERVE_PROOF);
  }
  // True when any child run could not be proved settled, or when the
  // validator failed without proving the settlement of its own processes: the
  // exact task-owned store is then preserved for diagnosis instead of removed.
  let uncertain = false;
  /**
   * Bounded run for this proof. Null is an unusable result: a runtime throw or
   * an unproved settlement is recorded as uncertainty; a spawn failure or a
   * truncation is a settled dead end.
   */
  const run: PreserverGitRunV1 = async (cwd, args, credentials) => {
    const result = await runGit(cwd, args, credentials);
    if (result === null || !result.settled) {
      uncertain = true;
      return null;
    }
    if (!result.exited || result.truncated) return null;
    return result;
  };
  try {
    const init = await run(store, ["init", "--bare", "-q"], false);
    if (init === null || init.code !== 0) {
      return portError("unavailable", STATIC_PRESERVE_PROOF);
    }
    // Durable cooldown immediately before the one credential-scoped fetch.
    let cooled: PortResultV1<void>;
    try {
      cooled = await gate.beforeRequest(installationId);
    } catch {
      return portError("unavailable", STATIC_PRESERVE_PROOF);
    }
    if (!cooled.ok) return cooled;
    const fetched = await run(
      store,
      ["fetch", "--no-tags", remoteUrl, ref],
      true,
    );
    if (fetched === null || fetched.code !== 0) {
      return portError("unavailable", STATIC_PRESERVE_PROOF);
    }
    const fetchedHead = await run(
      store,
      ["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"],
      false,
    );
    if (
      fetchedHead === null || fetchedHead.code !== 0 ||
      fetchedHead.stdout.trim() !== candidate.head
    ) {
      return portError("unavailable", STATIC_PRESERVE_PROOF);
    }
    // No shallow, replace-object or alternate masking may hide a different
    // object graph.
    const shallow = await run(
      store,
      ["rev-parse", "--is-shallow-repository"],
      false,
    );
    if (
      shallow === null || shallow.code !== 0 ||
      shallow.stdout.trim() !== "false"
    ) {
      return portError("unavailable", STATIC_PRESERVE_PROOF);
    }
    const replaced = await run(
      store,
      ["for-each-ref", "--format=%(refname)", "refs/replace"],
      false,
    );
    if (
      replaced === null || replaced.code !== 0 ||
      replaced.stdout.trim() !== ""
    ) {
      return portError("unavailable", STATIC_PRESERVE_PROOF);
    }
    // An unreadable alternates path is unknown availability, never absence.
    const alternates = await pathPresent(`${store}/objects/info/alternates`);
    if (alternates === null || alternates) {
      return portError("unavailable", STATIC_PRESERVE_PROOF);
    }
    const basePresent = await exactCommitAt(run, store, candidate.base);
    if (basePresent === null || !basePresent) {
      return portError("unavailable", STATIC_PRESERVE_PROOF);
    }
    // The exact excluded published head is fetched only when the candidate
    // fetch did not already carry it, and its recorded identity is re-proved.
    if (publishedHead !== null) {
      const publishedPresent = await exactCommitAt(run, store, publishedHead);
      if (publishedPresent === null) {
        return portError("unavailable", STATIC_PRESERVE_PROOF);
      }
      if (!publishedPresent) {
        // The second authenticated fetch needs its OWN durable cooldown
        // immediately before it; a refused or throwing gate performs no fetch.
        let secondCooled: PortResultV1<void>;
        try {
          secondCooled = await gate.beforeRequest(installationId);
        } catch {
          return portError("unavailable", STATIC_PRESERVE_PROOF);
        }
        if (!secondCooled.ok) return secondCooled;
        const publishedFetch = await run(
          store,
          ["fetch", "--no-tags", remoteUrl, publishedHead],
          true,
        );
        if (publishedFetch === null || publishedFetch.code !== 0) {
          return portError("unavailable", STATIC_PRESERVE_PROOF);
        }
        const confirmed = await run(
          store,
          ["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"],
          false,
        );
        if (
          confirmed === null || confirmed.code !== 0 ||
          confirmed.stdout.trim() !== publishedHead
        ) {
          return portError("unavailable", STATIC_PRESERVE_PROOF);
        }
      }
    }
    const ancestry = await run(
      store,
      ["merge-base", "--is-ancestor", candidate.base, candidate.head],
      false,
    );
    if (ancestry === null || ancestry.code !== 0) {
      return portError("unavailable", STATIC_PRESERVE_PROOF);
    }
    let validated: PortResultV1<void>;
    if (restoreSource) {
      // A resumed source mirror may have none of these retained objects. Import
      // only the exact graph just proved above, including the excluded published
      // head, before validating the publication in that mirror. This local
      // fetch has no credential and cannot select a mutable remote/task ref or
      // a producer checkout.
      const imported = await run(sourcePath, [
        "fetch",
        "--no-tags",
        store,
        candidate.head,
        ...(publishedHead === null ? [] : [publishedHead]),
      ], false);
      if (imported === null || imported.code !== 0) {
        return portError("unavailable", STATIC_PRESERVE_LOCAL);
      }
      const sourceValidator = new GitReviewSnapshot({
        trustedPath,
        repositoryDir: sourcePath,
        gitExecutable,
      });
      // Its interface does not prove that the validator's own process group
      // settled, so uncertainty is raised BEFORE the call and cleared only by
      // a returned success; a thrown validation also keeps the owned store.
      uncertain = true;
      try {
        validated = await sourceValidator.validatePublication({
          base: candidate.base,
          head: candidate.head,
          publishedHead,
          protectedPaths,
        });
      } catch {
        return portError("unavailable", STATIC_PRESERVE_LOCAL);
      }
      if (!validated.ok) return validated;
      uncertain = false;
    }
    // Credential-free revalidation inside the freshly fetched exact objects.
    const freshValidator = new GitReviewSnapshot({
      trustedPath,
      repositoryDir: store,
      gitExecutable,
    });
    // Its interface does not prove that the validator's own process group
    // settled, so uncertainty is raised BEFORE the call and cleared only by a
    // returned success; a thrown validation also keeps the owned store.
    uncertain = true;
    try {
      validated = await freshValidator.validatePublication({
        base: candidate.base,
        head: candidate.head,
        publishedHead,
        protectedPaths,
      });
    } catch {
      return portError("unavailable", STATIC_PRESERVE_PROOF);
    }
    if (!validated.ok) return validated;
    uncertain = false;
    return portOk(undefined);
  } finally {
    // Clean only the exact task-owned store after every child run settled;
    // an unproved settlement keeps the owned scratch intact.
    if (!uncertain) {
      await Deno.remove(store, { recursive: true }).catch(() => {});
    }
  }
}
