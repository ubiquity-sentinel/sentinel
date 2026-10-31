// mergePullRequest suite: exact-head merge authorization with authoritative
// re-observation of the current review (exact service-receipt binding and
// exact GitHub review id), authenticated human resolution, the P0-only
// blocking policy (owner directive 2026-10-24: branch rules are not a merge
// requirement and unresolved P1/P2/P3 findings never block), the required
// checks and approvals a target's rules do define, candidate base ancestry,
// exact merge response reconciliation and REST non-atomic base handling. All
// fixtures are synthetic and no real external service is contacted.
import {
  checkRunWire,
  commentWire,
  completedServiceRead,
  FakeResolutionVerifier,
  FakeReviewService,
  httpRespond,
  issueWire,
  makePort,
  mergeResponseWire,
  REPO,
  reviewDecisionGraphqlWire,
  reviewWire,
  SHA1,
  SHA2,
  SHA3,
  SHA4,
  structuredCompletedFixture,
  type StructuredReviewFixtureV1,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import type { ScriptEntry } from "./helpers.ts";
import type { ReviewTaskAcceptanceV1 } from "../../src/contracts/review-receipt.ts";
import { reviewOperationKey, reviewReceiptId } from "../../src/repair/keys.ts";
import {
  findingMessage,
  type ReviewResultV1,
} from "../../src/github/review-journal.ts";
import { asFindingFingerprint } from "../../src/contracts/brands.ts";
import { canonicalStringifySha256 } from "../../src/contracts/canonical.ts";
import {
  baseTipRead,
  blockedReason,
  checksRead,
  CLEAN_COMPLETION,
  CLEAN_OPERATION_KEY,
  CLEAN_RECEIPT_ID,
  CLOCK,
  commentsRead,
  completedCleanReceipt,
  happyScript,
  mergeCall,
  mergedPort,
  mergeParentsRead,
  mergeRequest,
  pullEntry,
  putCount,
  reviewsRead,
  rulesRead,
} from "./merge-helpers.ts";

Deno.test("mergePullRequest: exact-head merge after full authoritative verification", async () => {
  const { port, transport } = mergedPort(happyScript({
    extra: [
      httpRespond(
        "PUT",
        "/repos/ubiquity-sentinel/sentinel/pulls/1/merge",
        200,
        mergeResponseWire(SHA3),
      ),
    ],
  }));
  const result = await mergeCall(port);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.value, {
    outcome: "merged",
    head: SHA1,
    mergeSha: SHA3,
  });
  assert.equal(putCount(transport), 1);
  const put = transport.requests.find((request) => request.method === "PUT");
  assert.ok(put !== undefined);
  assert.deepEqual(JSON.parse(put.body ?? "{}"), { sha: SHA1 });
  const rulesRequest = transport.requests.find((request) =>
    request.url.includes("/rules/branches/development")
  );
  assert.ok(rulesRequest !== undefined);
  const rulesetsRequest = transport.requests.find((request) =>
    request.url.includes("/rulesets?")
  );
  assert.ok(rulesetsRequest !== undefined);
});

