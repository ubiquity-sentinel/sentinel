/** Candidate preservation, republication and recovered replay transports. */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import {
  CalendarCiMinutes,
  proposedCiMinutePolicy,
} from "../../src/budget/ci-minutes.ts";
import {
  type CiEffectV1,
  type CiMinuteControllerV1,
  ciMinuteDigest,
  type CiMinuteJobProofV1,
  type CiMinuteLedgerV1,
  ciMonth,
  ciPolicyDigest,
  ciTerminalEstimateDigest,
  parseCiMinuteLedger,
  validateCiMinuteTransition,
} from "../../src/contracts/ci-minute-budget.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { createPrivateCiEffectResolver } from "../../ops/hosted-autonomy-github-jobs.ts";
import type { GitHubPullRequestV1 } from "../../src/contracts/ports.ts";
import {
  candidateBranch,
  candidatePreservationRef,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import { REPO, SHA1, SHA2, SHA3, T0, workRecord } from "../state/helpers.ts";
import { LOCAL_SENTINEL_REPO, makeRig, seededSnapshot } from "./loop-rig.ts";
import {
  CHECK_POLL_MS,
  exactOpenPr,
  H0,
  H1,
  positiveLifecycle,
  preservedIssueWork,
  PRODUCING_RESERVATION,
} from "./loop-candidate-fixtures.ts";

for (const boundary of ["fixture", "original replay"] as const) {
  Deno.test(
    `lifecycle94: recovered ${boundary} transport is observed again after the existing poll interval`,
    async () => {
      const rig = await makeRig(`retry94-${boundary.replaceAll(" ", "-")}`, {
        github: { candidateLifecycle: positiveLifecycle() },
      });
      try {
        let unavailable = true;
        let observations = 0;
        const resolve = rig.replay.resolveTestIds.bind(rig.replay);
        const replay = rig.replay.runReplay.bind(rig.replay);
        rig.replay.resolveTestIds = (ref, digest) => {
          if (boundary !== "fixture") return resolve(ref, digest);
          observations++;
          if (!unavailable) return resolve(ref, digest);
          rig.clock.advance(CHECK_POLL_MS + 17);
          return Promise.resolve(
            portError("unavailable", "fixture transport unavailable"),
          );
        };
        rig.replay.runReplay = (request) => {
          if (boundary !== "original replay" || request.revision !== SHA2) {
            return replay(request);
          }
          observations++;
          if (!unavailable) return replay(request);
          rig.clock.advance(CHECK_POLL_MS + 17);
          return Promise.resolve(
            portError("unavailable", "original replay transport unavailable"),
          );
        };
        await rig.run();
        const parked = await rig.snapshot();
        const record = parked.work[0]!;
        assert.equal(observations, 1);
        assert.equal(record.wait?.reason, "unavailable");
        assert.equal(rig.model.requests.length, 0);
        assert.equal(parked.reservations.length, 0);
        const evidence = structuredClone(parked.evidence);
        const target = structuredClone(record.target);
        unavailable = false;
        rig.clock.advance(CHECK_POLL_MS + 1);
        const outcome = await rig.run();
        assert.ok(
          observations > 1,
          `recovered ${boundary} must be retried: ${JSON.stringify(outcome)}`,
        );
        assert.equal(record.wait?.until, record.wait!.since + CHECK_POLL_MS);
        assert.equal(
          record.wait?.since,
          T0 + CHECK_POLL_MS + 17,
          "retry starts from the completed failed observation",
        );
        const recovered = await rig.snapshot();
        assert.deepEqual(recovered.evidence, evidence);
        assert.equal(recovered.work[0]!.target.base, target.base);
        assert.equal(
          rig.model.requests.length,
          1,
          "one normal admission after evidence recovers",
        );
        assert.equal(recovered.work[0]!.nextStep, "review");
      } finally {
        await rig.ctx.cleanup();
      }
    },
  );
}

Deno.test("CI round3 authenticated retirement gives replacement publication a distinct durable identity with stable retries", async () => {
  const record = preservedIssueWork("issue-1", H1),
    branch = candidateBranch(record.id),
    blob = "c".repeat(40);
  const effects: CiEffectV1[] = [];
  const ciMinutes: CiMinuteControllerV1 = {
    active: true,
    reserve: (effect, deadline) => {
      effects.push(structuredClone(effect));
      return controller.reserve(effect, deadline);
    },
  };
  const rig = await makeRig("synthetic-replacement-accounting", {
    summaries: false,
    ciMinutes,
    github: {
      candidateLifecycle: {
        ...positiveLifecycle(),
        refs: { [`refs/heads/${branch}`]: H1 },
        pullRequests: [{ ...exactOpenPr(7, H1, branch), state: "closed" }],
      },
    },
  });
  const policy = {
    ...proposedCiMinutePolicy(),
    activated: true,
    storageAcceptance: "a".repeat(64),
    ceilingQualification: "b".repeat(64),
    targets: [{
      owner: record.repository.owner,
      name: record.repository.name,
      repositoryId: 101,
      ceilingMinutes: 25,
    }],
  };
  const original: CiEffectV1 = {
    repository: record.repository,
    kind: "pr_open",
    head: H1,
    base: record.target.base,
    ref: `refs/heads/${branch}`,
    pr: null,
  };
  const firstId = ciMinuteDigest({
    domain: "sentinel-ci-effect-v1",
    effect: original,
    workflowBlob: blob,
    job: "validation",
    repositoryId: 101,
  });
  const proof: CiMinuteJobProofV1 = {
    digest: ciMinuteDigest({ syntheticJob: 1 }),
    effectDigest: firstId,
    startedAt: T0 - 60000,
    completedAt: T0 - 1000,
    neverStarted: false,
    terminal: true,
    conclusion: "success",
    billedDurationMs: 0,
    estimate: {
      kind: "retained_estimate",
      minutes: 25,
      executionMonth: ciMonth(T0).month,
      terminalProofDigest: "",
    },
  };
  proof.estimate!.terminalProofDigest = ciTerminalEstimateDigest(proof);
  let ledger: CiMinuteLedgerV1 = {
    version: 1,
    month: ciMonth(T0).month,
    policyDigest: ciPolicyDigest(policy),
    updatedAt: T0,
    sequence: 1,
    baselineMinutes: 0,
    watermark: null,
    reservations: [{
      effectDigest: firstId,
      policyDigest: ciPolicyDigest(policy),
      ceilingMinutes: 25,
      state: "terminal_estimated",
      createdAt: T0 - 61000,
      settledAt: T0 - 1000,
      chargedMinutes: 25,
      proofDigest: proof.estimate!.terminalProofDigest,
      accounting: {
        kind: "retained_estimate",
        executionMonth: ciMonth(T0).month,
        terminalProofDigest: proof.estimate!.terminalProofDigest,
        startedAt: proof.startedAt,
        completedAt: proof.completedAt,
      },
      binding: {
        effect: original,
        repositoryId: 101,
        workflowBlob: blob,
        job: "validation",
      },
    }],
    observed: [{ digest: proof.digest, effectDigest: firstId, minutes: 25 }],
    proofs: [proof],
  };
  let stateHead = "1".repeat(40) as GitSha, sequence = 1;
  const controller = new CalendarCiMinutes({
    policy,
    clock: rig.clock,
    authorizePolicy: (basis, _deadline, facts) =>
      Promise.resolve(
        ciPolicyDigest(basis) === ciPolicyDigest(policy) &&
          (facts === undefined ||
            facts.workflowBlob === blob && facts.job === "validation" &&
              facts.timeoutMinutes === 20 && facts.runner === "ubuntu-latest"),
      ),
    resolve: createPrivateCiEffectResolver({
      policy,
      request: (path) =>
        Promise.resolve(
          path.includes("/contents/")
            ? {
              type: "file",
              encoding: "base64",
              sha: blob,
              content: btoa(
                "on: [pull_request]\njobs:\n  validation:\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    steps:\n      - run: true\n",
              ),
            }
            : path.includes("/pulls?")
            ? [...rig.github.candidatePullRequests.values()].filter((pull) =>
              pull.state === "open"
            ).map((pull) => ({ number: pull.number, head: { sha: pull.head } }))
            : { id: 101, private: true, default_branch: "development" },
        ),
    }),
    observe: (month) =>
      Promise.resolve({
        month,
        complete: true,
        watermark: rig.clock.now(),
        jobs: [],
      }),
    store: {
      read: () =>
        Promise.resolve(
          portOk({ head: stateHead, ledger: structuredClone(ledger) }),
        ),
      readPrior: () =>
        Promise.resolve(portOk({ head: stateHead, ledger: null })),
      write(input) {
        assert.equal(input.expectedHead, stateHead);
        const next = parseCiMinuteLedger(input.ledger);
        validateCiMinuteTransition(ledger, next);
        ledger = next;
        stateHead = String(++sequence).padStart(40, "0") as GitSha;
        return Promise.resolve(
          portOk({ status: "applied" as const, head: stateHead }),
        );
      },
    },
  });
  const create = rig.github.createPullRequest.bind(rig.github);
  // Match the real adapter: prefer a unique open PR, otherwise retain its
  // conservative single-closed-row/ambiguity behavior for recovery reads.
  rig.github.findPullRequestByHeadRef = (ref) => {
    const matches = [...rig.github.candidatePullRequests.values()].filter((
      pull,
    ) => pull.headRef === ref);
    const open = matches.filter((pull) => pull.state === "open");
    return Promise.resolve(
      open.length === 1
        ? portOk(open[0])
        : open.length > 1
        ? portError("conflict", "synthetic multiple open PRs")
        : matches.length === 1
        ? portOk(matches[0])
        : matches.length === 0
        ? portOk(null)
        : portError("conflict", "synthetic multiple closed PRs"),
    );
  };
  let allowed = false, lostAck = true, attempts = 0;
  rig.github.createPullRequest = async (
    ...args: Parameters<typeof rig.github.createPullRequest>
  ) => {
    attempts++;
    if (!allowed) return portError("unavailable", "synthetic before mutation");
    const created = await create(...args);
    if (created.ok && lostAck) {
      lostAck = false;
      return portError("unavailable", "synthetic acknowledgement loss");
    }
    return created;
  };
  const advance = async () => {
    const work = (await rig.snapshot()).work[0];
    rig.clock.advance(
      Math.max(1, (work.wait?.until ?? rig.clock.now()) - rig.clock.now() + 1),
    );
  };
  try {
    assert.ok((await rig.store.writeRepair(seededSnapshot([record]), null)).ok);
    await rig.run();
    const pending = (await rig.snapshot()).work[0];
    assert.equal(pending.target.retiredOwnPr, 7);
    assert.equal(pending.target.pr, null);
    assert.equal(pending.intent?.kind, "pull_request");
    const key = pending.intent!.key;
    assert.ok(key.endsWith(":after-pr:7"));
    assert.equal(ledger.reservations.length, 2);
    const replacement = ledger.reservations[1].effectDigest;
    assert.notEqual(replacement, firstId);
    allowed = true;
    await advance();
    await rig.run();
    const uncertain = (await rig.snapshot()).work[0];
    assert.equal(uncertain.intent?.key, key);
    assert.equal(ledger.reservations.length, 2);
    assert.equal(ledger.reservations[1].effectDigest, replacement);
    await advance();
    await rig.run();
    const attached = (await rig.snapshot()).work[0];
    assert.equal(
      attached.target.pr,
      8,
      JSON.stringify({
        attached,
        prs: [...rig.github.candidatePullRequests.values()],
        effects,
        ledger,
      }),
    );
    assert.equal(attached.target.retiredOwnPr, 7);
    assert.equal(
      attempts,
      2,
      "one rejected attempt and one applied request, no retry POST after lost acknowledgement",
    );
    rig.github.candidatePullRequests.get(8)!.state = "closed";
    await advance();
    await rig.run();
    const next = (await rig.snapshot()).work[0];
    assert.equal(next.target.pr, 9);
    assert.equal(next.target.retiredOwnPr, 8);
    assert.equal(next.target.head, H1);
    assert.equal(ledger.reservations.length, 3);
    assert.notEqual(ledger.reservations[2].effectDigest, replacement);
    assert.equal(ledger.reservations[0].effectDigest, firstId);
    assert.equal(ledger.reservations[0].chargedMinutes, 25);
    assert.equal(ledger.proofs?.[0].effectDigest, firstId);
    assert.ok(
      effects.filter((effect) => effect.publicationAfter === 7).length >= 2,
    );
    assert.ok(
      effects.filter((effect) => effect.kind === "pr_open").every((effect) =>
        effect.pr === null
      ),
    );
    assert.equal(rig.github.pushes.length, 0);
    assert.equal(rig.model.requests.length, 0);
  } finally {
    await rig.ctx.cleanup();
  }
});

const deadLocalCandidate = (id: ReturnType<typeof asWorkItemId>) =>
  workRecord("issue-1", {
    source: { kind: "issue", id: "1", revision: SHA1 },
    related: { incidentId: null, issueNumber: 1 },
    target: {
      base: SHA1,
      branch: candidateBranch(id),
      checkpoint: null,
      head: null,
      pr: null,
      candidateState: { preserved: null, publishedHead: null },
    },
    nextStep: "work",
  });

Deno.test(
  "candidate lifecycle: a dead worker-local candidate starts one fresh implementation from the base",
  async () => {
    const rig = await makeRig("candidate-descriptor", { summaries: false });
    try {
      const id = asWorkItemId("issue-1");
      const written = await rig.store.writeRepair(
        seededSnapshot([deadLocalCandidate(id)]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      // The placeholder descriptor owns no publishable artifact and its
      // deterministic branch is absent, so the row is released to exactly one
      // fresh implementation start over the base (no checkoutBase).
      await rig.run();
      assert.equal(rig.model.requests.length, 1, "one fresh implementation");
      assert.equal(rig.model.requests[0]!.base, SHA1);
      assert.equal(
        rig.model.requests[0]!.checkoutBase,
        undefined,
        "a released dead candidate starts from the base",
      );
      assert.equal(rig.github.pushes.length, 0, "nothing published");
      const state = await rig.snapshot();
      const work = state.work[0]!;
      assert.ok(work.target.head !== null, "the fresh candidate head");
      assert.equal(
        work.intent?.kind,
        "candidate_preservation",
        "the fresh candidate then awaits its deterministic preservation",
      );
      assert.deepEqual(work.target.candidateState, {
        preserved: null,
        publishedHead: null,
      });
      assert.equal(
        rig.github.calls.filter((call) => call === "requestReview").length,
        0,
        "no review without a preserved descriptor",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "candidate lifecycle: a released dead candidate refuses uncharged when its branch is live",
  async () => {
    const rig = await makeRig("candidate-descriptor-live", {
      summaries: false,
      // A worker pushed the candidate but died before recording it: the
      // deterministic branch exists while publishedHead is still null.
      github: { branchRefSha: SHA3 },
    });
    try {
      const id = asWorkItemId("issue-1");
      const record = deadLocalCandidate(id);
      const before = canonicalStringify(record);
      const written = await rig.store.writeRepair(
        seededSnapshot([record]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      const outcome = await rig.run();
      assert.equal(outcome.status, "margin", JSON.stringify(outcome));
      const state = await rig.snapshot();
      assert.equal(state.sequence, 1, "an uncharged refusal writes nothing");
      assert.equal(canonicalStringify(state.work[0]), before);
      assert.equal(state.reservations.length, 0);
      assert.equal(rig.model.requests.length, 0, "no model start");
      assert.equal(rig.github.pushes.length, 0, "no push");
      assert.equal(rig.github.preservationRequests.length, 0);
      assert.equal(
        rig.github.calls.filter((call) => call === "requestReview").length,
        0,
        "no review request without a preserved descriptor",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "candidate lifecycle: an unavailable preserver keeps the exact intent/head with a bounded wait",
  async () => {
    const rig = await makeRig("candidate-preserve-unavailable", {
      summaries: false,
    });
    try {
      const id = asWorkItemId("issue-1");
      const operationKey = implementationIntentKey(PRODUCING_RESERVATION);
      const ref = await candidatePreservationRef(REPO, id, operationKey);
      const record = workRecord("issue-1", {
        source: { kind: "issue", id: "1", revision: SHA1 },
        related: { incidentId: null, issueNumber: 1 },
        target: {
          base: SHA1,
          branch: candidateBranch(id),
          checkpoint: null,
          head: H0,
          pr: null,
          candidateState: { preserved: null, publishedHead: null },
        },
        nextStep: "work",
        intent: {
          kind: "candidate_preservation",
          key: operationKey,
          startedAt: T0,
          branch: ref,
          expectedHead: H0,
          observedBase: SHA1,
          pr: null,
          requestId: PRODUCING_RESERVATION,
          resultId: null,
        },
        counters: { attempts: 1, retries: 0, reviewRounds: 0 },
      });
      const written = await rig.store.writeRepair(
        seededSnapshot([record]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const state = await rig.snapshot();
      const work = state.work[0];
      assert.equal(work.intent?.kind, "candidate_preservation");
      assert.equal(work.intent?.key, operationKey);
      assert.equal(work.intent?.requestId, PRODUCING_RESERVATION);
      assert.equal(work.intent?.resultId, null);
      assert.equal(work.intent?.expectedHead, H0);
      assert.equal(
        work.target.head,
        H0,
        "the exact candidate head is retained",
      );
      assert.equal(work.target.candidateState?.preserved, null);
      assert.equal(work.target.candidateState?.publishedHead, null);
      assert.equal(work.wait?.reason, "unavailable");
      assert.equal(work.wait?.until, T0 + CHECK_POLL_MS);
      assert.deepEqual(rig.github.preservationRequests, [{
        taskId: id,
        candidate: {
          operationKey,
          base: SHA1,
          head: H0,
          ref,
        },
        publishedHead: null,
      }]);
      assert.equal(state.reservations.length, 0, "no charge for a wait");
      assert.equal(rig.model.requests.length, 0);
      assert.equal(rig.github.pushes.length, 0);
      assert.equal(
        rig.github.calls.filter((call) => call === "requestReview").length,
        0,
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "candidate lifecycle: a positively missing candidate returns to a fresh attempt instead of retrying forever",
  async () => {
    const id = asWorkItemId("issue-1");
    const branch = candidateBranch(id);
    const operationKey = implementationIntentKey(PRODUCING_RESERVATION);
    const ref = await candidatePreservationRef(REPO, id, operationKey);
    const lifecycle = positiveLifecycle();
    const positivePreserve = lifecycle.preserveCandidate!;
    let preservations = 0;
    const rig = await makeRig("candidate-preserve-missing", {
      github: {
        issues: [{ number: 1, title: "reproducible failure", body: "body" }],
        candidateLifecycle: {
          ...lifecycle,
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [exactOpenPr(7, H1, branch)],
          preserveCandidate: (request) => {
            preservations++;
            if (preservations === 1) {
              // The host loader's exact positive-absence classification: no
              // trusted store or remote ref holds the produced candidate.
              return Promise.resolve(
                portError(
                  "not_found",
                  "candidate is not available in the trusted local store",
                ),
              );
            }
            return positivePreserve(request);
          },
        },
      },
    });
    try {
      const record = workRecord("issue-1", {
        source: { kind: "issue", id: "1", revision: SHA1 },
        related: { incidentId: null, issueNumber: 1 },
        target: {
          base: SHA1,
          branch,
          checkpoint: null,
          head: H0,
          pr: 7,
          candidateState: { preserved: null, publishedHead: H1 },
        },
        nextStep: "work",
        intent: {
          kind: "candidate_preservation",
          key: operationKey,
          startedAt: T0,
          branch: ref,
          expectedHead: H0,
          observedBase: SHA1,
          pr: null,
          requestId: PRODUCING_RESERVATION,
          resultId: null,
        },
        counters: { attempts: 1, retries: 0, reviewRounds: 0 },
      });
      const written = await rig.store.writeRepair(
        seededSnapshot([record]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      // Run 1: the missing candidate is never reconciled and the record never
      // parks on it. It returns to the legacy work shape bound to the published
      // branch head with its charged attempt history preserved, and the same
      // cycle buys exactly one fresh implementation attempt whose candidate is
      // preserved under a new operation identity.
      const first = await rig.run();
      assert.equal(first.status, "idle", JSON.stringify(first));
      const state = await rig.snapshot();
      const work = state.work[0]!;
      assert.ok(
        rig.model.requests.length >= 1,
        "the recovery buys a fresh run",
      );
      assert.equal(work.target.head, SHA3, "the fresh candidate head");
      assert.equal(work.counters.attempts, 2, "one charged fresh attempt");
      assert.notEqual(
        work.target.candidateState?.preserved?.operationKey ?? null,
        operationKey,
        "the lost operation identity is retired",
      );
      assert.equal(
        work.target.candidateState?.preserved?.head ?? null,
        SHA3,
        "the fresh candidate is preserved",
      );
      assert.equal(work.target.candidateState?.publishedHead, SHA3);
      assert.equal(
        work.nextStep,
        "review",
        "the record advances past the loss",
      );
      assert.equal(work.wait?.reason, "review_pending");
      assert.ok(
        state.reservations.some((entry) =>
          entry.attempt === 2 && entry.purpose === "retry" &&
          entry.outcome === "submitted"
        ),
        "the fresh attempt is charged as a retry",
      );
      assert.ok(preservations >= 2, "one refused and one durable preservation");
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "candidate lifecycle: a closed-unmerged own PR republishes the preserved candidate once",
  async () => {
    const id = asWorkItemId("issue-1");
    const branch = candidateBranch(id);
    // GitHub freezes a closed pull request's head forever, so both shapes are
    // recoverable: the exact published head and a head that predates the
    // refreshed candidate now on the task branch (the live issue-138 shape).
    for (const closedHead of [H1, H0]) {
      const rig = await makeRig(
        `candidate-closed-pr-${closedHead.slice(0, 6)}`,
        {
          summaries: false,
          github: {
            candidateLifecycle: {
              ...positiveLifecycle(),
              refs: { [`refs/heads/${branch}`]: H1 },
              pullRequests: [{
                ...exactOpenPr(7, closedHead, branch),
                state: "closed" as const,
              }],
            },
          },
        },
      );
      try {
        const written = await rig.store.writeRepair(
          seededSnapshot([preservedIssueWork("issue-1", H1)]),
          null,
        );
        assert.ok(written.ok && written.value.status === "applied");

        const outcome = await rig.run();
        assert.equal(outcome.status, "idle", JSON.stringify(outcome));
        const state = await rig.snapshot();
        const work = state.work[0]!;
        assert.equal(work.target.head, H1, "the exact candidate is retained");
        assert.equal(work.target.pr, 8, "one replacement pull request");
        assert.equal(work.nextStep, "review");
        assert.equal(work.wait?.reason, "review_pending");
        const replaced = rig.github.candidatePullRequests.get(8);
        assert.equal(
          replaced?.head,
          H1,
          "the replacement carries the candidate",
        );
        assert.equal(
          replaced?.body,
          "Resolves #1",
          "the closing keyword body",
        );
        assert.equal(
          rig.model.requests.length,
          0,
          "recovering a closed publication starts no model run",
        );
        assert.equal(rig.github.pushes.length, 0, "no additional push");
        const assignIndex = rig.github.calls.indexOf("assignIssue:1");
        const createIndex = rig.github.calls.indexOf("createPr");
        assert.ok(
          assignIndex !== -1 && createIndex !== -1 && assignIndex < createIndex,
          "the source issue is assigned before the pull request exists",
        );
      } finally {
        await rig.ctx.cleanup();
      }
    }
  },
);

Deno.test(
  "candidate lifecycle: a refused issue assignment still publishes from the preserved candidate",
  async () => {
    const id = asWorkItemId("issue-1");
    const branch = candidateBranch(id);
    const rig = await makeRig("candidate-assign-failed", {
      summaries: false,
      github: {
        assignFailNext: true,
        candidateLifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [],
        },
      },
    });
    try {
      const written = await rig.store.writeRepair(
        seededSnapshot([preservedIssueWork("issue-1", H1, { pr: null })]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      const outcome = await rig.run();
      const state = await rig.snapshot();
      const work = state.work[0]!;
      assert.equal(work.target.pr, 7, "the replacement was published anyway");
      assert.equal(work.target.head, H1, "the candidate is retained");
      assert.equal(work.nextStep, "review");
      assert.ok(
        rig.github.calls.includes("assignIssue:1"),
        "the assignment was attempted first",
      );
      const assignIndex = rig.github.calls.indexOf("assignIssue:1");
      const createIndex = rig.github.calls.indexOf("createPr");
      assert.ok(
        assignIndex !== -1 && createIndex !== -1 && assignIndex < createIndex,
        "the assignment attempt precedes the pull request",
      );
      assert.equal(rig.model.requests.length, 0);
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "candidate lifecycle: a review-phase record whose own PR was closed unmerged republishes once",
  async () => {
    const id = asWorkItemId("issue-1");
    const branch = candidateBranch(id);
    const rig = await makeRig("candidate-review-closed-pr", {
      summaries: false,
      github: {
        candidateLifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [{
            ...exactOpenPr(7, H1, branch),
            state: "closed" as const,
          }],
        },
      },
    });
    try {
      const written = await rig.store.writeRepair(
        seededSnapshot([
          preservedIssueWork("issue-1", H1, { nextStep: "review", pr: 7 }),
        ]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const state = await rig.snapshot();
      const work = state.work[0]!;
      assert.equal(work.target.head, H1, "the exact candidate is retained");
      assert.equal(work.target.pr, 8, "one replacement pull request");
      assert.equal(work.nextStep, "review");
      assert.equal(work.wait?.reason, "review_pending");
      assert.equal(
        rig.github.candidatePullRequests.get(8)?.body,
        "Resolves #1",
      );
      assert.equal(rig.model.requests.length, 0, "no model runs to recover");
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "candidate lifecycle: a human-merged review-phase PR completes through delivery bookkeeping",
  async () => {
    const id = asWorkItemId("issue-1");
    const branch = candidateBranch(id);
    const rig = await makeRig("candidate-review-merged-pr", {
      summaries: false,
      localScope: true,
      github: {
        candidateLifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [
            {
              ...exactOpenPr(7, H1, branch),
              state: "merged" as const,
              mergeSha: SHA2,
              mergedBy: "0x4007",
            } as GitHubPullRequestV1 & { mergedBy: string },
          ],
        },
      },
    });
    try {
      const written = await rig.store.writeRepair(
        seededSnapshot([
          {
            ...preservedIssueWork("issue-1", H1, {
              nextStep: "review",
              pr: 7,
            }),
            repository: LOCAL_SENTINEL_REPO,
          },
        ]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const state = await rig.snapshot();
      const work = state.work[0]!;
      assert.equal(work.nextStep, "done");
      assert.equal(work.blocker, null);
      assert.deepEqual(
        work.evidence,
        [{
          kind: "review_receipt",
          ref: `artifact:review-receipt/human-merge-v1/7/${H1}/${SHA2}/0x4007`,
        }],
      );
      assert.equal(
        work.target.pr,
        7,
        "the delivered merged PR identity is retained",
      );
      assert.equal(work.target.head, H1, "the delivered head is retained");
      assert.equal(work.intent, null);
      assert.equal(work.wait, null);
      assert.equal(
        state.releaseRequests.length,
        1,
        "the ordinary post-merge bookkeeping persists one release request",
      );
      assert.equal(state.releaseRequests[0]!.revision, SHA2);
      assert.equal(
        rig.github.calls.filter((call) => call === "createPr").length,
        0,
        "a merged repair is never republished",
      );
      assert.equal(rig.model.requests.length, 0);
      assert.equal(
        rig.github.calls.filter((call) => call === "merge").length,
        0,
        "a completed human merge is never merged again",
      );
      assert.equal(
        rig.github.calls.filter((call) => call.startsWith("closeIssue")).length,
        0,
        "no new GitHub write is invented for the human merge",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "candidate lifecycle: an exact preserved/published candidate progresses to one review",
  async () => {
    const id = asWorkItemId("issue-1");
    const branch = candidateBranch(id);
    const rig = await makeRig("candidate-preserved-progress", {
      summaries: false,
      github: {
        candidateLifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [exactOpenPr(7, H1, branch)],
        },
      },
    });
    try {
      const record = preservedIssueWork("issue-1", H1);
      const written = await rig.store.writeRepair(
        seededSnapshot([record]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const state = await rig.snapshot();
      const work = state.work[0];
      assert.equal(work.nextStep, "review");
      assert.equal(work.wait?.reason, "review_pending");
      assert.equal(work.intent, null);
      assert.equal(work.target.head, H1);
      assert.equal(work.target.candidateState?.publishedHead, H1);
      assert.equal(
        rig.github.pushes.length,
        0,
        "an already published exact head is adopted, never re-pushed",
      );
      assert.equal(rig.model.requests.length, 0);
      assert.equal(
        rig.github.calls.filter((call) => call === "requestReview").length,
        1,
      );
      assert.deepEqual(
        state.reservations.map((reservation) => reservation.purpose),
        ["review_request"],
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);
