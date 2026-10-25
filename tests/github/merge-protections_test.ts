// mergePullRequest protections suite. Owner directive 2026-10-24: branch
// protection rules are not a merge requirement and the only internal policy
// is that every P0 is resolved. The active rules are still read so that the
// required checks and approvals a target does configure are honoured; an
// empty, unsupported, bypassable, contradictory or unreadable rule policy no
// longer blocks. All fixtures are synthetic.

import {
  checkRunWire,
  commitStatusWire,
  FakeGitExecutor,
  httpRespond,
  makePort,
  mergeResponseWire,
  nonFastForwardRuleWire,
  pullRequestRuleWire,
  RULESET_ID,
  rulesetWire,
  SHA1,
  SHA3,
  SHA4,
  statusChecksRuleWire,
} from "./helpers.ts";
import assert from "node:assert/strict";
import type { ScriptEntry } from "./helpers.ts";
import {
  baseTipRead,
  blockedReason,
  checksRead,
  CLEAN_COMPLETION,
  CLOCK,
  commentsRead,
  defaultRules,
  happyScript,
  type mergeCall,
  mergedPort,
  mergeParentsRead,
  mergeRequest,
  pullEntry,
  putCount,
  reviewsRead,
  RULES_PATH,
  RULESETS_PATH,
  rulesRead,
  trustedService,
} from "./merge-helpers.ts";

Deno.test("mergePullRequest: branch rules are not a merge requirement; required checks they define still bind", async () => {
  // Every rule shape that formerly blocked as `protection_required` (no
  // active rules, non-strict or empty required checks, no pull_request rule,
  // an unsupported or merge-queue rule, a configured/unknown bypass policy, a
  // ruleset missing from the list, required thread resolution) now merges
  // exactly once on the exact head. Where the readable rules bind `ci` as a
  // required check, a failing `ci` still blocks with zero merge writes.
  const cases: {
    name: string;
    rules?: unknown[];
    rulesets?: unknown[];
    /** Whether the readable rules bind `ci` as a required check. */
    requiresCi: boolean;
  }[] = [
    {
      name: "no-active-rules",
      rules: [],
      requiresCi: false,
    },
    {
      name: "non-strict-up-to-date",
      rules: [
        statusChecksRuleWire({
          parameters: {
            required_status_checks: [{ context: "ci" }],
            strict_required_status_checks_policy: false,
          },
        }),
        pullRequestRuleWire(),
      ],
      requiresCi: true,
    },
    {
      name: "empty-required-checks",
      rules: [
        statusChecksRuleWire({
          parameters: {
            required_status_checks: [],
            strict_required_status_checks_policy: true,
          },
        }),
        pullRequestRuleWire(),
      ],
      requiresCi: false,
    },
    {
      name: "no-pull-request-rule",
      rules: [statusChecksRuleWire(), nonFastForwardRuleWire()],
      requiresCi: true,
    },
    {
      name: "unknown-rule-type",
      rules: [
        ...defaultRules(),
        { type: "required_linear_history", id: 14, ruleset_id: 10 },
      ],
      requiresCi: true,
    },
    {
      name: "merge-queue-rule",
      rules: [
        ...defaultRules(),
        { type: "merge_queue", id: 15, ruleset_id: 10 },
      ],
      requiresCi: true,
    },
    {
      name: "bypass-actor-configured",
      rulesets: [rulesetWire({
        bypass_actors: [{
          actor_type: "OrganizationAdmin",
          actor_id: null,
          bypass_mode: "always",
        }],
      })],
      requiresCi: true,
    },
    {
      name: "caller-can-bypass",
      rulesets: [rulesetWire({ current_user_can_bypass: "always" })],
      requiresCi: true,
    },
    {
      name: "bypass-policy-omitted",
      rulesets: [rulesetWire({
        bypass_actors: null,
        current_user_can_bypass: null,
      })],
      requiresCi: true,
    },
    {
      name: "ruleset-missing-from-list",
      rulesets: [],
      requiresCi: true,
    },
    {
      name: "thread-resolution-required",
      rules: [
        statusChecksRuleWire(),
        pullRequestRuleWire({
          parameters: {
            allowed_merge_methods: ["merge"],
            dismiss_stale_reviews_on_push: true,
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_approving_review_count: 0,
            required_review_thread_resolution: true,
          },
        }),
      ],
      requiresCi: true,
    },
  ];
  const mergePut = httpRespond(
    "PUT",
    "/repos/ubiquity-sentinel/sentinel/pulls/1/merge",
    200,
    mergeResponseWire(SHA3),
  );
  for (const item of cases) {
    const green = mergedPort(happyScript({
      rules: item.rules,
      rulesets: item.rulesets,
      extra: [mergePut],
    }));
    const merged = await green.port.mergePullRequest(mergeRequest());
    assert.ok(merged.ok, `${item.name}: ${JSON.stringify(merged)}`);
    if (!merged.ok) continue;
    assert.deepEqual(
      merged.value,
      { outcome: "merged", head: SHA1, mergeSha: SHA3 },
      item.name,
    );
    assert.equal(putCount(green.transport), 1, item.name);

    if (!item.requiresCi) continue;
    const red = mergedPort(happyScript({
      rules: item.rules,
      rulesets: item.rulesets,
      checks: [checkRunWire({ conclusion: "failure" })],
      extra: [mergePut],
    }));
    const failed = await red.port.mergePullRequest(mergeRequest());
    assert.equal(blockedReason(failed), "checks_failed", item.name);
    assert.equal(putCount(red.transport), 0, item.name);
  }
});