Deno.test("mergePullRequest: a published closing link requires the exact bound task acceptance", async () => {
  const issueNumber = 7;
  const boundDigest = await reviewTaskStatementDigest({
    issueNumber,
    title: "an issue",
    body: "issue body",
  });
  // Every positive fixture publishes the exact same structured completion the
  // receipt carries (copied-receipt equality is NOT the authorization), while
  // the PR's own body names the issue that must now be read live.
  const scriptFor = (
    completion: StructuredReviewFixtureV1,
    issueEntries: ScriptEntry[],
    put: boolean,
  ): ScriptEntry[] => [
    pullEntry({ body: `Resolves #${issueNumber}` }),
    pullEntry({ body: `Resolves #${issueNumber}` }),
    reviewsRead([completion.review]),
    commentsRead([]),
    ...rulesRead(),
    ...checksRead([checkRunWire()], false, []),
    {
      ...httpRespond(
        "POST",
        "/graphql",
        200,
        reviewDecisionGraphqlWire("APPROVED"),
      ),
      repeat: true,
    },
    ...issueEntries,
    baseTipRead(),
    mergeParentsRead(),
    ...(put
      ? [
        httpRespond(
          "PUT",
          "/repos/ubiquity-sentinel/sentinel/pulls/1/merge",
          200,
          mergeResponseWire(SHA3),
        ),
      ]
      : []),
  ];
  const portFor = (
    completion: StructuredReviewFixtureV1,
    issueEntries: ScriptEntry[],
    put = false,
  ) => {
    const service = new FakeReviewService();
    service.readResult = completion.service;
    return makePort({
      clock: CLOCK,
      script: scriptFor(completion, issueEntries, put),
      review: service,
    });
  };
  const completionFor = (taskAcceptance: ReviewTaskAcceptanceV1) =>
    structuredCompletedFixture({
      operationKey: CLEAN_OPERATION_KEY,
      result: {
        verdict: "clean",
        summary: "no issues found",
        findings: [],
        taskAcceptance,
      },
    });
  const issueRead = () => httpRespond("GET", "/issues/7", 200, issueWire());

  // An issue-backed PR whose receipt carries NO acceptance (a change-only
  // code-quality pass) is refused before the merge mutation.
  const missingAcceptance = portFor(CLEAN_COMPLETION, [issueRead()]);
  const missingResult = await missingAcceptance.port.mergePullRequest(
    mergeRequest(),
  );
  assert.equal(blockedReason(missingResult), "review_required");
  assert.equal(putCount(missingAcceptance.transport), 0);

  // Same issue, same head, receipt and journal copies agree, but the bound
  // text is NOT the live issue text: the adapter's own read authorizes.
  const wrongTextAcceptance: ReviewTaskAcceptanceV1 = {
    issueNumber,
    taskDigest: "a".repeat(64),
    verdict: "fulfilled",
    evidence: ["the candidate satisfies the text the reviewer was shown"],
  };
  const wrongText = portFor(
    await completionFor(wrongTextAcceptance),
    [issueRead()],
  );
  const wrongResult = await wrongText.port.mergePullRequest(mergeRequest({
    review: completedCleanReceipt({ taskAcceptance: wrongTextAcceptance }),
  }));
  assert.equal(blockedReason(wrongResult), "review_required");
  assert.equal(putCount(wrongText.transport), 0);

  // An acceptance naming a different issue than the published link is refused.
  const wrongIssueAcceptance: ReviewTaskAcceptanceV1 = {
    issueNumber: 8,
    taskDigest: boundDigest,
    verdict: "fulfilled",
    evidence: ["bound to another issue"],
  };
  const wrongIssue = portFor(
    await completionFor(wrongIssueAcceptance),
    [issueRead()],
  );
  const wrongIssueResult = await wrongIssue.port.mergePullRequest(
    mergeRequest({
      review: completedCleanReceipt({
        taskAcceptance: wrongIssueAcceptance,
      }),
    }),
  );
  assert.equal(blockedReason(wrongIssueResult), "review_required");
  assert.equal(putCount(wrongIssue.transport), 0);

  // The exact positive acceptance bound to the live issue text merges once.
  const alignedAcceptance: ReviewTaskAcceptanceV1 = {
    issueNumber,
    taskDigest: boundDigest,
    verdict: "fulfilled",
    evidence: ["the candidate implements the issue requirements"],
  };
  const aligned = portFor(
    await completionFor(alignedAcceptance),
    [issueRead()],
    true,
  );
  const alignedResult = await aligned.port.mergePullRequest(mergeRequest({
    review: completedCleanReceipt({ taskAcceptance: alignedAcceptance }),
  }));
  assert.ok(alignedResult.ok);
  if (!alignedResult.ok) return;
  assert.equal(alignedResult.value.outcome, "merged");
  assert.equal(putCount(aligned.transport), 1);

  // An unreadable issue context fails closed as a retryable port error: no
  // merge is attempted on missing evidence.
  const unreadable = portFor(await completionFor(alignedAcceptance), [
    httpRespond("GET", "/issues/7", 500, { message: "server error" }),
  ]);
  const unreadableResult = await unreadable.port.mergePullRequest(
    mergeRequest({
      review: completedCleanReceipt({ taskAcceptance: alignedAcceptance }),
    }),
  );
  assert.equal(unreadableResult.ok, false);
  assert.equal(putCount(unreadable.transport), 0);
});

