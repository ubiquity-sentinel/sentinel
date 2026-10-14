/** Hosted candidate-handoff-cuts_test responsibility. */
import assert from "node:assert/strict";
import {
  baseRefreshIntentKey,
  candidatePreservationRef,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import { gitRun } from "../state/helpers.ts";
import type { CandidateHandoffScenarioV1 } from "./candidate-handoff-worker.ts";
import {
  BASE_BRANCH,
  expectedOperationRefOf,
  expectOk,
  hasObject,
  head,
  ISSUE_NUMBER,
  PR_NUMBER,
  remoteRef,
  REPOSITORY,
  ROOT,
  TRUSTED_AUTHOR,
  TRUSTED_REVIEWER,
} from "./candidate-handoff-fixture.ts";
import {
  FIXTURE_CHECK_POLL_MS,
  preservationRefs,
  setupCandidateFaultFixture,
} from "./candidate-handoff-fault-fixture.ts";
import {
  assertFreshChildCompletion,
  runHandoffWorker,
} from "./candidate-handoff-child-fixture.ts";

Deno.test(
  "candidate handoff cut 1: a rejected preservation acknowledgement never publishes H1 and a fresh process restores it from the durable intent",
  async () => {
    const tmp = await Deno.makeTempDir({
      prefix: "sentinel-candidate-ack-loss-",
      dir: ROOT,
    });
    try {
      const fx = await setupCandidateFaultFixture(tmp, {
        interceptPreservationAcknowledgement: true,
      });
      const env = fx.env;

      // One-step receipt cut: real H1 is produced, imported and the base moves
      // B0 -> B1 before the receipt is consumed. The preservation intent is
      // durable and the acknowledgement is still outstanding.
      await fx.runOneStep();
      assert.equal(fx.model.calls, 1, "the fixture model must be called once");
      const h1 = fx.produced[0]!;
      const b1 = await head(fx.remoteWork, env);
      assert.notEqual(b1, fx.b0, "the fixture base must move during the call");
      const afterProducer = await fx.state.readRepair();
      if (!afterProducer.ok || afterProducer.value.status !== "found") {
        throw new Error("producer state read failed");
      }
      const producerWork = afterProducer.value.snapshot.work.find((work) =>
        work.id === fx.workId
      );
      if (producerWork === undefined) {
        throw new Error("producer work record missing");
      }
      const reservationsBefore = afterProducer.value.snapshot.reservations;
      assert.equal(
        producerWork.target.head,
        h1,
        "the receipt handler must persist H1 to target.head",
      );
      assert.equal(
        producerWork.target.base,
        fx.b0,
        "the base must still be B0",
      );
      assert.equal(
        producerWork.target.candidateState?.preserved ?? null,
        null,
        "no descriptor may exist before the acknowledgement is durable",
      );
      assert.equal(
        producerWork.intent?.kind,
        "candidate_preservation",
        "the original preservation intent must stay durable",
      );
      assert.equal(
        producerWork.intent?.expectedHead,
        h1,
        "the durable intent must bind H1",
      );
      assert.equal(
        producerWork.intent?.observedBase,
        fx.b0,
        "the durable intent must bind B0",
      );
      assert.equal(
        await remoteRef(fx.remoteGitDir, env, `refs/heads/${fx.branch}`),
        fx.h0,
        "the candidate branch must still carry H0",
      );

      // Bounded producer handoff: at most eight one-step calls until the real
      // H1 operation ref exists. The injected acknowledgement rejection makes
      // the interrupted step return a genuine state error; only ACTUAL remote
      // ref creations count. Repeated-call idempotency is covered by the
      // existing preserver tests, not by this crash cut.
      const MAX_HANDOFF_STEPS = 8;
      let handoffSteps = 0;
      let handoffStatus = "retained_after_receipt";
      let refs = await preservationRefs(fx.remoteGitDir, env);
      while (refs.length === 0 && handoffSteps < MAX_HANDOFF_STEPS) {
        const outcome = await fx.runOneStep();
        handoffSteps += 1;
        handoffStatus = outcome.status;
        refs = await preservationRefs(fx.remoteGitDir, env);
        if (refs.length > 0) break;
        if (outcome.status !== "step_limit") break;
      }
      refs = await preservationRefs(fx.remoteGitDir, env);
      const handoffContext = `producerHead=${h1} oldRemoteHead=${fx.h0} ` +
        `oldBase=${fx.b0} newBase=${b1} steps=${handoffSteps}/` +
        `${MAX_HANDOFF_STEPS} status=${handoffStatus} ` +
        `preservationRefs=${JSON.stringify(refs)} ` +
        `ackRejections=${fx.ackRejections()}`;
      assert.equal(
        fx.model.calls,
        1,
        `the bounded handoff must not start a second implementation call; ` +
          handoffContext,
      );
      assert.equal(
        refs.length,
        1,
        `exactly one actual preservation ref creation is permitted; ` +
          handoffContext,
      );
      const implementationReservations = reservationsBefore.filter((entry) =>
        entry.taskId === fx.workId &&
        (entry.purpose === "implementation" || entry.purpose === "retry") &&
        entry.outcome === "submitted"
      );
      assert.equal(
        implementationReservations.length,
        1,
        `exactly one submitted implementation reservation is required; ` +
          handoffContext,
      );
      const expectedOperationRef = await candidatePreservationRef(
        REPOSITORY,
        fx.workId,
        implementationIntentKey(implementationReservations[0]!.id),
      );
      assert.equal(
        refs[0]!.ref,
        expectedOperationRef,
        `the retained ref must be the exact operation-bound ref; ` +
          handoffContext,
      );
      assert.equal(
        refs[0]!.sha,
        h1,
        `the actual operation ref must carry H1; ${handoffContext}`,
      );
      assert.ok(
        fx.ackRejections() >= 1,
        `the injected acknowledgement must have been refused; ${handoffContext}`,
      );

      const afterHandoff = await fx.state.readRepair();
      if (!afterHandoff.ok || afterHandoff.value.status !== "found") {
        throw new Error("producer state read after handoff failed");
      }
      const handoffWork = afterHandoff.value.snapshot.work.find((work) =>
        work.id === fx.workId
      );
      assert.equal(
        handoffWork?.target.head,
        h1,
        `the durable original target H1 must survive; ${handoffContext}`,
      );
      assert.equal(
        handoffWork?.target.base,
        fx.b0,
        `the durable original base B0 must survive; ${handoffContext}`,
      );
      assert.equal(
        handoffWork?.intent?.kind,
        "candidate_preservation",
        `the durable original intent must survive; ${handoffContext}`,
      );
      assert.equal(
        handoffWork?.target.candidateState?.preserved ?? null,
        null,
        `the rejected acknowledgement must never be durable; ${handoffContext}`,
      );
      assert.deepEqual(
        afterHandoff.value.snapshot.reservations,
        reservationsBefore,
        `accounting must be unchanged by the rejected acknowledgement; ` +
          handoffContext,
      );
      assert.equal(
        await remoteRef(fx.remoteGitDir, env, `refs/heads/${fx.branch}`),
        fx.h0,
        `H0 must remain published; the rejected acknowledgement must not ` +
          `publish H1; ${handoffContext}`,
      );

      // Producer teardown, exactly as the ordinary fixture.
      await Deno.remove(fx.producerDir, { recursive: true });
      await Deno.remove(fx.mirrorDir, { recursive: true });
      await Deno.remove(fx.remoteWork, { recursive: true });

      const childRoot = `${tmp}/child`;
      const childSource = `${childRoot}/source`;
      const childScratch = `${childRoot}/scratch`;
      const observationPath = `${childRoot}/observation.json`;
      await Deno.mkdir(childSource, { recursive: true });
      await Deno.mkdir(childScratch, { recursive: true });
      expectOk(
        await gitRun(childSource, ["init", "-q"], env),
        "child object store init failed",
      );
      assert.equal(
        (await gitRun(childSource, ["rev-list", "--all", "--count"], env))
          .stdout.trim(),
        "0",
        "child object store must start empty",
      );
      assert.equal(
        await hasObject(childSource, env, h1),
        false,
        "the fresh child store must not contain H1 before the child runs",
      );

      const scenario: CandidateHandoffScenarioV1 = {
        repository: { ...REPOSITORY },
        remoteUrl: `file://${fx.remoteGitDir}`,
        remoteGitDir: fx.remoteGitDir,
        stateRemoteUrl: `${tmp}/state.git`,
        childSource,
        childScratch,
        observationPath,
        baseBranch: BASE_BRANCH,
        candidateBranch: fx.branch,
        issueNumber: ISSUE_NUMBER,
        pullRequestNumber: PR_NUMBER,
        trustedPrAuthor: TRUSTED_AUTHOR,
        trustedReviewer: TRUSTED_REVIEWER,
        controllerSha: fx.b0,
        producerHead: h1,
        oldRemoteHead: fx.h0,
        oldBase: fx.b0,
        newBase: b1,
        now: fx.clock.now(),
        stepLimit: 8,
      };
      const observations = await runHandoffWorker(scenario);
      const savedState = JSON.stringify({
        base: observations.targetBase,
        head: observations.targetHead,
        nextStep: observations.targetNextStep,
        intent: observations.targetIntentKind,
        wait: observations.targetWaitReason,
      });
      const context = `${handoffContext} ` +
        `baseFetchOk=${observations.baseFetchOk} ` +
        `fetchedBase=${observations.fetchedBase} ` +
        `h1AbsentBeforeRestore=${observations.h1AbsentBeforeRestore} ` +
        `boundary=${observations.boundary} ` +
        `restore=${JSON.stringify(observations.restore)} ` +
        `publishedHead=${observations.publishedHead} ` +
        `reviewedParents=${JSON.stringify(observations.reviewedParents)} ` +
        `cycle=${observations.cycleStatus}/${observations.cycleDetail}/` +
        `${observations.cycleError} savedState=${savedState}`;
      assertFreshChildCompletion({
        observation: observations,
        h1,
        h0: fx.h0,
        b1,
        reservationsBefore,
        workId: fx.workId,
        context,
      });
      // The child reconciles the SAME H1 operation ref and then preserves the
      // refreshed successor under its own exact base-refresh-bound ref.
      const refsAfterChild = await preservationRefs(fx.remoteGitDir, env);
      assert.equal(
        refsAfterChild.length,
        2,
        `H1 plus the refreshed successor must be preserved; ${context}`,
      );
      const h1RefAfterChild = refsAfterChild.find((entry) => entry.sha === h1);
      assert.equal(
        h1RefAfterChild?.ref,
        expectedOperationRef,
        `the child must reuse the exact H1 operation ref; ${context}`,
      );
      const expectedSuccessorRef = await candidatePreservationRef(
        REPOSITORY,
        fx.workId,
        baseRefreshIntentKey(PR_NUMBER, h1, b1),
      );
      const successorRef = refsAfterChild.find((entry) =>
        entry.ref === expectedSuccessorRef
      );
      assert.ok(
        successorRef !== undefined,
        `the refreshed successor must be preserved under its exact ref; ` +
          context,
      );
      assert.equal(
        successorRef!.sha,
        observations.publishedHead,
        `the refreshed operation ref must carry the published head; ${context}`,
      );
    } finally {
      // A failed removal never replaces the original assertion error.
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "candidate handoff cut 2: a prepared H2 preserved before the task push is resumed from durable state by another empty-store process",
  async () => {
    const tmp = await Deno.makeTempDir({
      prefix: "sentinel-candidate-refresh-crash-",
      dir: ROOT,
    });
    try {
      const fx = await setupCandidateFaultFixture(tmp);
      const env = fx.env;

      // Receipt cut, then bounded one-step calls until the real remote
      // candidate branch actually carries H1. The producer is stopped BEFORE
      // the base refresh: the next step would prepare and preserve H2.
      await fx.runOneStep();
      assert.equal(fx.model.calls, 1, "the fixture model must be called once");
      const h1 = fx.produced[0]!;
      const b1 = await head(fx.remoteWork, env);
      assert.notEqual(b1, fx.b0, "the fixture base must move during the call");
      const MAX_PUBLISH_STEPS = 8;
      let publishSteps = 0;
      let branchNow = await remoteRef(
        fx.remoteGitDir,
        env,
        `refs/heads/${fx.branch}`,
      );
      while (branchNow !== h1 && publishSteps < MAX_PUBLISH_STEPS) {
        const outcome = await fx.runOneStep();
        publishSteps += 1;
        branchNow = await remoteRef(
          fx.remoteGitDir,
          env,
          `refs/heads/${fx.branch}`,
        );
        if (branchNow === h1) break;
        if (outcome.status !== "step_limit") break;
      }
      assert.equal(
        branchNow,
        h1,
        `the real remote must publish H1 before the base refresh; ` +
          `steps=${publishSteps}`,
      );
      const beforeChild = await fx.state.readRepair();
      if (!beforeChild.ok || beforeChild.value.status !== "found") {
        throw new Error("producer state read failed");
      }
      const beforeChildWork = beforeChild.value.snapshot.work.find((work) =>
        work.id === fx.workId
      );
      if (beforeChildWork === undefined) {
        throw new Error("producer work record missing");
      }
      const reservationsBeforeChild = beforeChild.value.snapshot.reservations;
      assert.equal(beforeChildWork.target.head, h1);
      assert.equal(beforeChildWork.target.base, fx.b0);
      assert.equal(beforeChildWork.target.candidateState?.preserved?.head, h1);
      assert.equal(beforeChildWork.target.candidateState?.publishedHead, h1);
      // The producer may already have persisted the base-refresh intent while
      // publishing H1: `ensureBaseRefreshIntent` records the deterministic
      // intent with a null resultId and only the next step prepares (and
      // assigns) the successor, so a null resultId here is valid. Only the
      // exact H1 intent bindings are required here, and the H2 preservation
      // must still be outstanding.
      if (beforeChildWork.intent !== null) {
        assert.equal(beforeChildWork.intent.kind, "base_refresh");
        assert.equal(beforeChildWork.intent.expectedHead, h1);
        assert.equal(beforeChildWork.intent.observedBase, b1);
      }
      const refsBeforeChild = await preservationRefs(fx.remoteGitDir, env);
      assert.equal(
        refsBeforeChild.length,
        1,
        "only the H1 preservation may exist before the refresh",
      );
      assert.equal(refsBeforeChild[0]!.sha, h1);

      // Producer teardown.
      await Deno.remove(fx.producerDir, { recursive: true });
      await Deno.remove(fx.mirrorDir, { recursive: true });
      await Deno.remove(fx.remoteWork, { recursive: true });

      // Child A: fresh empty store; the REAL preservation of the prepared H2
      // completes, then exactly one unavailable is returned before the push.
      const childARoot = `${tmp}/child-a`;
      const childASource = `${childARoot}/source`;
      const childAScratch = `${childARoot}/scratch`;
      const childAObservation = `${childARoot}/observation.json`;
      await Deno.mkdir(childASource, { recursive: true });
      await Deno.mkdir(childAScratch, { recursive: true });
      expectOk(
        await gitRun(childASource, ["init", "-q"], env),
        "child A object store init failed",
      );
      assert.equal(
        (await gitRun(childASource, ["rev-list", "--all", "--count"], env))
          .stdout.trim(),
        "0",
        "child A object store must start empty",
      );
      const scenarioA: CandidateHandoffScenarioV1 = {
        repository: { ...REPOSITORY },
        remoteUrl: `file://${fx.remoteGitDir}`,
        remoteGitDir: fx.remoteGitDir,
        stateRemoteUrl: `${tmp}/state.git`,
        childSource: childASource,
        childScratch: childAScratch,
        observationPath: childAObservation,
        baseBranch: BASE_BRANCH,
        candidateBranch: fx.branch,
        issueNumber: ISSUE_NUMBER,
        pullRequestNumber: PR_NUMBER,
        trustedPrAuthor: TRUSTED_AUTHOR,
        trustedReviewer: TRUSTED_REVIEWER,
        controllerSha: fx.b0,
        producerHead: h1,
        oldRemoteHead: fx.h0,
        oldBase: fx.b0,
        newBase: b1,
        now: fx.clock.now(),
        stepLimit: 8,
        interruptBaseRefreshPreserve: true,
      };
      const observationA = await runHandoffWorker(scenarioA);
      const contextA = `h1=${h1} h0=${fx.h0} b0=${fx.b0} b1=${b1} ` +
        `boundary=${observationA.boundary} fault=${observationA.fault} ` +
        `faultHead=${observationA.faultHead} ` +
        `faultResultId=${observationA.faultResultId} ` +
        `targetIntentResultId=${observationA.targetIntentResultId} ` +
        `targetHead=${observationA.targetHead} ` +
        `faultTargetHead=${observationA.faultTargetHead} ` +
        `faultDescriptorHead=${observationA.faultDescriptorHead} ` +
        `faultPublishedHead=${observationA.faultPublishedHead} ` +
        `publishedHead=${observationA.publishedHead} ` +
        `preserveCalls=${observationA.faultPreserveCalls} ` +
        `cycle=${observationA.cycleStatus}/${observationA.cycleDetail}/` +
        `${observationA.cycleError}`;
      assert.equal(
        observationA.boundary,
        "base_refresh_preserve_unavailable",
        `the child must stop at the bounded preservation interruption; ` +
          contextA,
      );
      assert.equal(
        observationA.fault,
        "base_refresh_preserve_unavailable",
        `the interruption must be the exact base-refresh preserve cut; ` +
          contextA,
      );
      assert.equal(
        observationA.faultUnavailableReturned,
        true,
        `the real preservation must be followed by one unavailable; ` +
          contextA,
      );
      assert.ok(
        observationA.faultHead !== null,
        `the prepared successor H2 must be observed; ${contextA}`,
      );
      const h2 = observationA.faultHead!;
      assert.notEqual(h2, h1);
      assert.equal(
        observationA.faultResultId,
        h2,
        `the durable base_refresh resultId must be the prepared H2; ` +
          contextA,
      );
      assert.equal(
        observationA.targetIntentResultId,
        h2,
        `the persisted intent must retain resultId H2; ${contextA}`,
      );
      assert.equal(
        observationA.targetIntentKind,
        "base_refresh",
        `the durable intent must be the base refresh; ${contextA}`,
      );
      assert.equal(
        observationA.faultTargetHead,
        h1,
        `the durable target must remain H1; ${contextA}`,
      );
      assert.equal(
        observationA.targetHead,
        h1,
        `the durable target must remain H1 after the interruption; ` +
          contextA,
      );
      assert.equal(
        observationA.faultDescriptorHead,
        h1,
        `the retained descriptor must remain H1; ${contextA}`,
      );
      assert.equal(
        observationA.faultPublishedHead,
        h1,
        `the durable published head must remain H1; ${contextA}`,
      );
      assert.equal(
        observationA.modelCalls,
        0,
        `no implementation call is permitted; ${contextA}`,
      );
      assert.equal(
        observationA.reviewSubmissions.length,
        0,
        `no review may be charged before the task push; ${contextA}`,
      );
      assert.equal(
        await remoteRef(fx.remoteGitDir, env, `refs/heads/${fx.branch}`),
        h1,
        `the task ref must remain H1; ${contextA}`,
      );
      const refsAfterA = await preservationRefs(fx.remoteGitDir, env);
      assert.equal(
        refsAfterA.length,
        2,
        `H1 and the really preserved H2 operation refs are required; ` +
          contextA,
      );
      const h1Ref = refsAfterA.find((entry) => entry.sha === h1);
      const h2Ref = refsAfterA.find((entry) => entry.sha === h2);
      assert.ok(
        h1Ref !== undefined,
        `the H1 operation ref must remain; ${contextA}`,
      );
      assert.ok(
        h2Ref !== undefined,
        `the H2 operation ref must remain; ${contextA}`,
      );
      const expectedH2Ref = await candidatePreservationRef(
        REPOSITORY,
        fx.workId,
        baseRefreshIntentKey(PR_NUMBER, h1, b1),
      );
      assert.equal(
        h2Ref!.ref,
        expectedH2Ref,
        `the retained H2 ref must be the exact base-refresh-bound ref; ` +
          contextA,
      );
      const afterChildA = await fx.state.readRepair();
      if (!afterChildA.ok || afterChildA.value.status !== "found") {
        throw new Error("state read after child A failed");
      }
      assert.deepEqual(
        afterChildA.value.snapshot.reservations,
        reservationsBeforeChild,
        `no new review charge may exist at the interruption; ${contextA}`,
      );

      // Child A's process store is deleted; another NEW empty object store
      // resumes strictly after the production poll bound.
      await Deno.remove(childASource, { recursive: true });
      await Deno.remove(childAScratch, { recursive: true });
      await Deno.remove(childARoot, { recursive: true });

      const childBRoot = `${tmp}/child-b`;
      const childBSource = `${childBRoot}/source`;
      const childBScratch = `${childBRoot}/scratch`;
      const childBObservation = `${childBRoot}/observation.json`;
      await Deno.mkdir(childBSource, { recursive: true });
      await Deno.mkdir(childBScratch, { recursive: true });
      expectOk(
        await gitRun(childBSource, ["init", "-q"], env),
        "child B object store init failed",
      );
      assert.equal(
        (await gitRun(childBSource, ["rev-list", "--all", "--count"], env))
          .stdout.trim(),
        "0",
        "child B object store must start empty",
      );
      assert.equal(
        await hasObject(childBSource, env, h2),
        false,
        "the resuming store must not contain H2 before it runs",
      );
      const scenarioB: CandidateHandoffScenarioV1 = {
        ...scenarioA,
        childSource: childBSource,
        childScratch: childBScratch,
        observationPath: childBObservation,
        now: scenarioA.now + FIXTURE_CHECK_POLL_MS + 1,
        interruptBaseRefreshPreserve: undefined,
      };
      const observationB = await runHandoffWorker(scenarioB);
      const savedStateB = JSON.stringify({
        base: observationB.targetBase,
        head: observationB.targetHead,
        nextStep: observationB.targetNextStep,
        intent: observationB.targetIntentKind,
        wait: observationB.targetWaitReason,
      });
      const contextB = `${contextA} | resumedNow=${scenarioB.now} ` +
        `boundary=${observationB.boundary} ` +
        `restore=${JSON.stringify(observationB.restore)} ` +
        `fetchedBase=${observationB.fetchedBase} ` +
        `publishedHead=${observationB.publishedHead} ` +
        `reviewedHead=${observationB.reviewedHead} ` +
        `reviewedParents=${JSON.stringify(observationB.reviewedParents)} ` +
        `cycle=${observationB.cycleStatus}/${observationB.cycleDetail}/` +
        `${observationB.cycleError} savedState=${savedStateB}`;
      assertFreshChildCompletion({
        observation: observationB,
        h1,
        h0: fx.h0,
        b1,
        reservationsBefore: reservationsBeforeChild,
        workId: fx.workId,
        context: contextB,
      });
      assert.equal(
        observationB.publishedHead,
        h2,
        `the resumed process must publish the exact saved H2; ${contextB}`,
      );
      assert.equal(
        observationB.reviewedHead,
        h2,
        `the resumed process must review the exact saved H2; ${contextB}`,
      );
      assert.equal(
        observationB.modelCalls,
        0,
        `the resumed process must not start a model; ${contextB}`,
      );
      const refsAfterB = await preservationRefs(fx.remoteGitDir, env);
      assert.equal(
        refsAfterB.length,
        2,
        `both H1/H2 operation refs must remain after recovery; ${contextB}`,
      );
      assert.equal(
        refsAfterB.find((entry) => entry.sha === h1)?.ref,
        expectedOperationRefOf(refsAfterA, h1),
        `the H1 operation ref identity must not change; ${contextB}`,
      );
      assert.equal(
        refsAfterB.find((entry) => entry.sha === h2)?.ref,
        expectedH2Ref,
        `the H2 operation ref identity must not change; ${contextB}`,
      );
      assert.equal(
        await remoteRef(fx.remoteGitDir, env, `refs/heads/${fx.branch}`),
        h2,
        `the task ref must advance to the exact saved H2; ${contextB}`,
      );
      const afterChildB = await fx.state.readRepair();
      if (!afterChildB.ok || afterChildB.value.status !== "found") {
        throw new Error("state read after child B failed");
      }
      assert.deepEqual(
        afterChildB.value.snapshot.reservations,
        observationB.reservations,
        `the durable accounting must equal the observed accounting; ` +
          contextB,
      );
    } finally {
      // A failed removal never replaces the original assertion error.
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    }
  },
);
