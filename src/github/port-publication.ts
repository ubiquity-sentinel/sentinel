// port publication.

import type { GitSha } from "../contracts/brands.ts";
import type { TakeoverEffectAuthorization } from "../contracts/existing-pr-takeover.ts";
import type {
  GitHubPullRequestV1,
  PortResultV1,
  PullRequestCreateV1,
  PullRequestPublishV1,
  WriteOutcomeV1,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import { MaxText } from "../contracts/validation.ts";
import { GitHubPortEvidence } from "./port-evidence.ts";

export abstract class GitHubPortPublication extends GitHubPortEvidence {
  // -------------------------------------------------------------------------
  // pushHead
  // -------------------------------------------------------------------------

  async pushHead(
    ref: string,
    sha: GitSha,
    expectedRef: GitSha | null,
    takeover?: TakeoverEffectAuthorization,
  ): Promise<PortResultV1<WriteOutcomeV1>> {
    const queueInput = {
      operation: "publication" as const,
      branch: ref.replace(/^refs\/heads\//, ""),
      expectedHead: expectedRef,
    };
    const queued = await this.queueEffect(queueInput);
    if (!queued.ok) return queued;
    const applied = async (): Promise<PortResultV1<WriteOutcomeV1>> => {
      const final = await this.queueEffect({
        ...queueInput,
        expectedHead: sha,
      });
      return final.ok ? portOk("applied") : final;
    };
    // 1. Exact expected-ref check against the authoritative remote identity.
    const current = await this.gatedRemoteCall(() =>
      this.git.readRemoteRef(ref)
    );
    if (!current.ok) return current;
    if (expectedRef === null) {
      // A new deterministic head ref cannot overwrite a conflicting existing ref.
      if (current.value !== null) {
        return portError("conflict", "head ref already exists");
      }
    } else {
      if (current.value === null) {
        return portError("conflict", "expected head ref is absent");
      }
      if (current.value !== expectedRef) {
        return portError("conflict", "head ref moved");
      }
    }
    // 2. The authenticated remote already advertises exactly this candidate:
    // the prior publication is proven by that observation alone. No local
    // ancestry check, no push and no model work; a conflicting or absent ref
    // was already rejected above.
    if (current.value === sha) {
      const custody = await this.takeoverEffect({
        kind: "push",
        ref,
        head: sha,
        expectedRef,
      }, takeover);
      return custody.ok ? await applied() : custody;
    }
    // 3. Ordinary fast-forward only: the candidate must descend from the
    // current head when the branch exists.
    if (current.value !== null) {
      const ancestor = await this.git.isAncestor(current.value, sha);
      if (!ancestor.ok) return ancestor;
      if (!ancestor.value) {
        return portError("conflict", "push would not be a fast-forward");
      }
    }
    // 4. Publish through the trusted executor (never forced). The executor
    // atomically guards the exact advertised ref inside the push transaction;
    // a remote movement after this precheck is rejected, never applied.
    const beforePush = await this.queueEffect(queueInput);
    if (!beforePush.ok) return beforePush;
    const custody = await this.takeoverEffect({
      kind: "push",
      ref,
      head: sha,
      expectedRef,
    }, takeover);
    if (!custody.ok) return custody;
    const pushed = await this.gatedRemoteCall(() =>
      this.git.push(ref, sha, expectedRef)
    );
    if (!pushed.ok) return pushed;
    switch (pushed.value.status) {
      case "applied":
        return await applied();
      case "non_fast_forward":
        return portError("conflict", "push rejected as non-fast-forward");
      case "missing_object":
        return portError("invalid", "candidate commit is not available");
      case "rejected":
        return portError("conflict", "push was rejected");
      case "ambiguous":
        break;
    }
    // 4. Ambiguous effect: reread the exact remote identity and reconcile.
    // A cooldown denial or a failed reread keeps the effect unconfirmed: the
    // outcome stays ambiguous, never failed/applied, and the push is never
    // repeated.
    const after = await this.gatedRemoteCall(() => this.git.readRemoteRef(ref));
    if (!after.ok) {
      // The reread itself failed: the effect remains unconfirmed.
      return portOk("ambiguous");
    }
    if (after.value === sha) return await applied();
    return portOk("ambiguous");
  }

  // -------------------------------------------------------------------------
  // createPullRequest
  // -------------------------------------------------------------------------

  async createPullRequest(
    request: PullRequestCreateV1,
  ): Promise<PortResultV1<PullRequestPublishV1>> {
    if (
      request.headRef.length === 0 || request.headRef.length > MaxText.branch
    ) {
      return portError("invalid", "invalid head branch");
    }
    if (
      request.baseRef.length === 0 || request.baseRef.length > MaxText.branch
    ) {
      return portError("invalid", "invalid base branch");
    }
    if (request.title.length > MaxText.message) {
      return portError(
        "invalid",
        "pull request title exceeds the contract bound",
      );
    }
    if (request.body.length > MaxText.body) {
      return portError(
        "invalid",
        "pull request body exceeds the contract bound",
      );
    }
    const queueInput = {
      operation: "publication" as const,
      branch: request.headRef,
      expectedHead: request.expectedHeadRef,
    };
    const queued = await this.queueEffect(queueInput);
    if (!queued.ok) return queued;
    // A created, reused or reconciled PR must describe the same publication.
    const custody = await this.takeoverEffect({ kind: "create", request });
    if (!custody.ok) return custody;
    // The response may race an external edit even after the branch precheck.
    const matchesPublication = (pull: GitHubPullRequestV1): boolean =>
      pull.state === "open" && pull.mergeSha === null &&
      pull.head === request.expectedHeadRef &&
      pull.headRef === request.headRef && pull.base === request.expectedBase &&
      pull.baseRef === request.baseRef &&
      pull.author === this.trustedPrAuthor && pull.body === request.body;
    // 1. The deterministic head branch must exist and carry exactly the
    // expected candidate, or the publication precondition fails closed.
    const branch = await this.client.readRef(`heads/${request.headRef}`);
    if (!branch.ok) return branch;
    if (branch.value === null || branch.value.sha !== request.expectedHeadRef) {
      return portError(
        "conflict",
        "head branch does not exist or does not carry the expected candidate",
      );
    }
    // 2. Discover existing PRs on the exact head ref; reuse only the exact own
    // open PR, block foreign/human-owned PRs and collisions.
    const existing = await this.client.listPullRequestsByHeadRef(
      request.headRef,
    );
    if (!existing.ok) return existing;
    const open = existing.value.filter((pull) => pull.state === "open");
    if (open.length > 1) {
      return portError(
        "conflict",
        "multiple open pull requests share the head ref",
      );
    }
    if (open.length === 1) {
      const owned = open[0];
      if (owned.head !== request.expectedHeadRef) {
        return portError("conflict", "existing pull request head differs");
      }
      if (owned.base !== request.expectedBase) {
        // The base precondition is re-observed after publication: a moved
        // base means the publish precondition no longer holds.
        return portError("conflict", "pull request base moved");
      }
      if (owned.author !== this.trustedPrAuthor) {
        return portError(
          "conflict",
          "pull request is not owned by the trusted actor",
        );
      }
      if (!matchesPublication(owned)) {
        return portError(
          "conflict",
          "pull request publication identity mismatch",
        );
      }
      const queueAfter = await this.queueEffect(queueInput);
      if (!queueAfter.ok) return queueAfter;
      return portOk({
        outcome: "applied",
        number: owned.number,
        head: owned.head,
      });
    }
    // 3. Publish the requested body byte-for-byte: the loop builds the exact
    // closing-keyword body for an issue-backed repair. Then reconcile a
    // duplicate response against authoritative state instead of guessing from
    // the HTTP status.
    const beforeCreate = await this.queueEffect(queueInput);
    if (!beforeCreate.ok) return beforeCreate;
    const finalCustody = await this.takeoverEffect({ kind: "create", request });
    if (!finalCustody.ok) return finalCustody;
    const created = await this.client.createPull({
      title: request.title,
      headRef: request.headRef,
      baseRef: request.baseRef,
      body: request.body,
    });
    if (!created.ok) return created;
    if (created.value.status === "created") {
      if (created.value.pr.base !== request.expectedBase) {
        // The base precondition is re-observed after publication: a moved
        // base means the published PR is not the exact candidate.
        return portError("conflict", "pull request base moved");
      }
      if (!matchesPublication(created.value.pr)) {
        return portError(
          "conflict",
          "pull request publication identity mismatch",
        );
      }
      const queueAfter = await this.queueEffect(queueInput);
      if (!queueAfter.ok) return queueAfter;
      return portOk({
        outcome: "applied",
        number: created.value.pr.number,
        head: created.value.pr.head,
      });
    }
    const reread = await this.client.listPullRequestsByHeadRef(request.headRef);
    if (!reread.ok) return reread;
    const rereadOpen = reread.value.filter((pull) => pull.state === "open");
    if (rereadOpen.length === 1) {
      const owned = rereadOpen[0];
      if (matchesPublication(owned)) {
        const queueAfter = await this.queueEffect(queueInput);
        if (!queueAfter.ok) return queueAfter;
        return portOk({
          outcome: "applied",
          number: owned.number,
          head: owned.head,
        });
      }
      return portError("conflict", "existing pull request collision");
    }
    return portOk({ outcome: "ambiguous", number: null, head: null });
  }
}