Deno.test("mergePullRequest: head/base/author/closed checks fail closed with zero merge calls", async () => {
  // The request stays self-consistent; the authoritative PR differs. Each
  // case fails before the review/protection gate with no merge attempt.
  const headMoved = mergedPort([
    pullEntry({ head: { ref: "sentinel/fix-1", sha: SHA3 } }),
  ]);
  const headMismatch = await headMoved.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(headMismatch), "head_mismatch");
  assert.equal(putCount(headMoved.transport), 0);

  const baseMoved = mergedPort([
    pullEntry({ base: { ref: "development", sha: SHA4 } }),
  ]);
  const baseMismatch = await baseMoved.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(baseMismatch), "base_mismatch");
  assert.equal(putCount(baseMoved.transport), 0);

  const humanPort = mergedPort([pullEntry({ user: { login: "octocat" } })]);
  const human = await humanPort.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(human), "conflict");
  assert.equal(putCount(humanPort.transport), 0);

  const closedPort = mergedPort([
    pullEntry({ state: "closed", merged_at: null, merge_commit_sha: null }),
  ]);
  const closed = await closedPort.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(closed), "conflict");
  assert.equal(putCount(closedPort.transport), 0);

  const missingPort = mergedPort([
    httpRespond("GET", "/repos/ubiquity-sentinel/sentinel/pulls/404", 404, {}),
  ]);
  const missing = await missingPort.port.mergePullRequest(mergeRequest({
    pullRequestNumber: 404,
    review: completedCleanReceipt({
      pullRequest: { number: 404, head: SHA1, base: SHA2 },
    }),
  }));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.kind, "not_found");
  assert.equal(putCount(missingPort.transport), 0);
});

Deno.test("mergePullRequest: already-merged PR reconciles to the exact merge identity", async () => {
  const { port } = mergedPort([
    pullEntry({
      state: "closed",
      merged_at: "2026-09-07T02:00:00Z",
      merge_commit_sha: SHA3,
    }),
    mergeParentsRead(),
  ]);
  const result = await port.mergePullRequest(mergeRequest());
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.value, {
    outcome: "merged",
    head: SHA1,
    mergeSha: SHA3,
  });
});

Deno.test("mergePullRequest: malformed or unverifiable requests are invalid", async () => {
  const { port } = mergedPort(happyScript());
  // An unresolved P0 is the only severity the request contract refuses (owner
  // directive 2026-10-24); an unresolved P1 merges, see the next test.
  const unresolved = await port.mergePullRequest(mergeRequest({
    review: completedCleanReceipt({
      findings: [{
        id: "github-comment-500",
        severity: "P0",
        path: "src/main.ts",
        message: "[P0] committed data is lost",
        fingerprint: "a".repeat(64),
        resolved: false,
        resolutionEvidence: null,
      }],
      unresolvedSeverities: ["P0"],
    }),
  }));
  assert.equal(unresolved.ok, false);
  if (!unresolved.ok) assert.equal(unresolved.error.kind, "invalid");

  const wrongReviewer = await port.mergePullRequest(mergeRequest({
    review: completedCleanReceipt({
      expectedReviewer: "coderabbitai[bot]",
      observedReviewer: "coderabbitai[bot]",
    }),
  }));
  assert.equal(wrongReviewer.ok, false);
  if (!wrongReviewer.ok) assert.equal(wrongReviewer.error.kind, "invalid");

  const wrongRepo = await port.mergePullRequest(mergeRequest({
    review: completedCleanReceipt({
      repository: { owner: "other", name: "repo", installationId: 2 },
    }),
  }));
  assert.equal(wrongRepo.ok, false);
  if (!wrongRepo.ok) assert.equal(wrongRepo.error.kind, "invalid");
});