Deno.test("mergePullRequest: unidentified or contradicting ruleset evidence no longer blocks the merge", async () => {
  const detailUrl = `/repos/ubiquity-sentinel/sentinel/rulesets/${RULESET_ID}`;
  const withoutKeys = (keys: string[]) =>
    defaultRules().map((rule) => {
      const copy = { ...(rule as Record<string, unknown>) };
      for (const key of keys) delete copy[key];
      return copy;
    });
  const cases: {
    name: string;
    rules?: unknown[];
    rulesets?: unknown[];
    extra?: ScriptEntry[];
  }[] = [
    {
      name: "active-rule-identity-missing",
      // Every effective rule omits its ruleset_id: no evidence can be bound
      // to its bypass policy (unknown policy, which formerly blocked).
      rules: withoutKeys(["ruleset_id"]),
      rulesets: [rulesetWire()],
    },
    {
      name: "active-rule-source-binding-missing",
      rules: withoutKeys(["ruleset_source_type", "ruleset_source"]),
      rulesets: [rulesetWire()],
    },
    {
      name: "ruleset-detail-id-mismatch",
      // The list omits the policy, and the exact detail answers the wrong
      // ruleset id: contradictory evidence, not proof of non-bypassable
      // active policy.
      rulesets: [
        rulesetWire({ bypass_actors: null, current_user_can_bypass: null }),
      ],
      extra: [
        httpRespond(
          "GET",
          detailUrl,
          200,
          rulesetWire({
            id: RULESET_ID + 1,
            bypass_actors: null,
            current_user_can_bypass: "never",
          }),
        ),
      ],
    },
    {
      name: "ruleset-detail-source-mismatch",
      rulesets: [
        rulesetWire({ bypass_actors: null, current_user_can_bypass: null }),
      ],
      extra: [
        httpRespond(
          "GET",
          detailUrl,
          200,
          rulesetWire({
            source_type: "Organization",
            source: "other-org",
            bypass_actors: null,
            current_user_can_bypass: "never",
          }),
        ),
      ],
    },
    {
      name: "ruleset-detail-not-active",
      rulesets: [
        rulesetWire({ bypass_actors: null, current_user_can_bypass: null }),
      ],
      extra: [
        httpRespond(
          "GET",
          detailUrl,
          200,
          rulesetWire({
            enforcement: "evaluate",
            bypass_actors: null,
            current_user_can_bypass: "never",
          }),
        ),
      ],
    },
    {
      name: "bypass-policy-missing",
      // Exact detail (matching id/source/enforcement) still omits the bypass
      // policy: unknown, never "no bypass actors".
      rulesets: [
        rulesetWire({ bypass_actors: null, current_user_can_bypass: null }),
      ],
      extra: [
        httpRespond(
          "GET",
          detailUrl,
          200,
          rulesetWire({
            bypass_actors: null,
            current_user_can_bypass: null,
          }),
        ),
      ],
    },
    {
      name: "bypass-actors-omitted-caller-always",
      // An omitted actor list is not empty-list evidence: an explicit
      // non-never caller-bypass value stays bypassable and blocks.
      rulesets: [
        rulesetWire({
          bypass_actors: null,
          current_user_can_bypass: "always",
        }),
      ],
      extra: [
        httpRespond(
          "GET",
          detailUrl,
          200,
          rulesetWire({
            bypass_actors: null,
            current_user_can_bypass: "always",
          }),
        ),
      ],
    },
    {
      name: "bypass-actors-omitted-caller-pull-requests-only",
      rulesets: [
        rulesetWire({
          bypass_actors: null,
          current_user_can_bypass: "pull_requests_only",
        }),
      ],
      extra: [
        httpRespond(
          "GET",
          detailUrl,
          200,
          rulesetWire({
            bypass_actors: null,
            current_user_can_bypass: "pull_requests_only",
          }),
        ),
      ],
    },
    {
      name: "bypass-actors-omitted-caller-exempt",
      rulesets: [
        rulesetWire({
          bypass_actors: null,
          current_user_can_bypass: "exempt",
        }),
      ],
      extra: [
        httpRespond(
          "GET",
          detailUrl,
          200,
          rulesetWire({
            bypass_actors: null,
            current_user_can_bypass: "exempt",
          }),
        ),
      ],
    },
    {
      name: "list-evidence-source-mismatch",
      rulesets: [rulesetWire({
        source_type: "Organization",
        source: "other-org",
      })],
    },
    {
      name: "contributing-ruleset-not-active",
      rulesets: [rulesetWire({ enforcement: "disabled" })],
    },
  ];
  // Owner directive 2026-10-24: a bypass policy that is unknown, contradicted
  // or bypassable is not a merge requirement. Every shape merges exactly once
  // on the exact head; the rules' required `ci` check (green here) stays
  // bound, see the previous test for the failing-check block.
  for (const item of cases) {
    const { port, transport } = mergedPort(happyScript({
      rules: item.rules ?? defaultRules(),
      rulesets: item.rulesets ?? [rulesetWire()],
      extra: [
        ...(item.extra ?? []),
        httpRespond(
          "PUT",
          "/repos/ubiquity-sentinel/sentinel/pulls/1/merge",
          200,
          mergeResponseWire(SHA3),
        ),
      ],
    }));
    const result = await port.mergePullRequest(mergeRequest());
    assert.ok(result.ok, `${item.name}: ${JSON.stringify(result)}`);
    if (!result.ok) continue;
    assert.deepEqual(
      result.value,
      { outcome: "merged", head: SHA1, mergeSha: SHA3 },
      item.name,
    );
    assert.equal(putCount(transport), 1, item.name);
  }

  // The exact detail (matching id, source binding and active enforcement)
  // with no bypass actors resolves the omitted list policy: the exact
  // positive path is unchanged.
  const positive = mergedPort(happyScript({
    rulesets: [
      rulesetWire({ bypass_actors: null, current_user_can_bypass: null }),
    ],
    extra: [
      httpRespond("GET", detailUrl, 200, rulesetWire()),
      httpRespond(
        "PUT",
        "/repos/ubiquity-sentinel/sentinel/pulls/1/merge",
        200,
        mergeResponseWire(SHA3),
      ),
    ],
  }));
  const merged = await positive.port.mergePullRequest(mergeRequest());
  assert.ok(merged.ok);
  if (!merged.ok) return;
  assert.deepEqual(merged.value, {
    outcome: "merged",
    head: SHA1,
    mergeSha: SHA3,
  });
  assert.equal(putCount(positive.transport), 1);

  // Hosted shape: the exact active/source-bound detail omits `bypass_actors`
  // but explicitly reports `current_user_can_bypass: "never"`. The same
  // credential performs the merge, so never authorizes the exact expected-head
  // merge without inventing empty-list evidence.
  const neverOmitted = mergedPort(happyScript({
    rulesets: [
      rulesetWire({ bypass_actors: null, current_user_can_bypass: "never" }),
    ],
    extra: [
      httpRespond(
        "GET",
        detailUrl,
        200,
        rulesetWire({ bypass_actors: null, current_user_can_bypass: "never" }),
      ),
      httpRespond(
        "PUT",
        "/repos/ubiquity-sentinel/sentinel/pulls/1/merge",
        200,
        mergeResponseWire(SHA3),
      ),
    ],
  }));
  const mergedNeverOmitted = await neverOmitted.port.mergePullRequest(
    mergeRequest(),
  );
  assert.ok(mergedNeverOmitted.ok);
  if (!mergedNeverOmitted.ok) return;
  assert.deepEqual(mergedNeverOmitted.value, {
    outcome: "merged",
    head: SHA1,
    mergeSha: SHA3,
  });
  assert.equal(putCount(neverOmitted.transport), 1);
});

