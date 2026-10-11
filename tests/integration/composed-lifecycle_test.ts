/**
 * Wave C composed local lifecycle acceptance (MASTER-PLAN.md §9.1 items 1–2)
 * through the ACTUAL host-runner seams (`src/host/run.ts`) composed over
 * real module constructors, injected fake external transports and disposable
 * REAL local Git repositories.
 *
 * ONE composed trusted host drives the whole repair lifecycle:
 *
 *   runComposedRepairHost(options, { deadline, stepLimit })
 *     → runRepairEntrypoint(composeRepairHost(options), ...)
 *
 * with: the real GatewayIncidentAdapter + real LocalArtifactStore +
 * GatewayReplayComposition over a recording scripted producer transport; the
 * real ReplayPortImpl (credential-free git, disposable scratch clones, real
 * `deno task test` executions at exact revisions); the real
 * CodexImplementationPort with an injected in-process fake Codex session and
 * a trusted-host receipt verifier that certifies ONLY the app-server
 * evidence the session itself acknowledged (gpt-reserve / max / completed);
 * the real GitStateStore (repair + release roles on one disposable bare
 * remote) with the real RollingStartBudget/DurableGitHubCooldownGate; and
 * the recording FakeGithub port (exact-head merge, per-head PR numbers) with
 * a second eligible issue work item injected through the real issue intake.
 *
 * Scope covered:
 * - unresolved incident discovery (real adapter over the producer wire) and
 *   retained evidence/replay composition (authenticated decrypt →
 *   structural sanitizer → deterministic trusted fixture);
 * - before-failure fixture path AS FAR AS THE TRUTHFUL REDACTION CONTRACT
 *   PERMITS: the composed gateway fixture is provenance-redacted, so a real
 *   replay of the exact original revision fails for the intended reason AND
 *   carries the truthful `fixture_redacted` limitation; the repair loop's
 *   bound fixture-metadata consumer runs the replay and blocks on that
 *   limitation — no implementation is invented and no gate is weakened. The SAME composed
 *   ReplayPortImpl is then invoked directly at the exact original and toy
 *   candidate revisions to prove the redacted before-failure and
 *   after-pass outcomes truthfully (the after pass carries the SAME
 *   redaction limitation, never a fabricated clean replay); the clean
 *   non-redacted before/after proof is owned by the m03 module suite with a
 *   trusted non-redacted fixture bundle.
 * - one implementation result per issue work item (real Codex port,
 *   injected session/verifier/checkout seams — NO model call, NO network),
 *   deterministic PR publication, pending review, a SECOND eligible work
 *   item advanced by the SAME single writer while the first review waits
 *   (sequential sessions; no duplicate review request or extra budget
 *   charge on observation), later completed review bound to the EXACT head,
 *   exact-head merge, and one open release request per merged item;
 * - deterministic release promotion/monitoring/acceptance through the real
 *   runReleaseEntrypoint over the composeReleaseHost dependency set (with
 *   the trusted host clock-advancing waiter, the same integration-helper
 *   pattern) and the authenticated fixture-bound GitHub build-receipt wire
 *   (immutable receipt archive, scripted fetch on api.github.com only) and
 *   the scripted Deno platform (204 promotion, exact identity proof,
 *   60×30s continuous samples, accepted record);
 * - issue/delivery bookkeeping: the accepted request's issue is closed
 *   (closure-only retry semantics) and the record reaches `done`; the
 *   second (receipt-less) request stays in its typed unavailable wait and the
 *   redaction-limited incident stays blocked on missing evidence;
 * - the truthful release-receipt boundary: the ONLY authentic build receipt
 *   available in this harness is the immutable fixture receipt bound to the
 *   fixture producer commit, so requests for any other merged revision
 *   cannot resolve a receipt (the composed release host reports the typed
 *   waiting detail and performs zero Deno platform calls/promotions) — a
 *   live authentic GitHub receipt for the exact merged SHA is the recorded
 *   activation boundary, never invented here.
 *
 * Every external transport is the injected fake: no real model, network,
 * GitHub, Deno Deploy or credential is used; every outbound call is recorded
 * and asserted to be GET-only against the frozen producer/index paths (no
 * claim/ack/defer), api.github.com/objects.githubusercontent.com for the
 * fixture wire, and the scripted Deno hosts for the platform.
 */
