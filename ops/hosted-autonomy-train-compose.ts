/**
 * The production train composer (sentinel #330) over the trusted git
 * executor: the deterministic `merge-tree --write-tree` integration and the
 * carried-patch proof the runtime already uses for a refreshed head.
 *
 * Member i joins the train C(i-1) (C0 is the tip) as
 * `integrateBase(H_i, C(i-1))`: a fixed-identity, fixed-timestamp two-parent
 * commit, so the same tip and members always yield the same train commits.
 * It joins only when its own patch is carried byte for byte: the merge-base
 * patch `B_i...H_i` its review judged equals `C(i-1)...C_i` (`carriedPatchHolds`
 * over `git-carried-patch.ts`), so each member's review stays bound by the
 * exact patch it lands with. A conflict leaves the train (`conflict`), a
 * cleanly merged but different patch leaves it (`patch_changed`), an
 * unprovable one leaves it (`unproven`); the next member composes on the last
 * joined commit. Nothing here touches a checkout, index, ref or network
 * except `publish`, the one non-force push of the train ref.
 */
import type { GitSha } from "../src/contracts/brands.ts";
import { carriedPatchHolds } from "../src/contracts/ports.ts";
import type { GitExecutorV1 } from "../src/github/git-executor.ts";
import type {
  DeliveryTrainComposerV1,
  DeliveryTrainComposeStepV1,
} from "./hosted-autonomy-train-types.ts";

const SHA = /^[0-9a-f]{40}$/;

export interface GitTrainComposerOptionsV1 {
  /**
   * Make the exact commits present in the executor's local store (the
   * target's tip and member heads, from its own authenticated remote). False
   * makes the composition unavailable; absent: the objects are already local.
   */
  ensureObjects?(shas: readonly string[]): Promise<boolean>;
  /** Optional explicit CI request for a pushed train ref. */
  triggerCi?(input: { ref: string; sha: string }): Promise<boolean>;
}

export function gitDeliveryTrainComposer(
  git: GitExecutorV1,
  options: GitTrainComposerOptionsV1 = {},
): DeliveryTrainComposerV1 {
  return {
    async compose({ tip, members }) {
      if (
        git.integrateBase === undefined ||
        git.carriedPatchProof === undefined || !SHA.test(tip) ||
        members.some((m) => !SHA.test(m.head) || !SHA.test(m.base))
      ) return null;
      try {
        if (
          options.ensureObjects !== undefined &&
          !await options.ensureObjects([tip, ...members.map((m) => m.head)])
        ) return null;
      } catch {
        return null;
      }
      const steps: DeliveryTrainComposeStepV1[] = [];
      let train = tip as GitSha;
      for (const member of members) {
        let joined;
        try {
          joined = await git.integrateBase(member.head as GitSha, train);
        } catch {
          return null;
        }
        if (!joined.ok) {
          if (joined.error.kind === "conflict") {
            steps.push({ status: "conflict" });
            continue;
          }
          return null;
        }
        const request = {
          reviewedBase: member.base as GitSha,
          reviewedHead: member.head as GitSha,
          base: train,
          head: joined.value,
        };
        let proof;
        try {
          proof = await git.carriedPatchProof(request);
        } catch {
          proof = null;
        }
        if (proof === null || !proof.ok) {
          steps.push({ status: "unproven" });
          continue;
        }
        if (!carriedPatchHolds(request, proof.value)) {
          steps.push({ status: "patch_changed" });
          continue;
        }
        steps.push({
          status: "joined",
          commit: joined.value,
          patch: proof.value.reviewedPatch,
        });
        train = joined.value;
      }
      return steps;
    },
    async publish({ ref, sha }) {
      if (!SHA.test(sha)) return "rejected";
      let pushed;
      try {
        pushed = await git.push(ref, sha as GitSha, null);
      } catch {
        return "ambiguous";
      }
      if (pushed.ok && pushed.value.status === "applied") return "applied";
      if (pushed.ok && pushed.value.status === "ambiguous") return "ambiguous";
      // An earlier push of this same operation (a lost response) already
      // made the ref: the exact same commit is the publication.
      try {
        const remote = await git.readRemoteRef(ref);
        return remote.ok && remote.value === sha ? "applied" : "rejected";
      } catch {
        return "ambiguous";
      }
    },
    ...(options.triggerCi === undefined
      ? {}
      : { triggerCi: options.triggerCi }),
  };
}
