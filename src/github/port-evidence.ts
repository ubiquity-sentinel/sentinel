// port evidence.

import type { GitSha } from "../contracts/brands.ts";
import type { ReviewNormalizationV1 } from "./review-normalize.ts";
import type {
  MergeRequestV1,
  PortErrorV1,
  PortResultV1,
} from "../contracts/ports.ts";
import {
  normalizeReviewObservation,
  operationKeyOfReviewRequest,
  reviewOperationKeyBindsHead,
} from "./review-normalize.ts";
import { reviewOperationKey } from "../repair/keys.ts";
import type { GitHubPullRequestV1 } from "../contracts/ports.ts";
import { asFindingFingerprint } from "../contracts/brands.ts";
import { canonicalStringifySha256 } from "../contracts/canonical.ts";
import { tryParse } from "../contracts/validation.ts";
import { parsePullRequestRule, parseRequiredStatusRule } from "./wire.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { GitHubRuleSetWireV1 } from "./wire.ts";
import { GitHubPortBase } from "./port-base.ts";
import {
  type GitHubEffectiveProtectionsV1,
  SUPPORTED_MERGE_RULE_TYPES,
} from "./port-contracts.ts";
import { ruleSetEvidenceMatches, uniqueSorted } from "./port-merge-policy.ts";

export abstract class GitHubPortEvidence extends GitHubPortBase {
  protected async currentReviewEvidence(
    prNumber: number,
    merge: {
      expectedHead: GitSha;
      review: { requestId: string; id: string };
    },
  ): Promise<
    | { ok: true; normalized: ReviewNormalizationV1 | null }
    | { ok: false; error: PortErrorV1 }
  > {
    const service = await this.gatedRemoteCall(() =>
      this.reviewService.readReview({
        operationKey: null,
        requestId: merge.review.requestId,
        prNumber,
      })
    );
    if (!service.ok) {
      return { ok: false, error: service.error };
    }
    const pull = await this.client.readPullRequest(prNumber);
    if (!pull.ok) {
      return { ok: false, error: pull.error };
    }
    const reviews = await this.client.readReviews(prNumber);
    if (!reviews.ok) {
      return { ok: false, error: reviews.error };
    }
    const comments = await this.client.readReviewComments(prNumber);
    if (!comments.ok) {
      return { ok: false, error: comments.error };
    }
    // The service must answer for the EXACT submission this receipt records.
    // The receipt names its durable request id; when that id is the transport's
    // own record identity for one operation key (`review-` + key) the key is
    // recovered from it exactly, so a bounded LATER attempt of the SAME head
    // binds just like the first attempt. A receipt that names no such identity
    // (the pre-attempt convention) keeps the original PR/head key — the only
    // identity that existed then — and a recovered key that binds another pull
    // request, head or scope is never accepted. The record must additionally be
    // the exact one the receipt names, so one attempt's clean verdict can never
    // authorize a merge on another attempt's record.
    const namedKey = operationKeyOfReviewRequest(merge.review.requestId);
    const firstAttemptKey = reviewOperationKey(prNumber, merge.expectedHead);
    const operationKey = namedKey !== null &&
        reviewOperationKeyBindsHead(namedKey, prNumber, merge.expectedHead)
      ? namedKey
      : firstAttemptKey;
    if (service.value.requestId !== merge.review.requestId) {
      return { ok: true, normalized: null };
    }
    const observation = await normalizeReviewObservation({
      request: {
        operationKey,
        prNumber,
        head: merge.expectedHead,
      },
      service: service.value,
      repository: this.repository,
      expectedOperationKey: operationKey,
      pullRequest: pull.value,
      reviews: reviews.value,
      comments: comments.value,
      expectedReviewer: this.trustedReviewer,
      findingCap: this.findingCap,
      receivedAt: this.clock.now(),
    });
    if (!observation.ok) {
      return {
        ok: false,
        error: observation.error,
      };
    }
    if (observation.value.status !== "completed") {
      // Pending/unavailable/stale/completed-for-another-head: no merge
      // authorization from this request.
      return { ok: true, normalized: null };
    }
    return {
      ok: true,
      normalized: {
        status: observation.value.status,
        requestId: observation.value.requestId,
        reviewer: observation.value.reviewer,
        resultId: observation.value.resultId,
        completedAt: observation.value.completedAt,
        observedHead: observation.value.observedHead,
        observedBase: observation.value.observedBase,
        summary: observation.value.summary,
        findings: observation.value.findings.map((finding) => ({
          id: finding.id,
          severity: finding.severity,
          path: finding.path,
          message: finding.message,
        })),
        // Completed normalization is only reachable with a complete finding
        // set; the residual unknown count is a per-observation value.
        findingsUncounted: 0,
        // The merge re-observation carries the SAME task acceptance the freshly
        // read durable journal reports, so a receipt can never be authorized by
        // a differently-bound semantic verdict.
        taskAcceptance: observation.value.taskAcceptance,
      },
    };
  }