import { makeToyRepo } from "./composed-lifecycle-toy.ts";
import { makeRepairRig } from "./composed-lifecycle-rig.ts";
import { composeRepairHost } from "../../src/host/repair.ts";
import assert from "node:assert/strict";
import { GatewayReplayComposition } from "../../src/adapters/gateway/replay-composition.ts";
import { ReplayPortImpl } from "../../src/replay/port.ts";
import { CodexImplementationPort } from "../../src/repair/model-port.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { REPO, SHA1 } from "./helpers.ts";
import { CAPTURE_ID_A, INCIDENT_A } from "../adapters/gateway/helpers.ts";
import type { CommandId, WorkItemId } from "../../src/contracts/brands.ts";
import {
  GATEWAY_COMMAND,
  INDEX_PATH,
  REPLAY_PATH,
  TEST_ID,
} from "./composed-lifecycle-capture.ts";
import {
  ISSUE1_REVISION_ID,
  makeReleaseRig,
  PRODUCER_COMMIT,
} from "./composed-lifecycle-release.ts";
import { submittedTaskAcceptance } from "./composed-lifecycle-ports.ts";
import { DenoReleaseRESTClient } from "../../src/release/port.ts";
import { GithubBuildReceiptResolver } from "../../src/release/build-receipt-resolver.ts";
import { DEP_0 } from "../release/helpers.ts";

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

Deno.test(
  "composed host: exact capability identity and boundary preservation",
  async () => {
    const toy = await makeToyRepo("identity");
    const rig = await makeRepairRig(toy, "identity");
    try {
      const deps = composeRepairHost(rig.options);
      // The composition is BOTH the IncidentAdapter and the fixture-identity
      // source; the replay port resolves fixtures through that exact instance.
      assert.ok(deps.incidents instanceof GatewayReplayComposition);
      assert.equal(deps.fixtureIdentities, deps.incidents);
      assert.ok(deps.replay instanceof ReplayPortImpl);
      assert.ok(deps.model instanceof CodexImplementationPort);
      assert.ok(deps.budget instanceof RollingStartBudget);
      assert.equal(deps.clock, rig.options.clock);
      assert.equal(deps.state, rig.options.state);
      assert.equal(deps.github, rig.options.github);
      assert.equal(deps.githubCooldown, rig.options.githubCooldown);
      assert.equal(deps.controllerSha, SHA1);
      assert.equal(deps.configs.length, 1);
      // Constructing the factory performed no external effect whatsoever.
      assert.equal(rig.transport.requests.length, 0);
      assert.equal(rig.sessions.length, 0);
      assert.equal(rig.replayRuntime.runs.length, 0);
      assert.equal(rig.github.calls.length, 0);
    } finally {
      await rig.cleanup();
      await toy.cleanup();
    }
  },
);