Deno.test("mergePullRequest: unresolved P1 findings never block the exact-head merge", async () => {
  // Owner directive 2026-10-24: the only internal policy is that every P0 is
  // resolved. The authoritative evidence is one structured journal carrying an
  // unresolved P1 finding; the request receipt carries the same finding
  // unresolved, and the merge proceeds exactly as a clean review would.
  const evidenceResult: ReviewResultV1 = {
    verdict: "findings",
    summary: "one important finding",
    findings: [{
      priority: 1,
      title: "Broken error handling",
      body: "The error path swallows the failure.",
      path: "src/main.ts",
      lineStart: 1,
      lineEnd: 1,
    }],
  };
  const evidence = await structuredCompletedFixture({
    result: evidenceResult,
    operationKey: CLEAN_OPERATION_KEY,
  });
  const findingBase = {
    id: "github-review-100-finding-0",
    severity: "P1",
    path: "src/main.ts",
    message: findingMessage(evidenceResult.findings[0]),
  };
  const service = new FakeReviewService();
  service.readResult = evidence.service;
  const { port, transport } = makePort({
    clock: CLOCK,
    script: [
      pullEntry(),
      pullEntry(),
      reviewsRead([evidence.review]),
      commentsRead([]),
      ...rulesRead(),
      ...checksRead(),
      baseTipRead(),
      mergeParentsRead(),
      httpRespond(
        "PUT",
        "/repos/ubiquity-sentinel/sentinel/pulls/1/merge",
        200,
        mergeResponseWire(SHA3),
      ),
    ],
    review: service,
  });
  const result = await port.mergePullRequest(mergeRequest({
    review: completedCleanReceipt({
      summary: evidenceResult.summary,
      findings: [{
        ...findingBase,
        fingerprint: asFindingFingerprint(
          await canonicalStringifySha256(findingBase),
        ),
        resolved: false,
        resolutionEvidence: null,
      }],
      unresolvedSeverities: ["P1"],
    }),
  }));
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(result.value, {
    outcome: "merged",
    head: SHA1,
    mergeSha: SHA3,
  });
  assert.equal(putCount(transport), 1);
});

Deno.test("mergePullRequest: authoritative review must be current and match exactly", async () => {
  // The service reports the request as pending: blocking, not merging.
  const service = new FakeReviewService();
  service.readResult = completedServiceRead({
    operationKey: CLEAN_OPERATION_KEY,
    status: "pending",
    resultId: null,
    completedAt: null,
    terminalTurnSucceeded: false,
    outputPresent: false,
  });
  const pendingPort = makePort({
    clock: CLOCK,
    script: happyScript(),
    review: service,
  });
  const pending = await pendingPort.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(pending), "review_required");
  assert.equal(putCount(pendingPort.transport), 0);

  // A completed service read but an UNKNOWN GitHub finding (unparseable
  // badge): the normalization is unavailable and never authorizes.
  const unknownPort = mergedPort([
    pullEntry(),
    pullEntry(),
    reviewsRead([
      reviewWire({
        id: 100,
        state: "COMMENTED",
        body: "Review findings below",
      }),
    ]),
    commentsRead([commentWire({
      id: 500,
      body: "![P1 Badge](https://example.invalid/P1) Fix credential exposure",
    })]),
    ...rulesRead(),
    ...checksRead(),
  ]);
  const unknown = await unknownPort.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(unknown), "review_required");
  assert.equal(putCount(unknownPort.transport), 0);

  // The GitHub evidence contains a P1 finding but the request receipt is
  // clean: the finding set must match the authoritative normalization.
  const mismatchPort = mergedPort([
    pullEntry(),
    pullEntry(),
    reviewsRead([
      reviewWire({ id: 100, state: "CHANGES_REQUESTED", body: null }),
    ]),
    commentsRead([
      commentWire({ id: 500, body: "[P1] broken error handling" }),
    ]),
    ...rulesRead(),
    ...checksRead(),
  ]);
  const mismatch = await mismatchPort.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(mismatch), "review_required");
  assert.equal(putCount(mismatchPort.transport), 0);
});