Deno.test("mergePullRequest: required checks must pass on the exact head", async () => {
  const pendingPort = mergedPort(happyScript({
    checks: [
      checkRunWire({ status: "queued", conclusion: null, completed_at: null }),
    ],
  }));
  const pending = await pendingPort.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(pending), "checks_pending");
  assert.equal(putCount(pendingPort.transport), 0);

  const failedPort = mergedPort(happyScript({
    checks: [checkRunWire({ name: "ci", conclusion: "failure" })],
  }));
  const failed = await failedPort.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(failed), "checks_failed");
  assert.equal(putCount(failedPort.transport), 0);

  // Empty CI: the required check is recorded but never ran → pending.
  const emptyPort = mergedPort(happyScript({ checks: [] }));
  const empty = await emptyPort.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(empty), "checks_pending");
  assert.equal(putCount(emptyPort.transport), 0);

  // Commit statuses are historical and returned newest-first. A newer
  // successful status for a context supersedes an older pending observation.
  const historicalPort = mergedPort(happyScript({
    checks: [checkRunWire({ name: "other" })],
    statuses: [
      commitStatusWire({
        context: "ci",
        state: "success",
        created_at: "2026-09-07T01:00:00Z",
        updated_at: "2026-09-07T01:01:00Z",
      }),
      commitStatusWire({
        context: "ci",
        state: "pending",
        created_at: "2026-09-07T00:00:00Z",
        updated_at: "2026-09-07T00:01:00Z",
      }),
    ],
    extra: [
      httpRespond(
        "PUT",
        "/repos/ubiquity-sentinel/sentinel/pulls/1/merge",
        200,
        mergeResponseWire(SHA3),
      ),
    ],
  }));
  const historical = await historicalPort.port.mergePullRequest(mergeRequest());
  assert.ok(historical.ok, JSON.stringify(historical));
  if (historical.ok) assert.equal(historical.value.outcome, "merged");

  // Legacy commit-status contexts share the required check namespace with
  // check-runs and must satisfy a required context when the run API has no
  // matching name.
  const legacyPort = mergedPort(happyScript({
    checks: [checkRunWire({ name: "other" })],
    statuses: [commitStatusWire({ context: "ci" })],
    extra: [
      httpRespond(
        "PUT",
        "/repos/ubiquity-sentinel/sentinel/pulls/1/merge",
        200,
        mergeResponseWire(SHA3),
      ),
    ],
  }));
  const legacy = await legacyPort.port.mergePullRequest(mergeRequest());
  assert.ok(legacy.ok, JSON.stringify(legacy));
  if (legacy.ok) assert.equal(legacy.value.outcome, "merged");
});

