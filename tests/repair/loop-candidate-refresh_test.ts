/** Candidate refresh ambiguity and exact review freshness accounting. */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type { PortResultV1 } from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import {
  candidateBranch,
  candidatePreservationRef,
} from "../../src/repair/keys.ts";
import {
  REPO,
  reservation,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import type { FakeGithubCandidateLifecycleV1 } from "./helpers.ts";
import { makeRig, type RigV1, seededSnapshot } from "./loop-rig.ts";
import {
  candidateAccounting,
  CHECK_POLL_MS,
  exactOpenPr,
  H0,
  H1,
  positiveLifecycle,
  preservedIssueWork,
} from "./loop-candidate-fixtures.ts";

Deno.test(
  "candidate lifecycle H1: a push applied with a lost response keeps published H0 and recovers H1 once",
  async () => {
    const id = asWorkItemId("issue-1");
    const branch = candidateBranch(id);
    const rig = await makeRig("candidate-h1-lost-push", {
      summaries: false,
      github: {
        candidateLifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: H0 },
          pullRequests: [exactOpenPr(7, H0, branch)],
        },
      },
    });
    try {
      // The first push mutates the exact remote once and then loses its
      // response; the harness never reports a success for it.
      const originalPush = rig.github.pushHead.bind(rig.github);
      let lost = false;
      rig.github.pushHead = (
        ref: string,
        sha: GitSha,
        expected: GitSha | null,
      ) => {
        if (!lost) {
          lost = true;
          assert.equal(ref, `refs/heads/${branch}`, "exact full task ref");
          assert.equal(sha, H1, "exact recovered head");
          assert.equal(expected, H0, "exact expected lease");
          rig.github.calls.push(`push:${ref}:${sha.slice(0, 8)}`);
          rig.github.pushes.push({ ref, sha, expected });
          rig.github.applyPushWithoutResponse(ref, sha);
          return Promise.resolve(
            portError("unavailable", "push response lost"),
          );
        }
        return originalPush(ref, sha, expected);
      };
      const record = preservedIssueWork("issue-1", H1, {
        publishedHead: H0,
      });
      const historical = reservation("hist-review-h1", {
        taskId: id,
        head: H0,
        purpose: "review_request",
        outcome: "submitted",
        settledAt: T0,
      });
      const historicalBytes = canonicalStringify(historical);
      const written = await rig.store.writeRepair(
        seededSnapshot([record], { reservations: [historical] }),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      // Run 1: H1 was applied remotely with a lost response. The durable push
      // intent, the H0 publication proof and the wait survive, no review is
      // requested and nothing is charged.
      const first = await rig.run();
      assert.equal(first.status, "idle", JSON.stringify(first));
      let state = await rig.snapshot();
      let work = state.work[0];
      assert.equal(work.intent?.kind, "push");
      assert.equal(work.intent?.expectedHead, H1);
      assert.equal(work.target.head, H1, "the candidate head is unchanged");
      assert.equal(
        work.target.candidateState?.publishedHead,
        H0,
        "the lost response never advances publishedHead",
      );
      assert.equal(work.wait?.reason, "unavailable");
      assert.equal(work.wait?.until, T0 + CHECK_POLL_MS);
      assert.equal(rig.github.pushes.length, 1, "one applied push");
      assert.equal(
        rig.github.candidateRefs.get(`refs/heads/${branch}`),
        H1,
        "the exact remote branch carries H1",
      );
      assert.equal(state.reservations.length, 1, "no review charge");
      assert.equal(
        canonicalStringify(
          state.reservations.find((entry) => entry.id === historical.id),
        ),
        historicalBytes,
        "the historical reservation is unchanged",
      );
      assert.equal(rig.model.requests.length, 0, "no model");

      // Run 2 after the bounded wait: the exact ref proves the push, H1 is
      // acknowledged atomically and exactly one review is requested.
      rig.clock.advance(CHECK_POLL_MS + 1);
      const second = await rig.run();
      assert.equal(second.status, "idle", JSON.stringify(second));
      state = await rig.snapshot();
      work = state.work[0];
      assert.equal(work.intent, null, "the reconciled push intent is cleared");
      assert.equal(work.target.head, H1);
      assert.equal(work.target.candidateState?.publishedHead, H1);
      assert.equal(work.nextStep, "review");
      assert.equal(work.wait?.reason, "review_pending");
      assert.equal(rig.github.pushes.length, 1, "no second push");
      assert.equal(rig.model.requests.length, 0, "no second model");
      assert.equal(
        rig.github.calls.filter((call) => call === "requestReview").length,
        1,
        "exactly one review request for the recovered head",
      );
      const admitted = state.reservations.filter((entry) =>
        entry.id !== historical.id
      );
      assert.equal(admitted.length, 1, "only one new review reservation");
      assert.equal(admitted[0].purpose, "review_request");
      assert.equal(admitted[0].head, H1, "exact final review head");
      assert.equal(admitted[0].outcome, "submitted");
      assert.equal(
        canonicalStringify(
          state.reservations.find((entry) => entry.id === historical.id),
        ),
        historicalBytes,
        "the historical reservation is unchanged",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "candidate lifecycle H2: a lost refresh push retains H1/H2 and acknowledges H2 once",
  async () => {
    const id = asWorkItemId("issue-1");
    const branch = candidateBranch(id);
    const B1 = SHA1;
    const B2 = SHA2;
    const H2 = H1;
    const H1_HEAD = SHA3;
    const refreshKey = `base_refresh:7:${H1_HEAD}:${B2}`;
    const rig = await makeRig("candidate-h2-lost-push", {
      summaries: false,
      // The configured base already carries B2 when the refreshed candidate is
      // re-observed for review admission.
      github: {
        baseSha: B2,
        candidateLifecycle: {
          refs: { [`refs/heads/${branch}`]: H1_HEAD },
          pullRequests: [exactOpenPr(7, H1_HEAD, branch, B2)],
          preserveCandidate: async (request) => {
            // The exact successor descriptor AND the durable old-H1 target are
            // asserted from inside the real preservation call.
            const durable = (await rig.snapshot()).work[0];
            assert.equal(request.taskId, id);
            assert.equal(request.candidate.operationKey, refreshKey);
            assert.equal(request.candidate.base, B2);
            assert.equal(request.candidate.head, H2);
            assert.equal(
              request.candidate.ref,
              await candidatePreservationRef(REPO, id, refreshKey),
              "exact preservation ref",
            );
            assert.equal(request.publishedHead, H1_HEAD);
            assert.equal(durable.target.head, H1_HEAD, "durable old H1 target");
            assert.equal(durable.target.base, B1, "durable old base");
            assert.equal(
              durable.target.candidateState?.publishedHead,
              H1_HEAD,
            );
            assert.equal(durable.intent?.kind, "base_refresh");
            assert.equal(durable.intent?.resultId, H2);
            return portOk(undefined);
          },
          prepareBaseRefresh: (request) => {
            assert.equal(request.pullRequestNumber, 7);
            assert.equal(request.branch, branch);
            assert.equal(request.expectedHead, H1_HEAD);
            assert.equal(request.previousBase, B1);
            assert.equal(request.expectedBase, B2);
            assert.equal(request.preparedHead, H2);
            return Promise.resolve(portOk(H2));
          },
        },
      },
    });
    try {
      const originalPush = rig.github.pushHead.bind(rig.github);
      let lost = false;
      rig.github.pushHead = (
        ref: string,
        sha: GitSha,
        expected: GitSha | null,
      ) => {
        if (!lost) {
          lost = true;
          rig.github.calls.push(`push:${ref}:${sha.slice(0, 8)}`);
          rig.github.pushes.push({ ref, sha, expected });
          rig.github.applyPushWithoutResponse(ref, sha);
          return Promise.resolve(
            portError("unavailable", "refresh push response lost"),
          );
        }
        return originalPush(ref, sha, expected);
      };
      const record = preservedIssueWork("issue-1", H1_HEAD, {
        publishedHead: H1_HEAD,
        nextStep: "delivery",
      });
      const withRefresh = workRecord("issue-1", {
        ...record,
        intent: {
          kind: "base_refresh",
          key: refreshKey,
          startedAt: T0,
          branch,
          expectedHead: H1_HEAD,
          observedBase: B2,
          pr: 7,
          requestId: null,
          resultId: H2,
        },
      });
      const historical = reservation("hist-review-h2", {
        taskId: id,
        head: H1_HEAD,
        purpose: "review_request",
        outcome: "submitted",
        settledAt: T0,
      });
      const historicalBytes = canonicalStringify(historical);
      const written = await rig.store.writeRepair(
        seededSnapshot([withRefresh], { reservations: [historical] }),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      // Run 1: the persisted prepared H2 is preserved and pushed onto the
      // exact branch; the lost response retains the old H1 target and the H2
      // intent with no review charge.
      const first = await rig.run();
      assert.equal(first.status, "idle", JSON.stringify(first));
      let state = await rig.snapshot();
      let work = state.work[0];
      assert.equal(work.target.head, H1_HEAD, "old H1 target retained");
      assert.equal(work.target.base, B1, "old base retained");
      assert.equal(work.target.candidateState?.publishedHead, H1_HEAD);
      assert.equal(work.intent?.kind, "base_refresh");
      assert.equal(work.intent?.resultId, H2, "the H2 intent is retained");
      assert.equal(work.wait?.reason, "unavailable");
      assert.equal(rig.github.pushes.length, 1);
      assert.equal(rig.github.pushes[0].sha, H2);
      assert.equal(rig.github.pushes[0].expected, H1_HEAD);
      assert.equal(
        rig.github.candidateRefs.get(`refs/heads/${branch}`),
        H2,
        "the exact remote branch carries H2",
      );
      assert.equal(state.reservations.length, 1, "no review charge");
      assert.equal(
        canonicalStringify(
          state.reservations.find((entry) => entry.id === historical.id),
        ),
        historicalBytes,
        "the historical reservation is unchanged",
      );
      assert.equal(rig.model.requests.length, 0, "no model");

      // Run 2 after the wait: regeneration matches the persisted H2, the ref is
      // already prepared (no second push), the target advances atomically and
      // exactly one fresh review is requested.
      rig.clock.advance(CHECK_POLL_MS + 1);
      const second = await rig.run();
      assert.equal(second.status, "idle", JSON.stringify(second));
      state = await rig.snapshot();
      work = state.work[0];
      assert.equal(work.intent, null, "the refresh intent is cleared");
      assert.equal(work.target.base, B2, "target advanced to the new base");
      assert.equal(work.target.head, H2, "target advanced to the prepared H2");
      assert.equal(work.target.candidateState?.preserved?.head, H2);
      assert.equal(work.target.candidateState?.publishedHead, H2);
      assert.equal(work.nextStep, "review");
      assert.equal(work.wait?.reason, "review_pending");
      assert.equal(rig.github.pushes.length, 1, "no second push");
      assert.equal(rig.model.requests.length, 0, "no model");
      assert.equal(
        rig.github.calls.filter((call) => call === "requestReview").length,
        1,
        "one review for the acknowledged H2",
      );
      const admitted = state.reservations.filter((entry) =>
        entry.id !== historical.id
      );
      assert.equal(admitted.length, 1, "only one new review reservation");
      assert.equal(admitted[0].purpose, "review_request");
      assert.equal(admitted[0].head, H2, "exact final review head");
      assert.equal(admitted[0].outcome, "submitted");
      assert.equal(
        canonicalStringify(
          state.reservations.find((entry) => entry.id === historical.id),
        ),
        historicalBytes,
        "the historical reservation is unchanged",
      );
      assert.equal(
        rig.github.preservationRequests.length,
        2,
        "the same successor was preserved once per run",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "candidate lifecycle: review freshness refusals leave candidate accounting untouched",
  async () => {
    const id = asWorkItemId("issue-1");
    const branch = candidateBranch(id);
    // NOTE: a closed-unmerged own PR is no longer a refusal. It recovers by
    // retiring the publication identity, asserted by the dedicated
    // "a closed-unmerged own PR republishes the preserved candidate once" case.
    const wrongBranchPr = { ...exactOpenPr(7, H1, branch), headRef: "other" };
    const wrongBasePr = { ...exactOpenPr(7, H1, branch), baseRef: "main" };
    let prepareCalls = 0;
    const cases: Array<{
      name: string;
      baseSha?: GitSha;
      lifecycle: FakeGithubCandidateLifecycleV1;
      mutate?: (rig: RigV1) => void;
      expectedBlocked?: string;
      expectedIntentBase?: GitSha;
      /** The missing capability IS the gate under test; never injected. */
      absentPrepare?: boolean;
      /** The exact PR must be observed before the freshness refusal. */
      expectPrObservation?: boolean;
    }> = [
      {
        name: "failed base read",
        lifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [exactOpenPr(7, H1, branch)],
        },
        mutate: (rig) => {
          const original = rig.github.readRef.bind(rig.github);
          rig.github.readRef = (ref) =>
            ref.endsWith("refs/heads/development")
              ? Promise.resolve(portError("unavailable", "base read failed"))
              : original(ref);
        },
      },
      {
        name: "null base read",
        lifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [exactOpenPr(7, H1, branch)],
        },
        mutate: (rig) => {
          const original = rig.github.readRef.bind(rig.github);
          rig.github.readRef = (ref) =>
            ref.endsWith("refs/heads/development")
              ? Promise.resolve(portOk(null))
              : original(ref);
        },
      },
      {
        name: "moved base",
        baseSha: SHA2,
        lifecycle: {
          preserveCandidate: () => Promise.resolve(portOk(undefined)),
          prepareBaseRefresh: (request) => {
            prepareCalls++;
            assert.equal(request.expectedHead, H1);
            assert.equal(request.previousBase, SHA1);
            assert.equal(request.expectedBase, SHA2);
            return Promise.resolve(
              portError("unavailable", "prepared unavailable"),
            );
          },
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [exactOpenPr(7, H1, branch)],
        },
        expectedIntentBase: SHA2,
      },
      {
        name: "moved base with absent prepare capability",
        baseSha: SHA2,
        absentPrepare: true,
        lifecycle: {
          preserveCandidate: () => Promise.resolve(portOk(undefined)),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [exactOpenPr(7, H1, branch)],
        },
      },
      {
        name: "missing prepare capability",
        absentPrepare: true,
        lifecycle: {
          preserveCandidate: () => Promise.resolve(portOk(undefined)),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [exactOpenPr(7, H1, branch)],
        },
      },
      {
        name: "wrong PR branch",
        lifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [wrongBranchPr],
        },
        expectPrObservation: true,
      },
      {
        name: "wrong PR base",
        lifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [wrongBasePr],
        },
        expectPrObservation: true,
      },
      {
        name: "stale PR head",
        lifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [exactOpenPr(7, H0, branch)],
        },
        expectPrObservation: true,
      },
      {
        name: "missing candidate ref",
        lifecycle: { refs: {}, pullRequests: [exactOpenPr(7, H1, branch)] },
        expectedBlocked: "published candidate ref is missing",
      },
      {
        name: "wrong candidate ref",
        lifecycle: {
          refs: { [`refs/heads/${branch}`]: SHA2 },
          pullRequests: [exactOpenPr(7, H1, branch)],
        },
        expectedBlocked: "candidate branch ref identity mismatch",
      },
      {
        // The publication read acknowledges the exact H1 task ref; the SECOND
        // central read at review admission observes a null task ref and must
        // refuse review with the exact PR already observed.
        name: "acknowledged ref missing on review re-read",
        lifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [exactOpenPr(7, H1, branch)],
        },
        mutate: (rig) => {
          const original = rig.github.readRef.bind(rig.github);
          let taskReads = 0;
          rig.github.readRef = (
            ref,
          ): Promise<
            PortResultV1<{ ref: string; sha: GitSha } | null>
          > => {
            if (ref !== `refs/heads/${branch}`) return original(ref);
            taskReads++;
            return taskReads === 1
              ? original(ref)
              : Promise.resolve(portOk(null));
          };
        },
        expectPrObservation: true,
      },
      {
        // Same acknowledgement, but the review re-read observes an unrelated
        // SHA: the refusal is the identity mismatch, never a second publish.
        name: "acknowledged ref moved on review re-read",
        lifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [exactOpenPr(7, H1, branch)],
        },
        mutate: (rig) => {
          const original = rig.github.readRef.bind(rig.github);
          let taskReads = 0;
          rig.github.readRef = (
            ref,
          ): Promise<
            PortResultV1<{ ref: string; sha: GitSha } | null>
          > => {
            if (ref !== `refs/heads/${branch}`) return original(ref);
            taskReads++;
            return taskReads === 1
              ? original(ref)
              : Promise.resolve(portOk({ ref, sha: SHA2 }));
          };
        },
        expectPrObservation: true,
      },
    ];
    for (const testCase of cases) {
      const rig = await makeRig(`candidate-fresh-${testCase.name}`, {
        summaries: false,
        github: {
          baseSha: testCase.baseSha ?? SHA1,
          candidateLifecycle: testCase.lifecycle,
        },
      });
      try {
        // Every negative case composes the explicit unused prepare capability
        // so the earlier missing-capability gate never masks the specific
        // base/PR/ref refusal under test. The two absent-prepare fixtures keep
        // the capability missing: that gate is exactly what they test.
        if (
          testCase.absentPrepare !== true &&
          rig.github.prepareBaseRefresh === undefined
        ) {
          rig.github.prepareBaseRefresh = () => {
            throw new Error("prepare must not run for an unchanged base");
          };
        }
        const record = preservedIssueWork("issue-1", H1);
        const before = candidateAccounting(record);
        const written = await rig.store.writeRepair(
          seededSnapshot([record]),
          null,
        );
        assert.ok(written.ok && written.value.status === "applied");
        testCase.mutate?.(rig);

        const outcome = await rig.run();
        assert.equal(
          outcome.status,
          testCase.expectedBlocked === undefined &&
            testCase.expectedIntentBase === undefined
            ? "margin"
            : "idle",
          `${testCase.name}: ${JSON.stringify(outcome)}`,
        );
        const state = await rig.snapshot();
        const work = state.work[0];
        const after = candidateAccounting(work) as {
          target: Record<string, unknown>;
        };
        const expectedAccounting = before as {
          target: Record<string, unknown>;
        };
        if (testCase.expectedBlocked !== undefined) {
          // A terminal block is the ONE intended accounting change: the stale
          // PR identity is cleared (item 3), while every candidate byte,
          // counter and identity is preserved exactly.
          assert.deepEqual(
            { ...after, target: { ...after.target, pr: null } },
            {
              ...expectedAccounting,
              target: { ...expectedAccounting.target, pr: null },
            },
            `${testCase.name}: candidate/accounting unchanged (pr cleared)`,
          );
          assert.equal(
            work.target.pr,
            null,
            `${testCase.name}: terminal block clears the stale PR`,
          );
        } else {
          assert.deepEqual(
            after,
            expectedAccounting,
            `${testCase.name}: candidate/accounting unchanged`,
          );
        }
        assert.equal(state.reservations.length, 0, `${testCase.name}: charge`);
        assert.equal(rig.model.requests.length, 0, `${testCase.name}: model`);
        assert.equal(
          rig.github.calls.filter((call) => call === "requestReview").length,
          0,
          `${testCase.name}: review request`,
        );
        if (testCase.expectPrObservation === true) {
          assert.ok(
            rig.github.calls.includes("readPr:7"),
            `${testCase.name}: exact PR observation was reached`,
          );
        }
        if (testCase.expectedBlocked !== undefined) {
          assert.equal(work.nextStep, "blocked", testCase.name);
          assert.equal(work.blocker?.message, testCase.expectedBlocked);
        } else {
          assert.equal(work.nextStep, "work", testCase.name);
        }
        if (testCase.expectedIntentBase !== undefined) {
          assert.equal(work.intent?.kind, "base_refresh", testCase.name);
          assert.equal(
            work.intent?.observedBase,
            testCase.expectedIntentBase,
            `${testCase.name}: exact observed base`,
          );
          assert.equal(
            work.wait?.reason,
            "unavailable",
            `${testCase.name}: bounded unavailable wait`,
          );
        }
      } finally {
        await rig.ctx.cleanup();
      }
    }
    assert.equal(prepareCalls, 1, "preparation ran once through the intent");
  },
);

// The Stage-1 global candidate parking is gone: candidate-state records are
// selected like any other record, and their lifecycle steps perform the safe
// deferral/reconciliation asserted by the focused cases above. The intake
// identity-isolation cases below keep the remaining M15 guarantees.