  /**
   * Every resolved finding must be authenticated by the trusted resolver for
   * the exact immutable resolution reference bound to this repository, PR,
   * head and finding fingerprint, and the authenticated identity must be in
   * the configured allowlist. Without the concrete verifier integration, any
   * resolved finding fail closes.
   */
  protected async resolutionsTrusted(
    receipt: MergeRequestV1["review"],
    pull: GitHubPullRequestV1,
  ): Promise<boolean> {
    const verifier = this.resolutionVerifier;
    if (verifier === null) {
      return receipt.findings.every((finding) => !finding.resolved);
    }
    for (const finding of receipt.findings) {
      if (!finding.resolved) continue;
      if (finding.resolutionEvidence === null) return false;
      // The exact finding identity is recomputed and must equal the recorded
      // fingerprint: a forged caller-supplied fingerprint never binds.
      const fingerprint = asFindingFingerprint(
        await canonicalStringifySha256({
          id: finding.id,
          severity: finding.severity,
          path: finding.path,
          message: finding.message,
        }),
      );
      if (fingerprint !== finding.fingerprint) return false;
      const verified = await verifier.verifyResolution({
        repository: this.repository,
        prNumber: pull.number,
        head: pull.head,
        findingFingerprint: finding.fingerprint,
        authorizingIdentity: finding.resolutionEvidence.authorizingIdentity,
        reference: finding.resolutionEvidence.reference,
      });
      if (!verified.ok) return false;
      if (!verified.value.verified) return false;
      if (
        verified.value.authorizingIdentity !==
          finding.resolutionEvidence.authorizingIdentity
      ) {
        return false;
      }
      if (
        !this.trustedResolutionAuthors.has(
          finding.resolutionEvidence.authorizingIdentity,
        )
      ) {
        return false;
      }
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Effective protections (active repository/organization branch rules)
  // -------------------------------------------------------------------------

  /**
   * Authoritative effective protections for the configured base branch from
   * the actual GitHub rules API: all active matching rules (paginated) plus
   * the per-ruleset bypass policy (list with includes_parents, exact ruleset
   * details as needed). An omitted `bypass_actors` list is unknown and blocks,
   * except when the same exact identity/source/enforcement-bound detail
   * explicitly reports `current_user_can_bypass == "never"`: this client
   * credential performs the merge, so an explicit never proves it cannot
   * bypass even though the actor list is unavailable. An omitted list is
   * never read as an empty actor list.
   */
  async readEffectiveProtections(
    branch: string,
  ): Promise<PortResultV1<GitHubEffectiveProtectionsV1>> {
    const rules = await this.client.readBranchRules(branch);
    if (!rules.ok) return rules;
    const ruleSets = await this.client.readRepositoryRuleSets();
    if (!ruleSets.ok) return ruleSets;

    const activeRules = rules.value;
    const activeRuleTypes = uniqueSorted(rules.value.map((rule) => rule.type));
    const unsupportedRuleTypes = activeRuleTypes.filter(
      (type) => !SUPPORTED_MERGE_RULE_TYPES.has(type),
    );

    // Exact required status checks / pull-request requirement rules. A rule
    // of a known type with unreadable parameters is unreadable policy: fail
    // closed (never guessed).
    const statusRule = rules.value.find(
      (rule) => rule.type === "required_status_checks",
    );
    const pullRule = rules.value.find((rule) => rule.type === "pull_request");
    let requiredCheckNames: string[] = [];
    let strictRequiredChecks = false;
    let requiredApprovingReviewCount = 0;
    let pullRequestThreadResolutionRequired = false;
    if (statusRule !== undefined) {
      const parsed = tryParse(parseRequiredStatusRule, statusRule);
      if (!parsed.ok) {
        return portError(
          "invalid",
          "required status-checks rule parameters are unreadable",
        );
      }
      strictRequiredChecks = parsed.value.strict;
      requiredCheckNames = parsed.value.checkNames;
    }
    if (pullRule !== undefined) {
      const parsed = tryParse(parsePullRequestRule, pullRule);
      if (!parsed.ok) {
        return portError(
          "invalid",
          "pull_request rule parameters are unreadable",
        );
      }
      requiredApprovingReviewCount = parsed.value.requiredApprovingReviewCount;
      pullRequestThreadResolutionRequired =
        parsed.value.requiredReviewThreadResolution;
    }

    // Bypass policy for every ruleset that contributed an active rule. An
    // active rule whose ruleset identity or source binding is missing (or
    // contradicted by its evidence, or whose ruleset is not found / not
    // actively enforcing) makes the bypass policy unavailable/unknown:
    // unidentified active rules are never dropped from bypass verification,
    // and contradictory/missing enforcement evidence is never treated as
    // active non-bypassable policy.
    const byId = new Map(
      ruleSets.value.map((ruleSet) => [ruleSet.id, ruleSet]),
    );
    const detailCache = new Map<number, GitHubRuleSetWireV1>();
    let bypassUnknown = false;
    const bypassActors: { actorType: string; actorId: number | null }[] = [];
    for (const rule of activeRules) {
      const ruleSetId = rule.rulesetId;
      const sourceType = rule.rulesetSourceType;
      const source = rule.rulesetSource;
      if (ruleSetId === null || sourceType === null || source === null) {
        // An active rule without exact ruleset identity/source binding cannot
        // be bound to bypass evidence: its policy is unknown.
        bypassUnknown = true;
        continue;
      }
      let evidence = byId.get(ruleSetId) ?? null;
      if (evidence === null) {
        // An active rule whose ruleset cannot be found: unknown policy.
        bypassUnknown = true;
        continue;
      }
      if (
        !ruleSetEvidenceMatches(evidence, ruleSetId, sourceType, source) ||
        evidence.enforcement !== "active"
      ) {
        // Contradictory identity/source binding or non-active enforcement
        // cannot prove active non-bypassable policy.
        bypassUnknown = true;
        continue;
      }
      if (
        evidence.bypassActors === null ||
        evidence.currentUserCanBypass === null
      ) {
        evidence = detailCache.get(ruleSetId) ?? null;
        if (evidence === null) {
          const fetched = await this.client.readRepositoryRuleSet(ruleSetId);
          if (!fetched.ok) {
            // Same event, ruleset id and typed error kind only.
            console.error(JSON.stringify({
              event: "sentinel_ruleset_policy_unavailable",
              rulesetId: ruleSetId,
              errorKind: fetched.error.kind,
            }));
            bypassUnknown = true;
            continue;
          }
          evidence = fetched.value;
          detailCache.set(ruleSetId, evidence);
        }
      }
      if (
        !ruleSetEvidenceMatches(evidence, ruleSetId, sourceType, source) ||
        evidence.enforcement !== "active"
      ) {
        // The exact detail must be the requested ruleset with the same source
        // binding and active enforcement; anything else is contradictory.
        bypassUnknown = true;
        continue;
      }
      // Bounded operational diagnostic on the FINAL evidence (fetched detail
      // or detail cache) that passed the exact identity/enforcement checks:
      // exact ruleset identity, which bypass fields were omitted (the hosted
      // token authority boundary) and the normalized currentUserCanBypass
      // enum value or null (never a token or raw API body). Never pre-fetch
      // list evidence.
      if (
        evidence.bypassActors === null ||
        evidence.currentUserCanBypass === null
      ) {
        console.error(JSON.stringify({
          event: "sentinel_ruleset_policy_unavailable",
          rulesetId: ruleSetId,
          sourceType,
          source,
          bypassActorsPresent: evidence.bypassActors !== null,
          currentUserCanBypassPresent: evidence.currentUserCanBypass !== null,
          currentUserCanBypass: evidence.currentUserCanBypass,
        }));
      }
      if (evidence.currentUserCanBypass === null) {
        // Missing caller-bypass evidence: the policy is unknown and blocks,
        // even when an actor list is present.
        bypassUnknown = true;
        continue;
      }
      if (evidence.currentUserCanBypass !== "never") {
        // The caller (or an unknown actor) can bypass: server enforcement
        // cannot be relied on.
        bypassUnknown = true;
        continue;
      }
      if (evidence.bypassActors === null) {
        // Omitted actor list with an explicit `never` for this exact
        // credential: the SAME credential performs the expected-head merge,
        // so no listed actor can authorize it to bypass. This is
        // explicit-never authorization, never invented empty-list evidence.
        continue;
      }
      for (const actor of evidence.bypassActors) {
        bypassActors.push({
          actorType: actor.actorType,
          actorId: actor.actorId,
        });
      }
    }

    return portOk({
      branch,
      activeRuleTypes,
      unsupportedRuleTypes,
      mergeQueueActive: activeRuleTypes.includes("merge_queue"),
      requiredCheckNames,
      strictRequiredChecks,
      requiredApprovingReviewCount,
      pullRequestThreadResolutionRequired,
      bypassUnknown,
      bypassActors,
    });
  }
}