Deno.test("mergePullRequest: required approvals must be present", async () => {
  const approverRule = pullRequestRuleWire({
    parameters: {
      allowed_merge_methods: ["merge"],
      dismiss_stale_reviews_on_push: true,
      require_code_owner_review: false,
      require_last_push_approval: false,
      required_approving_review_count: 1,
      required_review_thread_resolution: false,
    },
  });
  const unapprovedPort = mergedPort(happyScript({
    rules: [statusChecksRuleWire(), approverRule, nonFastForwardRuleWire()],
    reviewDecision: "REVIEW_REQUIRED",
  }));
  const unapproved = await unapprovedPort.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(unapproved), "review_required");
  assert.equal(putCount(unapprovedPort.transport), 0);

  const approvedPort = mergedPort(happyScript({
    pulls: [
      pullEntry({ review_decision: "approved" }),
      pullEntry({ review_decision: "approved" }),
    ],
    rules: [statusChecksRuleWire(), approverRule, nonFastForwardRuleWire()],
    reviewDecision: "APPROVED",
    extra: [
      httpRespond(
        "PUT",
        "/repos/ubiquity-sentinel/sentinel/pulls/1/merge",
        200,
        mergeResponseWire(SHA3),
      ),
    ],
  }));
  const approved = await approvedPort.port.mergePullRequest(mergeRequest());
  assert.ok(approved.ok);
  if (!approved.ok) return;
  assert.deepEqual(approved.value, {
    outcome: "merged",
    head: SHA1,
    mergeSha: SHA3,
  });
  assert.equal(putCount(approvedPort.transport), 1);
});

