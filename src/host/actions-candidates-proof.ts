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

/** Pass-store refs naming every head a proof in that store fully proved. */
const PROVED_TIP_NAMESPACE = "refs/sentinel-proved/";

/** How one proof hands its pass store back. */
export type ProofStoreOutcomeV1 = "reusable" | "discard" | "uncertain";

export interface ProofStoreLeaseV1 {
  /** The pass's initialized store, or null when this proof creates it. */
  readonly store: string | null;
  settle(store: string | null, outcome: ProofStoreOutcomeV1): Promise<void>;
}

/**
 * One maintenance pass's amortized fresh-store proofs (#185). Instead of a new
 * store per candidate, the first proof of the pass for one fixed remote (one
 * target) creates ONE new empty bare store in owned private scratch and pays
 * the full-history fetch; every later proof of the SAME pass for that remote
 * fetches its exact operation ref into that store, so only objects the store
 * lacks are transferred, and repeats every per-candidate check there:
 * `FETCH_HEAD`, no shallow, replace or alternate masking, exact head/base and
 * published-head commits, ancestry and credential-free publication. The store
 * only ever receives objects from that fixed remote, and only a fully proved
 * head is recorded (as a private negotiation ref) for reuse. Any failed proof
 * ends the store's reuse exactly as it ends a one-off store (removed when
 * every child settled; kept on disk for diagnosis after an unproved settlement
 * or a validator refusal), and the next proof starts over in a NEW empty
 * store. The owning pass creates this object and must `close()` it when it
 * ends, which removes every kept store: a store is never shared across passes
 * or runs. Each remote and scratch root has its own pass store; a closed pass
 * or a concurrent proof gets the one-off store.
 */
export class CandidateProofPassV1 {
  readonly #stores = new Map<string, { store: string | null; busy: boolean }>();
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  /** Lease this pass's store for one remote, or null for a one-off store. */
  lease(remoteUrl: string, scratch: string): ProofStoreLeaseV1 | null {
    if (this.#closed) return null;
    const key = JSON.stringify([remoteUrl, scratch]);
    let entry = this.#stores.get(key);
    if (entry === undefined) {
      entry = { store: null, busy: false };
      this.#stores.set(key, entry);
    }
    if (entry.busy) return null;
    entry.busy = true;
    const held = entry;
    let settled = false;
    return {
      store: held.store,
      settle: async (store, outcome) => {
        if (settled) return;
        settled = true;
        held.busy = false;
        if (outcome === "reusable" && !this.#closed && store !== null) {
          held.store = store;
          return;
        }
        held.store = null;
        // An unsettled child keeps the exact store on disk, never reused.
        if (outcome !== "uncertain" && store !== null) {
          await Deno.remove(store, { recursive: true }).catch(() => {});
        }
      },
    };
  }

  /** End the pass: remove every kept store; later proofs are one-off. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const entry of this.#stores.values()) {
      const store = entry.store;
      entry.store = null;
      // A busy lease settles after close and then removes its own store.
      if (store === null || entry.busy) continue;
      await Deno.remove(store, { recursive: true }).catch(() => {});
    }
  }
}

/**
 * One bounded fresh-store durability proof. A NEW empty bare object store is
 * created in owned private scratch; exactly the fixed remote and exact
 * operation ref are fetched with bounded credential-scoped Git; `FETCH_HEAD`
 * must equal the candidate head and the exact head/base commit objects and
 * ancestry must be present without shallow, replace or alternate masking. The
 * trusted excluded `publishedHead` is fetched only when it is genuinely
 * missing and its exact identity is then re-proved. Publication is revalidated
 * credential-free inside this store. The exact task-owned store is removed
 * after every child process has settled. With a `pass`, the store is that
 * pass's one store for this remote (see `CandidateProofPassV1`).
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
  /** The owning maintenance pass whose one store this proof uses (#185). */
  pass?: CandidateProofPassV1;
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
  const lease = input.pass?.lease(remoteUrl, scratch) ?? null;
  const reused = lease?.store ?? null;
  // A pass store accumulates one pack per fetch: automatic maintenance, which
  // may detach a gc outside the owned process group, never runs in it.
  const fetchFlags = lease === null
    ? ["--no-tags"]
    : ["--no-tags", "--no-auto-gc"];
  let store: string;
  if (reused !== null) {
    store = reused;
  } else {
    try {
      store = await Deno.makeTempDir({
        dir: scratch,
        prefix: "sentinel-candidate-store-",
      });
    } catch {
      await lease?.settle(null, "discard");
      return portError("unavailable", STATIC_PRESERVE_PROOF);
    }
  }
  // True when any child run could not be proved settled, or when the
  // validator failed without proving the settlement of its own processes: the
  // exact task-owned store is then preserved for diagnosis instead of removed.
  let uncertain = false;
  // True only once a pass store recorded this fully proved head for reuse.
  let reusable = false;
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
    // A reused pass store was created and initialized by an earlier proof of
    // the same pass and holds only that pass's fully proved remote objects.
    if (reused === null) {
      const init = await run(store, ["init", "--bare", "-q"], false);
      if (init === null || init.code !== 0) {
        return portError("unavailable", STATIC_PRESERVE_PROOF);
      }
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
      ["fetch", ...fetchFlags, remoteUrl, ref],
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
          ["fetch", ...fetchFlags, remoteUrl, publishedHead],
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
    if (lease !== null) {
      // The fully proved head becomes a negotiation tip of the pass store, so
      // a later fetch of this pass transfers only objects it does not reach.
      // A failed record only ends the store's reuse; the proof stands.
      const tip = await run(store, [
        "update-ref",
        `${PROVED_TIP_NAMESPACE}${candidate.head}`,
        candidate.head,
      ], false);
      reusable = tip !== null && tip.code === 0;
    }
    return portOk(undefined);
  } finally {
    // Clean only the exact task-owned store after every child run settled;
    // an unproved settlement keeps the owned scratch intact. A pass store
    // stays for the pass's next proof only after a full success.
    if (lease !== null) {
      await lease.settle(
        store,
        uncertain ? "uncertain" : reusable ? "reusable" : "discard",
      );
    } else if (!uncertain) {
      await Deno.remove(store, { recursive: true }).catch(() => {});
    }
  }
}