Deno.test("mergePullRequest: wrong service receipt binding never authorizes", async () => {
  const cases: {
    name: string;
    override: Parameters<typeof completedServiceRead>[0];
  }[] = [
    {
      name: "wrong-operation-key",
      override: { operationKey: reviewOperationKey(1, SHA2) },
    },
    { name: "wrong-pr", override: { prNumber: 2 } },
    { name: "wrong-head", override: { expectedHead: SHA3 } },
    { name: "wrong-base", override: { expectedBase: SHA3 } },
    {
      name: "wrong-reviewer",
      override: { expectedReviewer: "coderabbitai[bot]" },
    },
    {
      name: "wrong-repository",
      override: {
        repository: { owner: "other", name: "repo", installationId: 2 },
      },
    },
    { name: "wrong-review-id", override: { githubReviewId: 999 } },
    { name: "missing-base", override: { expectedBase: null } },
  ];
  for (const item of cases) {
    const service = new FakeReviewService();
    service.readResult = completedServiceRead({
      operationKey: CLEAN_OPERATION_KEY,
      ...item.override,
    });
    const { port, transport } = makePort({
      clock: CLOCK,
      script: happyScript(),
      review: service,
    });
    const result = await port.mergePullRequest(mergeRequest());
    assert.equal(blockedReason(result), "review_required", item.name);
    assert.equal(putCount(transport), 0, item.name);
  }
});

Deno.test("mergePullRequest: the opaque canonical receipt id is not the operation key", async () => {
  // The loop receipt id is an opaque digest, not a reversible encoding of the
  // operation key; the exact PR/head key must still authorize the real merge.
  assert.match(CLEAN_RECEIPT_ID, /^review-receipt:[0-9a-f]{64}$/);
  assert.ok(!CLEAN_RECEIPT_ID.includes(CLEAN_OPERATION_KEY));
  const { port, transport } = mergedPort(happyScript({
    extra: [
      httpRespond(
        "PUT",
        "/repos/ubiquity-sentinel/sentinel/pulls/1/merge",
        200,
        mergeResponseWire(SHA3),
      ),
    ],
  }));
  const merged = await mergeCall(port);
  assert.ok(merged.ok);
  if (!merged.ok) return;
  assert.equal(merged.value.outcome, "merged");
  assert.equal(
    putCount(transport),
    1,
    "the exact operation authorized one PUT",
  );

  // A different operation key never authorizes, with zero merge writes.
  const wrongService = new FakeReviewService();
  wrongService.readResult = completedServiceRead({
    operationKey: reviewOperationKey(1, SHA2),
  });
  const wrong = makePort({
    clock: CLOCK,
    script: happyScript(),
    review: wrongService,
  });
  const blocked = await mergeCall(wrong.port);
  assert.equal(blockedReason(blocked), "review_required");
  assert.equal(putCount(wrong.transport), 0);
});