Deno.test("mergePullRequest: candidate must contain the exact expected base", async () => {
  const git = new FakeGitExecutor();
  git.ancestryEvery = false;
  const { port, transport } = makePort({
    clock: CLOCK,
    script: happyScript(),
    review: trustedService(),
    git,
  });
  const result = await port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(result), "base_mismatch");
  assert.equal(putCount(transport), 0);
});

Deno.test("mergePullRequest: base movement after the last precheck is reconciled", async () => {
  const { port, transport } = mergedPort([
    pullEntry(),
    pullEntry(),
    reviewsRead([CLEAN_COMPLETION.review]),
    commentsRead([]),
    ...rulesRead(),
    ...checksRead(),
    baseTipRead(),
    // The base moved between the last base read and the merge PUT.
    httpRespond(
      "PUT",
      "/repos/ubiquity-sentinel/sentinel/pulls/1/merge",
      409,
      {},
    ),
    pullEntry({ base: { ref: "development", sha: SHA4 } }),
  ]);
  const result = await port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(result), "base_mismatch");
  assert.equal(putCount(transport), 1);
});

Deno.test("mergePullRequest: lost merge response reconciles exactly", async () => {
  // Lost PUT but the PR is now merged: reconciled to the exact merge SHA.
  const lostApplied = mergedPort(happyScript({
    extra: [
      {
        kind: "throw",
        method: "PUT",
        urlPart: "/repos/ubiquity-sentinel/sentinel/pulls/1/merge",
      },
      pullEntry({
        state: "closed",
        merged_at: "2026-09-07T02:00:00Z",
        merge_commit_sha: SHA3,
      }),
    ],
  }));
  const reconciled = await lostApplied.port.mergePullRequest(mergeRequest());
  assert.ok(reconciled.ok);
  if (!reconciled.ok) return;
  assert.deepEqual(reconciled.value, {
    outcome: "merged",
    head: SHA1,
    mergeSha: SHA3,
  });

  // Lost PUT and the PR is still open: ambiguous, never a blind retry.
  const stillOpen = mergedPort(happyScript({
    extra: [
      {
        kind: "throw",
        method: "PUT",
        urlPart: "/repos/ubiquity-sentinel/sentinel/pulls/1/merge",
      },
      pullEntry(),
    ],
  }));
  const ambiguous = await stillOpen.port.mergePullRequest(mergeRequest());
  assert.ok(ambiguous.ok);
  if (!ambiguous.ok) return;
  assert.deepEqual(ambiguous.value, {
    outcome: "ambiguous",
    head: null,
    mergeSha: null,
  });

  // Lost PUT AND the reconcile read fails: the effect stays ambiguous, never
  // an error and never "no effect".
  const noObservation = mergedPort([
    pullEntry(),
    pullEntry(),
    reviewsRead([CLEAN_COMPLETION.review]),
    commentsRead([]),
    ...rulesRead(),
    ...checksRead(),
    baseTipRead(),
    {
      kind: "throw",
      method: "PUT",
      urlPart: "/repos/ubiquity-sentinel/sentinel/pulls/1/merge",
    },
    {
      kind: "throw",
      method: "GET",
      urlPart: "/repos/ubiquity-sentinel/sentinel/pulls/1",
    },
  ]);
  const unobserved = await noObservation.port.mergePullRequest(mergeRequest());
  assert.ok(unobserved.ok);
  if (!unobserved.ok) return;
  assert.deepEqual(unobserved.value, {
    outcome: "ambiguous",
    head: null,
    mergeSha: null,
  });
});