Deno.test(
  "composed lifecycle: discovery, redacted replay boundary, one implementation, second item while review waits, exact-head merge, release requests, deterministic release acceptance and issue bookkeeping",
  async () => {
    const toy = await makeToyRepo("lifecycle");
    const rig = await makeRepairRig(toy, "lifecycle");
    try {
      const deps = composeRepairHost(rig.options);

      // ---- Run 1: everything through runComposedRepairHost. --------------
      const first = await rig.run();
      assert.equal(first.status, "idle", JSON.stringify(first));

      const state1 = await rig.snapshot();
      // Ingested: one P1 incident + two issue work items (the second is the
      // eligible companion advanced while the first review waits).
      assert.equal(state1.incidents.length, 1);
      assert.equal(state1.incidents[0]!.fingerprint, rig.fingerprint);
      assert.equal(state1.work.length, 3);
      assert.equal(state1.work[0]!.nextStep, "blocked");
      assert.equal(state1.work[0]!.blocker?.kind, "missing_evidence");
      const incident = state1.work.find((work) =>
        work.source.kind === "incident"
      )!;
      assert.ok(incident);
      assert.equal(incident.related.incidentId, INCIDENT_A);
      assert.equal(incident.failingRevision, toy.originalSha);
      // Truthful redaction boundary: the bound fixture resolver reaches the
      // real replay port, which records the redaction limitation and blocks
      // before any implementation can be admitted. No clean replay result is
      // fabricated for the incident.
      assert.equal(incident.nextStep, "blocked");
      assert.equal(incident.blocker?.kind, "missing_evidence");
      assert.equal(
        rig.replayRuntime.runs.filter((run) => run.executable === "deno")
          .length,
        1,
        "the composed loop ran the redacted before replay once",
      );

      // The SAME composed chain is then invoked DIRECTLY to prove the
      // redacted before-failure boundary truthfully at the exact original
      // revision: readIncident → resolveTestIds → composed ReplayPortImpl.
      // This is direct-port evidence of the redaction contract alongside the
      // loop's bound fixture-metadata consumer; it is never mistaken for a
      // clean loop verification.
      const composedRead = await (deps.incidents as GatewayReplayComposition)
        .readIncident(INCIDENT_A);
      assert.ok(composedRead.ok, JSON.stringify(composedRead));
      assert.ok(composedRead.value !== null, JSON.stringify(composedRead));
      if (composedRead.ok && composedRead.value !== null) {
        const beforeIds = await (deps.incidents as GatewayReplayComposition)
          .resolveTestIds(
            composedRead.value.replay!.fixtureRef,
            composedRead.value.replay!.fixtureDigest!,
          );
        assert.ok(beforeIds.ok, JSON.stringify(beforeIds));
        const beforeRun = await (deps.replay as ReplayPortImpl).runReplay({
          taskId: "incident:toy-0001" as WorkItemId,
          repository: REPO,
          revision: toy.originalSha,
          commandId: GATEWAY_COMMAND,
          fixtureRef: composedRead.value.replay!.fixtureRef,
          fixtureDigest: composedRead.value.replay!.fixtureDigest!,
          testIds: [TEST_ID],
          outputLimitBytes: 262_144,
        });
        assert.ok(beforeRun.ok, JSON.stringify(beforeRun));
        if (beforeRun.ok) {
          assert.equal(beforeRun.value.outcome, "failed");
          assert.equal(beforeRun.value.exitCode, 1);
          assert.equal(beforeRun.value.failure?.intended, true);
          assert.deepEqual(beforeRun.value.limitations, ["fixture_redacted"]);
        }
      }
      const issueOne = state1.work.find((work) =>
        work.source.kind === "issue" && work.related.issueNumber === 1
      )!;
      const issueTwo = state1.work.find((work) =>
        work.source.kind === "issue" && work.related.issueNumber === 2
      )!;
      assert.ok(issueOne && issueTwo, "both issues are eligible work items");

      // Retained evidence: the composed replay identity (decrypt → sanitize
      // → deterministic fixture) is attached and the restricted store holds
      // exactly one encrypted artifact.
      assert.equal(state1.evidence.length, 1);
      const evidence = state1.evidence[0]!;
      assert.equal(evidence.incidentId, INCIDENT_A);
      assert.equal(evidence.failingRevision, toy.originalSha);
      assert.ok(evidence.replay, "composed replay metadata attached");
      assert.match(
        evidence.replay!.fixtureRef,
        new RegExp(
          `^fixture://gateway-replay/${INCIDENT_A}/${CAPTURE_ID_A}/[0-9a-f]{64}$`,
        ),
      );
      assert.equal(evidence.replay!.commandId, GATEWAY_COMMAND);
      const storeStats = await rig.gatewayStore.stats();
      assert.ok(
        storeStats.ok && storeStats.value.count === 1,
        "one retained encrypted artifact",
      );

      // The loop's redacted before-run and the DIRECT composed before-run
      // both execute at the exact original revision through the real
      // ReplayPortImpl. The recorded runtime captures two target commands
      // (`deno task test`) in disposable clones of the toy source.
      const targetRuns1 = rig.replayRuntime.runs.filter((run) =>
        run.executable === "deno"
      );
      assert.equal(targetRuns1.length, 2);
      const before = targetRuns1[1]!;
      assert.deepEqual(before.args, ["task", "test"]);
      assert.match(before.cwd, /sentinel-replay-/);
      assert.equal(before.exitCode, 1, "original revision must fail");
      assert.ok(before.outputText.includes(`sentinel-replay-test:${TEST_ID}`));
      assert.ok(
        before.outputText.includes("stream terminated unexpectedly"),
        "failure is for the intended reason",
      );

      // ONE implementation result for the first issue; the SECOND work item
      // advanced by the SAME single writer while the first review waits:
      // sequential session calls, one PR per exact head, one review request
      // each, and the durable budget charge for every start.
      assert.equal(rig.sessions.length, 2, "exactly two sequential sessions");
      assert.equal(rig.sessions[0]!.closeCalls, 1, "session settled");
      assert.equal(rig.sessions[1]!.closeCalls, 1, "session settled");
      assert.equal(issueOne.nextStep, "review");
      assert.equal(issueOne.wait?.reason, "review_pending");
      assert.equal(issueOne.target.head, PRODUCER_COMMIT);
      assert.equal(issueOne.target.pr, 7);
      assert.equal(issueOne.counters.reviewRounds, 1);
      assert.equal(issueTwo.nextStep, "review");
      assert.equal(issueTwo.wait?.reason, "review_pending");
      assert.equal(issueTwo.target.head, toy.candidateSha);
      assert.equal(issueTwo.target.pr, 8);
      assert.equal(issueTwo.counters.reviewRounds, 1);
      assert.equal(rig.github.pushes.length, 2);
      assert.deepEqual(rig.github.pushes.map((push) => push.sha), [
        PRODUCER_COMMIT,
        toy.candidateSha,
      ]);
      assert.equal(
        rig.github.calls.filter((call) => call === "requestReview").length,
        2,
        "one review request per head, no duplicate on observation",
      );
      assert.equal(
        state1.reservations.filter((reservation) =>
          reservation.outcome === "submitted"
        ).length,
        4,
        "implementation + review for both items are charged exactly once",
      );
      assert.equal(
        state1.replays.length,
        0,
        "no clean replay result fabricated",
      );

      // Read-only producer transport: index + replay export only; never a
      // claim/ack/defer or other write endpoint.
      rig.transport.assertReadOnly([INDEX_PATH, REPLAY_PATH]);
      rig.transport.assertNoWriteEndpoints();

      // ---- The SAME composed ReplayPort at the toy candidate revision:
      // the truthful after-pass result (passed WITH the redaction limitation,
      // which the loop never accepts as a clean verification). ------------
      const testIds = await deps.fixtureIdentities?.resolveTestIds(
        evidence.replay!.fixtureRef,
        evidence.replay!.fixtureDigest!,
      );
      assert.ok(testIds?.ok, JSON.stringify(testIds));
      const after = await deps.replay.runReplay({
        taskId: incident.id as WorkItemId,
        repository: REPO,
        revision: toy.candidateSha,
        commandId: "test" as CommandId,
        fixtureRef: evidence.replay!.fixtureRef,
        fixtureDigest: evidence.replay!.fixtureDigest!,
        testIds: [...(testIds!.value as readonly string[])],
        outputLimitBytes: 262_144,
      });
      assert.ok(after.ok, JSON.stringify(after));
      if (after.ok) {
        assert.equal(after.value.outcome, "passed");
        assert.equal(after.value.exitCode, 0);
        assert.deepEqual(after.value.limitations, ["fixture_redacted"]);
      }
      const targetRuns2 = rig.replayRuntime.runs.filter((run) =>
        run.executable === "deno"
      );
      assert.equal(
        targetRuns2.length,
        3,
        "one loop before-run plus one direct before-run and one direct after-run through the same composed ReplayPort",
      );

      // ---- Run 2: the first review completes; issue one merges exactly. --
      rig.clock.advance(15 * 60_000 + 1);
      rig.github.reviewStatus = "completed";
      rig.github.reviewObservations = {
        status: "completed",
        requestId: "review-req-1",
        reviewer: "chatgpt-codex-connector[bot]",
        resultId: "result-1",
        completedAt: rig.clock.now(),
        observedHead: PRODUCER_COMMIT,
        observedBase: toy.originalSha,
        findings: [],
        summary: null,
        receivedAt: rig.clock.now() + 1,
        taskAcceptance: submittedTaskAcceptance(
          rig.github.reviewRequestTasks,
          1,
        ),
      };
      const second = await rig.run();
      assert.equal(second.status, "idle", JSON.stringify(second));
      const state2 = await rig.snapshot();
      const issueOneAfter = state2.work.find((work) =>
        work.source.kind === "issue" && work.related.issueNumber === 1
      )!;
      const issueTwoAfter = state2.work.find((work) =>
        work.source.kind === "issue" && work.related.issueNumber === 2
      )!;
      // The first completed head merged exactly and waits at the release
      // acceptance consumer; a completed review bound to ANOTHER head never
      // advances issue two.
      assert.equal(issueOneAfter.nextStep, "delivery");
      assert.equal(issueOneAfter.wait?.reason, "unavailable");
      assert.equal(issueTwoAfter.nextStep, "review");
      assert.equal(issueTwoAfter.wait?.reason, "review_pending");
      assert.deepEqual(rig.github.mergedHeads, [PRODUCER_COMMIT]);
      assert.equal(state2.releaseRequests.length, 1);
      const requestOne = state2.releaseRequests[0]!;
      assert.equal(requestOne.revision, PRODUCER_COMMIT);
      assert.equal(requestOne.source.pullRequest, 7);
      assert.equal(requestOne.source.head, PRODUCER_COMMIT);
      assert.equal(requestOne.status, "open");

      // ---- Run 3: the second review completes; issue two merges exactly.
      // Its request can never resolve the immutable receipt (documented as
      // the truthful activation boundary below). --------------------------
      rig.clock.advance(15 * 60_000 + 1);
      rig.github.reviewObservations = {
        status: "completed",
        requestId: "review-req-1",
        reviewer: "chatgpt-codex-connector[bot]",
        resultId: "result-1",
        completedAt: rig.clock.now(),
        observedHead: toy.candidateSha,
        observedBase: toy.originalSha,
        findings: [],
        summary: null,
        receivedAt: rig.clock.now() + 1,
        taskAcceptance: submittedTaskAcceptance(
          rig.github.reviewRequestTasks,
          2,
        ),
      };
      const third = await rig.run();
      assert.equal(third.status, "idle", JSON.stringify(third));
      const state3 = await rig.snapshot();
      assert.deepEqual(rig.github.mergedHeads, [
        PRODUCER_COMMIT,
        toy.candidateSha,
      ]);
      assert.equal(state3.releaseRequests.length, 2);
      const requestTwo = state3.releaseRequests.find((request) =>
        request.source.pullRequest === 8
      )!;
      assert.ok(requestTwo);
      assert.equal(requestTwo.revision, toy.candidateSha);
      assert.equal(requestTwo.status, "open");

      // ---- Composed release host WITHOUT a resolver (production default):
      // typed waiting, zero Deno platform calls, zero promotion, zero release
      // records — no authentic credential/receipt is wired into the harness.
      const noResolver = makeReleaseRig(rig.ctx, toy.candidateSha, false);
      const waiting = await noResolver.run();
      assert.ok(waiting.ok, JSON.stringify(waiting));
      if (waiting.ok) {
        assert.equal(waiting.value.status, "waiting");
        assert.equal(waiting.value.detail, "build receipt is unavailable");
      }
      assert.equal(
        noResolver.transport.calls.length,
        0,
        "no Deno platform call",
      );
      assert.equal(noResolver.promoteCalls(), 0, "no promotion attempt");
      assert.equal((await noResolver.records()).length, 0, "no release record");

      // ---- Composed release host WITH the authenticated fixture wire: the
      // first request (fixture producer commit) resolves the immutable
      // receipt, promotes (204), proves the exact managed identity and the
      // scheduled entrypoint completes the 60×30s monitoring window before
      // returning. --------------------------------------------------------
      const released = makeReleaseRig(rig.ctx, toy.candidateSha, true);
      assert.ok(released.deps.deno instanceof DenoReleaseRESTClient);
      assert.ok(
        released.deps.resolver instanceof GithubBuildReceiptResolver,
      );
      const begun = await released.run();
      assert.ok(begun.ok, JSON.stringify(begun));
      if (begun.ok) assert.equal(begun.value.status, "advanced");
      const done = await released.run();
      assert.ok(done.ok, JSON.stringify(done));
      assert.equal(released.promoteCalls(), 1, "exactly one promotion");
      let records = await released.records();
      assert.equal(records.length, 1);
      const accepted = records[0]!;
      assert.equal(accepted.requestId, requestOne.id);
      assert.equal(accepted.phase, "accepted");
      assert.equal(accepted.candidate.identity.gitSha, PRODUCER_COMMIT);
      assert.equal(accepted.candidate.identity.revisionId, ISSUE1_REVISION_ID);
      assert.equal(accepted.prior.identity.gitSha, DEP_0.gitSha);
      assert.equal(accepted.receipts.promote?.statusCode, 204);
      assert.ok(accepted.acceptance);
      assert.equal(accepted.acceptance!.samples.length, 60);
      assert.equal(accepted.acceptance!.baseline.length, 60);
      assert.equal(accepted.acceptance!.continuous, true);
      assert.equal(accepted.acceptance!.passed, true);
      assert.ok(
        released.transport.calls.every((call) =>
          call.host === "api.deno.com" ||
          call.host === "ai.ubq.fi" ||
          call.host.endsWith(".ubiquity-dao.deno.net")
        ),
        `unexpected Deno host: ${JSON.stringify(released.transport.calls[0])}`,
      );

      // Second cycle: the remaining request has no matching push run for its
      // revision, so the immutable receipt cannot bind (typed waiting/absent);
      // no promotion and no second record is fabricated.
      const secondCycle = await released.run();
      assert.ok(secondCycle.ok, JSON.stringify(secondCycle));
      if (secondCycle.ok) {
        assert.equal(
          secondCycle.value.status === "waiting" ||
            secondCycle.value.status === "idle",
          true,
          JSON.stringify(secondCycle.value),
        );
      }
      assert.equal(released.promoteCalls(), 1, "no second promotion");
      records = await released.records();
      assert.equal(records.length, 1, "no record for the receipt-less request");

      // ---- Run 4: the repair loop observes the accepted release and
      // performs the issue/delivery bookkeeping: the accepted request's issue
      // is closed (closure-only retry) and the record reaches `done`; the
      // receipt-less request stays in its typed unavailable wait while the
      // redaction-limited incident remains blocked on missing evidence. -----
      rig.clock.advance(5 * 60_000 + 1);
      const fourth = await rig.run();
      assert.equal(fourth.status, "idle", JSON.stringify(fourth));
      const state4 = await rig.snapshot();
      const issueOneFinal = state4.work.find((work) =>
        work.source.kind === "issue" && work.related.issueNumber === 1
      )!;
      const issueTwoFinal = state4.work.find((work) =>
        work.source.kind === "issue" && work.related.issueNumber === 2
      )!;
      const incidentFinal = state4.work.find((work) =>
        work.source.kind === "incident"
      )!;
      assert.equal(issueOneFinal.nextStep, "done");
      assert.ok(
        rig.github.calls.includes("closeIssue:1"),
        "issue closure bookkeeping happened",
      );
      assert.equal(issueTwoFinal.nextStep, "delivery");
      assert.equal(
        issueTwoFinal.wait?.reason,
        "unavailable",
        "typed wait at the release acceptance consumer",
      );
      assert.equal(incidentFinal.nextStep, "blocked");
      assert.equal(
        incidentFinal.blocker?.kind,
        "missing_evidence",
        "the redaction-limited incident stays blocked on missing evidence",
      );
      assert.equal(state4.releaseRequests.length, 2);
      // No model start for the incident or after acceptance.
      assert.equal(rig.sessions.length, 2);
      assert.equal(
        state4.reservations.filter((reservation) =>
          reservation.outcome === "submitted"
        ).length,
        4,
      );

      // Every interaction stayed on the injected fake ports/transports.
      assert.ok(
        rig.github.calls.every((call) =>
          /^listOpenIssues$|^readRef:|^readIssue:|^findPr:|^readPr:|^push:|^assignIssue:\d+$|^createPr(?::\d+)?$|^observeReview$|^requestReview$|^merge$|^closeIssue:/
            .test(call)
        ),
        `unexpected github calls: ${rig.github.calls.join(", ")}`,
      );
      assert.ok(
        released.wire.calls.every((call) =>
          call.url.host === "api.github.com" ||
          call.url.host === "objects.githubusercontent.com"
        ),
        "the receipt wire stayed on the scripted GitHub origins",
      );
      assert.ok(
        rig.sessions.every((session) => session.closeCalls === 1),
        "every fake session settled in-process",
      );
    } finally {
      await rig.cleanup();
      await toy.cleanup();
    }
  },
);