Deno.test(
  "mergePullRequest: a bounded later attempt of the same head authorizes the merge",
  async () => {
    // The durable loop may consume more than one review round for one exact
    // head (a round that concluded without an accepted verdict is recovered as
    // its own bounded attempt). The receipt of the attempt that actually
    // produced the verdict names its own record identity, and the merge gate
    // must bind to exactly that record — never to the first attempt's identity
    // and never to another attempt's record.
    const attemptKey = `${CLEAN_OPERATION_KEY}:attempt-2`;
    const completion = await structuredCompletedFixture({
      operationKey: attemptKey,
      requestId: `review-${attemptKey}`,
    });
    const service = new FakeReviewService();
    service.readResult = completion.service;
    const { port, transport } = makePort({
      clock: CLOCK,
      script: [
        pullEntry(),
        pullEntry(),
        reviewsRead([completion.review]),
        commentsRead([]),
        ...rulesRead(),
        ...checksRead([checkRunWire()]),
        {
          ...httpRespond(
            "POST",
            "/graphql",
            200,
            reviewDecisionGraphqlWire("APPROVED"),
          ),
          repeat: true,
        },
        baseTipRead(),
        mergeParentsRead(),
        httpRespond(
          "PUT",
          "/repos/ubiquity-sentinel/sentinel/pulls/1/merge",
          200,
          mergeResponseWire(SHA3),
        ),
      ],
      review: service,
    });
    const merged = await mergeCall(
      port,
      mergeRequest({
        review: completedCleanReceipt({
          id: await reviewReceiptId(attemptKey, SHA1),
          requestId: `review-${attemptKey}`,
        }),
      }),
    );
    assert.ok(merged.ok, JSON.stringify(merged));
    if (!merged.ok) return;
    assert.equal(merged.value.outcome, "merged");
    assert.equal(
      putCount(transport),
      1,
      "the accepted later attempt authorized exactly one PUT",
    );

    // The same receipt against the FIRST attempt's standing record: the round
    // identity differs, so nothing authorizes the merge.
    const staleService = new FakeReviewService();
    staleService.readResult = CLEAN_COMPLETION.service;
    const stale = makePort({
      clock: CLOCK,
      script: happyScript(),
      review: staleService,
    });
    const staleResult = await mergeCall(
      stale.port,
      mergeRequest({
        review: completedCleanReceipt({
          id: await reviewReceiptId(attemptKey, SHA1),
          requestId: `review-${attemptKey}`,
        }),
      }),
    );
    assert.equal(blockedReason(staleResult), "review_required");
    assert.equal(putCount(stale.transport), 0);

    // A record identity that binds ANOTHER head never authorizes this head,
    // even when the standing record answers for it exactly.
    const foreignKey = `review:1:${SHA3}:attempt-2`;
    const foreignService = new FakeReviewService();
    foreignService.readResult = completedServiceRead({
      operationKey: foreignKey,
      requestId: `review-${foreignKey}`,
      expectedHead: SHA1,
    });
    const foreign = makePort({
      clock: CLOCK,
      script: happyScript(),
      review: foreignService,
    });
    const foreignResult = await mergeCall(
      foreign.port,
      mergeRequest({
        review: completedCleanReceipt({
          id: await reviewReceiptId(foreignKey, SHA1),
          requestId: `review-${foreignKey}`,
        }),
      }),
    );
    assert.equal(blockedReason(foreignResult), "review_required");
    assert.equal(putCount(foreign.transport), 0);
  },
);