Deno.test("mergePullRequest: malformed merge response is invalid, rejected maps by re-observation", async () => {
  const malformed = mergedPort(happyScript({
    extra: [
      httpRespond(
        "PUT",
        "/repos/ubiquity-sentinel/sentinel/pulls/1/merge",
        200,
        {
          merged: true,
          sha: "short",
        },
      ),
    ],
  }));
  const invalid = await malformed.port.mergePullRequest(mergeRequest());
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.kind, "invalid");

  // 405 with everything still in order and no re-check clue: after
  // re-observation the safe non-merge classification is a conflict block
  // (branch rules are no merge requirement, owner directive 2026-10-24).
  const rejected = mergedPort([
    pullEntry(),
    pullEntry(),
    reviewsRead([CLEAN_COMPLETION.review]),
    commentsRead([]),
    ...rulesRead(),
    ...checksRead(),
    baseTipRead(),
    httpRespond(
      "PUT",
      "/repos/ubiquity-sentinel/sentinel/pulls/1/merge",
      405,
      {},
    ),
    pullEntry(),
    ...checksRead(),
  ]);
  const blocked = await rejected.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(blocked), "conflict");
  assert.equal(putCount(rejected.transport), 1);
});

Deno.test("mergePullRequest: unreadable rules do not block; the merge proceeds with no effective protections", async () => {
  // Owner directive 2026-10-24: an unreadable rule policy is treated as no
  // protections (nothing required beyond the review gate), never as a block.
  // Classic branch protection is still never consulted. Each shape merges
  // exactly once on the exact head.
  const mergePut = httpRespond(
    "PUT",
    "/repos/ubiquity-sentinel/sentinel/pulls/1/merge",
    200,
    mergeResponseWire(SHA3),
  );
  const tipThenMerge = [baseTipRead(), mergeParentsRead(), mergePut];
  const expectMerged = (
    name: string,
    result: Awaited<ReturnType<typeof mergeCall>>,
  ) => {
    assert.ok(result.ok, `${name}: ${JSON.stringify(result)}`);
    if (!result.ok) return;
    assert.deepEqual(
      result.value,
      { outcome: "merged", head: SHA1, mergeSha: SHA3 },
      name,
    );
  };

  // The actual rules response is malformed: invalid policy, no protections.
  const malformed = mergedPort([
    pullEntry(),
    pullEntry(),
    reviewsRead([CLEAN_COMPLETION.review]),
    commentsRead([]),
    {
      ...httpRespond("GET", RULES_PATH, 200, [{ type: 7 }]),
      repeat: true,
    },
    httpRespond("GET", RULESETS_PATH, 200, [rulesetWire()]),
    ...checksRead(),
    ...tipThenMerge,
  ]);
  expectMerged(
    "malformed",
    await malformed.port.mergePullRequest(mergeRequest()),
  );
  assert.equal(putCount(malformed.transport), 1);

  // A rules read that fails on the wire (rate limit) is unavailable policy.
  const failed = mergedPort([
    pullEntry(),
    pullEntry(),
    reviewsRead([CLEAN_COMPLETION.review]),
    commentsRead([]),
    {
      ...httpRespond("GET", RULES_PATH, 403, { message: "rate limit" }, {
        "x-ratelimit-remaining": "0",
      }),
      repeat: true,
    },
    httpRespond("GET", RULESETS_PATH, 200, [rulesetWire()]),
    ...checksRead(),
    ...tipThenMerge,
  ]);
  expectMerged(
    "rate-limited",
    await failed.port.mergePullRequest(mergeRequest()),
  );
  assert.equal(putCount(failed.transport), 1);

  // A known rule type with unreadable parameters is unreadable policy.
  const badParams = mergedPort([
    pullEntry(),
    pullEntry(),
    reviewsRead([CLEAN_COMPLETION.review]),
    commentsRead([]),
    httpRespond("GET", RULES_PATH, 200, [
      statusChecksRuleWire({
        parameters: {
          required_status_checks: [{ context: 42 }],
          strict_required_status_checks_policy: true,
        },
      }),
      pullRequestRuleWire(),
    ]),
    httpRespond("GET", RULESETS_PATH, 200, [rulesetWire()]),
    ...checksRead(),
    ...tipThenMerge,
  ]);
  expectMerged(
    "bad-params",
    await badParams.port.mergePullRequest(mergeRequest()),
  );
  assert.equal(putCount(badParams.transport), 1);
});
