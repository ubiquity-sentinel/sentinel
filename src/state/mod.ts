import { canonicalStringify } from "../contracts/canonical.ts";
import type {
  PortErrorV1,
  PortResultV1,
  ReleaseStateWriter,
  RepairStateWriter,
  StateReadResultV1,
  StateReadView,
  StateStore,
  StateWriteResultV1,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../contracts/state-snapshots.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../contracts/state-snapshots.ts";
import type { GitSha } from "../contracts/brands.ts";
import {
  randomHex,
  RELEASE_REF,
  REPAIR_REF,
  StateGitTransport,
  StatePushError,
} from "./state-git.ts";
import type { GitStateStoreOptions, OpContext } from "./state-git.ts";
import { MANIFEST_KIND } from "./state-records.ts";
import type { StateKind, StateManifestV1 } from "./state-records.ts";
import { recordFiles } from "./state-codec.ts";
import { validateSnapshotTransition } from "./state-transition.ts";
import { RepairHistoryCache } from "./state-repair-history-cache.ts";

/**
 * GitStateStore: the production state-storage implementation for the two
 * fixed Sentinel state branches.
 *
 * State lives on `refs/heads/sentinel-state/repair` and
 * `refs/heads/sentinel-state/release` in a remote repository. The store never
 * touches the canonical or target checkout: every operation runs in a private
 * temporary workdir under the explicitly provided scratch directory (no
 * shared index/FETCH_HEAD/lock state, so concurrent uses cannot race on
 * scratch files), and every push is an ordinary non-force push.
 *
 * Structure of each state commit:
 *
 *   manifest.json                version/kind/sequence/updatedAt/stateHead
 *   <collection>/<sha256(id)>.json   one validated canonical JSON record per
 *                                    file, one collection per record kind
 *
 * Reads validate the full record tree (exact keys/schema, unique ids, digest
 * filenames) and verify the manifest `stateHead` equals the actual commit
 * parent. Writes are strict expected-head CAS: the expected remote head must
 * match before a candidate commit is formed with that exact parent; a ref
 * mismatch is a conflict (never an overwrite), and no force/force-with-lease
 * is ever used. Pushes carry a unique trusted write nonce in the commit
 * message so two identical concurrent candidates never produce identical
 * commits and both report success; the losing caller gets a conflict and
 * rereads. A failed push is reconciled against the authoritative ref before
 * any result is reported, so a lost response preserves the ambiguous outcome.
 *
 * The transport is injected (default: real `git` via Deno.Command with
 * clearEnv and no credential-capable config); tests inject wrappers around
 * the same transport, never alternate state logic.
 */

export class GitStateStore extends StateGitTransport implements StateStore {
  private readonly repairHistory = new RepairHistoryCache(this.scratchDir);
  private readonly latestRepair = new RepairHistoryCache(this.scratchDir);
  // -------------------------------------------------------------------------
  // Reads: both roles read both fixed refs.
  // -------------------------------------------------------------------------

  async readRepair(): Promise<
    PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>
  > {
    // Retention inspects its owned directory. A constrained caller that only
    // permits Git subprocess reads keeps the original nonretained path.
    if (
      (await Deno.permissions.query({ name: "read", path: this.scratchDir }))
        .state !== "granted"
    ) {
      return this.withOpDir<StateReadResultV1<RepairStateSnapshotV1>>(
        async (op) => {
          const loaded = await this.loadRemote(op, REPAIR_REF, "repair");
          if (!loaded.ok) return loaded;
          return loaded.value.status === "absent"
            ? portOk({ status: "absent", currentHead: null, ref: REPAIR_REF })
            : portOk({
              status: "found",
              head: loaded.value.head,
              snapshot: loaded.value.snapshot as RepairStateSnapshotV1,
              ref: REPAIR_REF,
            });
        },
      );
    }
    // Every observation stays fresh, but discovery and validation share one
    // serialized prepared cwd instead of acquiring an outside temporary one.
    const result = await this.latestRepair.useLatest<
      StateReadResultV1<RepairStateSnapshotV1>
    >(
      (op) => this.prepareRemote(op),
      async (op) => {
        const observed = await this.observeRemote(op, REPAIR_REF);
        if (!observed.ok) return observed;
        return portOk(
          observed.value.status === "found" ? observed.value.head : null,
        );
      },
      async (op, observedHead, cold) => {
        const head = observedHead as GitSha;
        let snapshot: RepairStateSnapshotV1;
        if (cold) {
          const loaded = await this.fetchRemote(
            op,
            REPAIR_REF,
            "repair",
            "latest",
            head,
          );
          if (!loaded.ok) return loaded;
          if (loaded.value.status !== "found") {
            return portError("unavailable", "repair state changed during read");
          }
          snapshot = loaded.value.snapshot as RepairStateSnapshotV1;
        } else {
          // Fresh parent/tree/blob bytes still validate every retained object;
          // StateTreeMemo only reuses parsing after complete byte equality.
          const read = await this.readCommitTree(op, head, "repair");
          if (!read.ok) return read;
          snapshot = read.value as RepairStateSnapshotV1;
        }
        return portOk({
          status: "found",
          snapshot: structuredClone(snapshot),
          head,
          ref: REPAIR_REF,
        });
      },
    );
    if (!result.ok) return result;
    return result.value === null
      ? portOk({ status: "absent", currentHead: null, ref: REPAIR_REF })
      : portOk(result.value);
  }

  readRelease(): Promise<
    PortResultV1<StateReadResultV1<ReleaseStateSnapshotV1>>
  > {
    return this.withOpDir<StateReadResultV1<ReleaseStateSnapshotV1>>(
      async (op) => {
        const loaded = await this.loadRemote(op, RELEASE_REF, "release");
        if (!loaded.ok) return loaded;
        if (loaded.value.status === "absent") {
          return portOk({
            status: "absent",
            currentHead: null,
            ref: RELEASE_REF,
          });
        }
        return portOk({
          status: "found",
          snapshot: loaded.value.snapshot as ReleaseStateSnapshotV1,
          head: loaded.value.head,
          ref: RELEASE_REF,
        });
      },
    );
  }

  readRepairAt(input: { commit: GitSha; expectedHead: GitSha }): Promise<
    PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>
  > {
    if (
      !/^[0-9a-f]{40}$/.test(input.commit) ||
      !/^[0-9a-f]{40}$/.test(input.expectedHead)
    ) {
      return Promise.resolve(
        portError("invalid", "historical repair identity is malformed"),
      );
    }
    return this.repairHistory.use(input.expectedHead, async (op) => {
      const loaded = await this.loadRemote(
        op,
        REPAIR_REF,
        "repair",
        "complete",
        input.expectedHead,
      );
      if (!loaded.ok) return loaded;
      if (
        loaded.value.status !== "found" ||
        loaded.value.head !== input.expectedHead
      ) {
        return portError(
          "conflict",
          "historical repair head changed or is absent",
        );
      }
      return loaded;
    }, async (op, cold) => {
      if (!cold) {
        const lookup = await this.git(op, ["ls-remote", "origin", REPAIR_REF]);
        if (!lookup.ok) {
          return this.gitFailure(
            this.classifyGitError(lookup),
            "ls-remote",
            lookup,
          );
        }
        const current = this.parseLsRemote(lookup.stdout, REPAIR_REF);
        if (current.status !== "found" || current.head !== input.expectedHead) {
          return portError(
            "conflict",
            "historical repair head changed or is absent",
          );
        }
      }
      // The private fetched objects are immutable. Settle every independent read
      // before interpreting failures or allowing cache cleanup to remove its cwd.
      const currentRead = cold
        ? Promise.resolve(portOk(null))
        : this.readCommitTree(op, input.expectedHead, "repair");
      const ancestorRead = this.git(op, [
        "merge-base",
        "--is-ancestor",
        input.commit,
        input.expectedHead,
      ]);
      const historicalRead = cold
        ? ancestorRead.then((ancestor) =>
          ancestor.ok
            ? this.readCommitTree(op, input.commit, "repair")
            : portError(
              "invalid",
              "historical repair commit is missing or not an ancestor",
            )
        )
        : this.readCommitTree(op, input.commit, "repair");
      const [current, ancestor, historical] = await Promise.allSettled([
        currentRead,
        ancestorRead,
        historicalRead,
      ]);
      if (current.status === "rejected") {
        return portError("unavailable", "current repair tree read failed");
      }
      if (!current.value.ok) return current.value;
      if (ancestor.status === "rejected" || !ancestor.value.ok) {
        return portError(
          "invalid",
          "historical repair commit is missing or not an ancestor",
        );
      }
      if (historical.status === "rejected") {
        return portError("unavailable", "historical repair tree read failed");
      }
      const snapshot = historical.value;
      if (!snapshot.ok) return snapshot;
      const lookup = await this.git(op, ["ls-remote", "origin", REPAIR_REF]);
      if (!lookup.ok) {
        return this.gitFailure("unavailable", "ls-remote", lookup);
      }
      const fresh = this.parseLsRemote(lookup.stdout, REPAIR_REF);
      if (fresh.status !== "found" || fresh.head !== input.expectedHead) {
        return portError(
          "conflict",
          "historical repair head changed during read",
        );
      }
      return portOk({
        status: "found" as const,
        snapshot: snapshot.value as RepairStateSnapshotV1,
        head: input.commit,
        ref: REPAIR_REF,
      });
    });
  }

  readReleaseAt(input: { commit: GitSha; expectedHead: GitSha }): Promise<
    PortResultV1<StateReadResultV1<ReleaseStateSnapshotV1>>
  > {
    return this.withOpDir(async (op) => {
      if (
        !/^[0-9a-f]{40}$/.test(input.commit) ||
        !/^[0-9a-f]{40}$/.test(input.expectedHead)
      ) {
        return portError("invalid", "historical release identity is malformed");
      }
      const loaded = await this.loadRemote(
        op,
        RELEASE_REF,
        "release",
        "complete",
      );
      if (!loaded.ok) return loaded;
      if (
        loaded.value.status !== "found" ||
        loaded.value.head !== input.expectedHead
      ) {
        return portError(
          "conflict",
          "historical release head changed or is absent",
        );
      }
      const ancestor = await this.git(op, [
        "merge-base",
        "--is-ancestor",
        input.commit,
        input.expectedHead,
      ]);
      if (!ancestor.ok) {
        return portError(
          "invalid",
          "historical release commit is missing or not an ancestor",
        );
      }
      const snapshot = await this.readCommitTree(op, input.commit, "release");
      if (!snapshot.ok) return snapshot;
      const lookup = await this.git(op, ["ls-remote", "origin", RELEASE_REF]);
      if (!lookup.ok) {
        return this.gitFailure("unavailable", "ls-remote", lookup);
      }
      const fresh = this.parseLsRemote(lookup.stdout, RELEASE_REF);
      if (fresh.status !== "found" || fresh.head !== input.expectedHead) {
        return portError(
          "conflict",
          "historical release head changed during read",
        );
      }
      return portOk({
        status: "found" as const,
        snapshot: snapshot.value as ReleaseStateSnapshotV1,
        head: input.commit,
        ref: RELEASE_REF,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Writes: role-gated, strict expected-head CAS, non-force pushes only.
  // -------------------------------------------------------------------------

  writeRepair(
    next: RepairStateSnapshotV1,
    expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    if (this.role !== "repair") {
      return Promise.resolve(portError(
        "invalid",
        "repair state writes require a repair-role store (role mismatch)",
      ));
    }
    return this.writeState(next, expectedHead, "repair", REPAIR_REF);
  }

  writeRelease(
    next: ReleaseStateSnapshotV1,
    expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    if (this.role !== "release") {
      return Promise.resolve(portError(
        "invalid",
        "release state writes require a release-role store (role mismatch)",
      ));
    }
    return this.writeState(next, expectedHead, "release", RELEASE_REF);
  }

  // -------------------------------------------------------------------------
  // Internals.
  // -------------------------------------------------------------------------

  private writeState(
    next: RepairStateSnapshotV1 | ReleaseStateSnapshotV1,
    expectedHead: GitSha | null,
    kind: StateKind,
    ref: string,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    // Validate the caller's snapshot before any Git mutation.
    try {
      if (kind === "repair") {
        parseRepairStateSnapshotV1(next);
      } else {
        parseReleaseStateSnapshotV1(next);
      }
    } catch {
      return Promise.resolve(
        portError("invalid", "state snapshot failed contract validation"),
      );
    }

    return this.withOpDir<StateWriteResultV1>(async (op) => {
      const loaded = await this.loadRemote(op, ref, kind);
      if (!loaded.ok) return loaded;
      const prior = loaded.value.status === "absent"
        ? null
        : loaded.value.snapshot;
      const priorHead = loaded.value.status === "absent"
        ? null
        : loaded.value.head;
      if (priorHead !== expectedHead) {
        return portOk({ status: "conflict", currentHead: priorHead });
      }

      const transitionMessage = validateSnapshotTransition(
        prior,
        next,
        expectedHead,
      );
      if (transitionMessage !== null) {
        return portError("invalid", transitionMessage);
      }

      let candidate: {
        pushed: boolean;
        head: GitSha;
        pushFailureKind: PortErrorV1["kind"] | null;
      };
      try {
        candidate = await this.buildAndPush(
          op,
          next,
          expectedHead,
          kind,
          ref,
        );
      } catch {
        // Local formation failure only (before any push): a sanitized typed
        // unavailable result, never an exception or raw filesystem path.
        return portError(
          "unavailable",
          "could not form the state commit locally",
        );
      }
      const ourHead = candidate.head;

      // Reconcile the authoritative ref before reporting any outcome; never
      // retry blindly. The response may have been lost — or the transport
      // itself may have thrown — after the server accepted the update; the
      // ref, not the push response, decides. A failed, thrown or malformed
      // verification read after an attempted push is ambiguous, never a false
      // "not applied" error.
      const verify = await this.git(op, ["ls-remote", "origin", ref]);
      const verifyParsed = !verify.ok
        ? ({ status: "invalid" } as const)
        : this.parseLsRemote(verify.stdout, ref);
      if (verifyParsed.status === "absent" && !candidate.pushed) {
        // A successful authoritative reread proves that a failed push did not
        // create the ref. Preserve the safe transport category so a trusted
        // caller can distinguish authentication from local availability
        // failure without exposing Git's raw stderr.
        return portError(
          candidate.pushFailureKind ?? "unavailable",
          "state push was not applied; the remote ref remains absent",
        );
      }
      if (verifyParsed.status !== "found") {
        return portOk({ status: "ambiguous", currentHead: priorHead });
      }
      const verifyHead = verifyParsed.head as GitSha;
      if (verifyHead === ourHead) {
        return portOk({ status: "applied", head: ourHead });
      }
      if (!candidate.pushed) {
        if (verifyHead === priorHead) {
          return portError(
            "unavailable",
            "state push was not applied; the remote ref is unchanged",
          );
        }
        return portOk({
          status: "conflict",
          currentHead: verifyHead,
        });
      }
      // The push reported success but the ref does not point at our commit:
      // preserve the ambiguous outcome for exact-state reconciliation.
      return portOk({
        status: "ambiguous",
        currentHead: verifyHead,
      });
    });
  }

  /**
   * Forms the candidate commit — parent pinned to the exact expected head
   * (no checkout/reset is ever performed; plumbing only) — with a unique
   * trusted write nonce in the commit message, then pushes without force.
   * Returns the actual commit identity, push result and safe failure category;
   * reconciliation (applied/conflict/ambiguous) happens in the caller.
   */
  private async buildAndPush(
    op: OpContext,
    next: RepairStateSnapshotV1 | ReleaseStateSnapshotV1,
    expectedHead: GitSha | null,
    kind: StateKind,
    ref: string,
  ): Promise<{
    pushed: boolean;
    head: GitSha;
    pushFailureKind: PortErrorV1["kind"] | null;
  }> {
    const manifest: StateManifestV1 = {
      version: "v1",
      kind: MANIFEST_KIND[kind],
      sequence: next.sequence,
      updatedAt: next.updatedAt,
      stateHead: expectedHead,
    };
    const files: { path: string; text: string }[] = [{
      path: "manifest.json",
      text: `${canonicalStringify(manifest)}\n`,
    }];
    files.push(...await recordFiles(next, kind));
    for (const file of files) {
      const slash = file.path.lastIndexOf("/");
      if (slash !== -1) {
        await Deno.mkdir(`${op.directory}/${file.path.slice(0, slash)}`, {
          recursive: true,
        });
      }
      await Deno.writeTextFile(`${op.directory}/${file.path}`, file.text);
    }

    const add = await this.git(op, ["add", "-A"]);
    if (!add.ok) throw new StatePushError("add");
    const tree = await this.git(op, ["write-tree"]);
    if (!tree.ok) throw new StatePushError("write-tree");
    const treeSha = tree.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(treeSha)) {
      throw new StatePushError("write-tree");
    }

    const nonce = await randomHex(32);
    // State pushes stay on the native Actions token, so their bookkeeping
    // commits carry the native Actions identity, never the App identity.
    const commitEnv = {
      GIT_AUTHOR_NAME: "github-actions[bot]",
      GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
      GIT_COMMITTER_NAME: "github-actions[bot]",
      GIT_COMMITTER_EMAIL:
        "41898282+github-actions[bot]@users.noreply.github.com",
    };
    const message = `sentinel-state ${kind} write\n\nnonce: ${nonce}`;
    const parentArgs = expectedHead === null ? [] : ["-p", expectedHead];
    const commit = await this.git(
      op,
      ["commit-tree", treeSha, ...parentArgs, "-m", message],
      commitEnv,
    );
    if (!commit.ok) throw new StatePushError("commit-tree");
    const ourHead = commit.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(ourHead)) {
      throw new StatePushError("commit-tree");
    }

    const push = await this.git(op, [
      "push",
      "origin",
      `${ourHead}:${ref}`,
    ]);
    return {
      pushed: push.ok,
      head: ourHead as GitSha,
      pushFailureKind: push.ok ? null : this.classifyGitError(push),
    };
  }
}
// ---------------------------------------------------------------------------
// Capability facades: narrow the combined store per role so a consumer can
// only receive the capability it may use (release model never gets repair
// write capability and vice versa).
// ---------------------------------------------------------------------------

export interface RepairGitStateStore extends StateReadView, RepairStateWriter {}
export interface ReleaseGitStateStore
  extends StateReadView, ReleaseStateWriter {}

export function createRepairStateStore(
  options: Omit<GitStateStoreOptions, "role">,
): RepairGitStateStore {
  return new GitStateStore({ ...options, role: "repair" });
}

export function createReleaseStateStore(
  options: Omit<GitStateStoreOptions, "role">,
): ReleaseGitStateStore {
  return new GitStateStore({ ...options, role: "release" });
}

export {
  DenoGitRunner,
  RELEASE_STATE_REF,
  REPAIR_STATE_REF,
} from "./state-git.ts";

export type {
  GitRunnerV1,
  GitRunResultV1,
  GitStateStoreOptions,
  StateWriterRole,
} from "./state-git.ts";