Deno.test("mergePullRequest: human resolution requires the trusted authenticated resolver", async () => {
  // The authoritative GitHub evidence is one structured journal carrying the
  // same P0 finding the request receipt resolves.
  const evidenceResult: ReviewResultV1 = {
    verdict: "findings",
    summary: "data loss",
    findings: [{
      priority: 0,
      title: "Data loss",
      body: "The change loses committed data.",
      path: "src/main.ts",
      lineStart: 1,
      lineEnd: 1,
    }],
  };
  const evidenceFixture = await structuredCompletedFixture({
    result: evidenceResult,
    operationKey: CLEAN_OPERATION_KEY,
  });
  const findingBase = {
    id: "github-review-100-finding-0",
    severity: "P0",
    path: "src/main.ts",
    message: findingMessage(evidenceResult.findings[0]),
  };
  const realFingerprint = asFindingFingerprint(
    await canonicalStringifySha256(findingBase),
  );
  const resolvedFinding = {
    ...findingBase,
    fingerprint: realFingerprint,
    resolved: true,
    resolutionEvidence: {
      authorizingIdentity: "some-human",
      reference: "resolution-ref:12345",
    },
  };
  const evidenceScript: ScriptEntry[] = [
    pullEntry(),
    pullEntry(),
    reviewsRead([evidenceFixture.review]),
    commentsRead([]),
    ...rulesRead([], []), // No active rules: no required checks or approvals.
    ...checksRead(),
  ];
  const evidenceService = (): FakeReviewService => {
    const service = new FakeReviewService();
    service.readResult = evidenceFixture.service;
    return service;
  };
  const resolvedRequest = () =>
    mergeRequest({
      review: completedCleanReceipt({
        summary: evidenceResult.summary,
        findings: [resolvedFinding],
        unresolvedSeverities: [],
      }),
    });

  // Author allowlist alone is never authentication: without the resolver
  // integration every resolved finding fail closes.
  const allowlistOnly = makePort({
    clock: CLOCK,
    script: evidenceScript,
    review: evidenceService(),
    trustedResolutionAuthors: ["some-human"],
  });
  const noVerifier = await allowlistOnly.port.mergePullRequest(
    resolvedRequest(),
  );
  assert.equal(blockedReason(noVerifier), "review_required");
  assert.equal(putCount(allowlistOnly.transport), 0);

  // A resolver that does not authenticate (unverified) is also insufficient.
  const unverifiedPort = makePort({
    clock: CLOCK,
    script: evidenceScript,
    review: evidenceService(),
    trustedResolutionAuthors: ["some-human"],
    resolutionVerifier: new FakeResolutionVerifier(false, "some-human"),
  });
  const denied = await unverifiedPort.port.mergePullRequest(resolvedRequest());
  assert.equal(blockedReason(denied), "review_required");
  assert.equal(putCount(unverifiedPort.transport), 0);

  // The resolver must authenticate the exact recorded authorizing identity.
  const wrongIdentityPort = makePort({
    clock: CLOCK,
    script: evidenceScript,
    review: evidenceService(),
    trustedResolutionAuthors: ["some-human"],
    resolutionVerifier: new FakeResolutionVerifier(true, "other-human"),
  });
  const noIdentity = await wrongIdentityPort.port.mergePullRequest(
    resolvedRequest(),
  );
  assert.equal(blockedReason(noIdentity), "review_required");
  assert.equal(putCount(wrongIdentityPort.transport), 0);

  // A forged finding fingerprint is recomputed and rejected.
  const forgedPort = makePort({
    clock: CLOCK,
    script: evidenceScript,
    review: evidenceService(),
    trustedResolutionAuthors: ["some-human"],
    resolutionVerifier: new FakeResolutionVerifier(true, "some-human"),
  });
  const forgedResult = await forgedPort.port.mergePullRequest(mergeRequest({
    review: completedCleanReceipt({
      summary: evidenceResult.summary,
      findings: [{ ...resolvedFinding, fingerprint: "c".repeat(64) }],
      unresolvedSeverities: [],
    }),
  }));
  assert.equal(blockedReason(forgedResult), "review_required");
  assert.equal(putCount(forgedPort.transport), 0);

  // Trusted authenticated resolver + allowlisted identity: the review gate
  // passes and, branch rules being no merge requirement (owner directive
  // 2026-10-24), the exact-head merge proceeds with no active rules.
  const verifier = new FakeResolutionVerifier(true, "some-human");
  const trustedPort = makePort({
    clock: CLOCK,
    script: [
      ...evidenceScript,
      baseTipRead(),
      mergeParentsRead(),
      httpRespond(
        "PUT",
        "/repos/ubiquity-sentinel/sentinel/pulls/1/merge",
        200,
        mergeResponseWire(SHA3),
      ),
    ],
    review: evidenceService(),
    trustedResolutionAuthors: ["some-human"],
    resolutionVerifier: verifier,
  });
  const gate = await trustedPort.port.mergePullRequest(resolvedRequest());
  assert.ok(gate.ok, JSON.stringify(gate));
  if (!gate.ok) return;
  assert.deepEqual(gate.value, {
    outcome: "merged",
    head: SHA1,
    mergeSha: SHA3,
  });
  assert.equal(putCount(trustedPort.transport), 1);
  assert.equal(verifier.checks.length, 1);
  const check = verifier.checks[0];
  assert.deepEqual(check.repository, REPO);
  assert.equal(check.prNumber, 1);
  assert.equal(check.head, SHA1);
  assert.equal(check.authorizingIdentity, "some-human");
  assert.equal(check.reference, "resolution-ref:12345");
  assert.equal(check.findingFingerprint, realFingerprint);
});
