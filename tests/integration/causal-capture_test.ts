/**
 * Plan 01: one safe captured-request repair crosses the REAL repair loop.
 *
 * The actual GatewayReplayComposition (authenticated decrypt → structural
 * sanitizer → deterministic trusted fixture) is composed through the actual
 * composeRepairHost/runComposedRepairHost with the actual ReplayPortImpl
 * (credential-free git, disposable scratch clones, real `deno task replay` /
 * `deno task test` at exact revisions), a trusted causal-proof verifier
 * capability, the real CodexImplementationPort with an in-process fake
 * session/checkout/receipt-verifier, the real GitStateStore with the real
 * RollingStartBudget/DurableGitHubCooldownGate, and the recording FakeGithub.
 *
 * The positive path proves: the incident advances past missing_evidence, the
 * captured request is reproduced as an intended failure with ZERO
 * limitations under a fully bound trusted proof, a candidate is validated,
 * the identical permanent fixture runs through the candidate's ordinary deno
 * task test and passes with zero limitations, a ReplayResultV1 with exact
 * original/candidate/fixture/command/test identities and limitations [] is
 * persisted, and the loop reaches PR/review publication intent via the fake
 * GitHub transport.
 *
 * Negative paths stay blocked or unavailable as appropriate: no
 * verifier/proof, mismatched bundle digest, wrong original SHA, sanitizer
 * removing the failure (text-dependent oracle), and an unrelated nonzero
 * candidate failure — never a fabricated clean proof.
 *
 * A controlled synthetic private sentinel lives inside the authenticated
 * capture; the trusted test verifier consumes it and the test asserts it
 * never appears in committed fixture bytes, the candidate Git tree, fake
 * model/session input, public evidence/state or error text.
 *
 * Dispatch metadata: the committed toy consumer and its permanent regression
 * test select their inputs EXCLUSIVELY through the fixed root
 * `.sentinel-replay-input.json` record written by the trusted verifier (both
 * snapshots) and by the ReplayPort (candidate checkout). A missing dispatcher
 * therefore cannot pass by hardcoded fixture reads, and the metadata carries
 * only the two fixed fixture paths plus the exact ordered trusted test ids.
 * This toy proves the dispatch/selection wiring, not the target gateway
 * converter: the actual converter is tested separately in its own repository.
 *
 * Public synthetic data only; no network, no model call, no credentials.
 */

import {
  argvFlagValue,
  bwrapSetenvValue,
  CONCRETE_VERIFIER_UNSUPPORTED,
  consumerSnapshot,
  LINUX_BWRAP_PATH,
} from "./causal-capture-verifier.ts";
import {
  commitCandidateFixture,
  commitUnrelated,
  makeToyRepo,
} from "./causal-capture-toy.ts";
import {
  makeCausalRig,
  resolveComposedFixture,
  walkFiles,
} from "./causal-capture-rig.ts";
import assert from "node:assert/strict";
import {
  CAUSAL_CONSUMER_COMMAND_ID,
  deriveExpectedFailureIdentity,
  GATEWAY_CAUSAL_VERIFIER_ID,
  gatewayCausalProofRef,
} from "../../src/replay/causal-proof.ts";
import { CAPTURE_ID_A, INCIDENT_A } from "../adapters/gateway/helpers.ts";
import {
  EXPECTED_FAILURE,
  GATEWAY_COMMAND,
  INDEX_PATH,
  REPLAY_PATH,
  SENTINEL,
  TEST_COMMAND,
  TEST_ID,
  TEST_ID_MARKER,
  TRIGGER,
} from "./causal-capture-fixture.ts";
import { REPO } from "./helpers.ts";
import { CAUSAL_SANDBOX_EXEC_PATH } from "../../src/replay/causal-verifier.ts";
import { gitRun } from "../replay/helpers.ts";
import type { GatewayCausalProofV1 } from "../../src/replay/causal-proof.ts";
import { asFixtureDigest, asGitSha } from "../../src/contracts/brands.ts";
import { composeRepairHost } from "../../src/host/repair.ts";
import type { ReplayPortImpl } from "../../src/replay/port.ts";
import type { WorkItemId } from "../../src/contracts/brands.ts";

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "causal capture: one captured request crosses the real repair loop to PR/review intent with a bound proof and zero limitations",
  // True restricted-execution slice on the platforms that HAVE a real
  // boundary: macOS runs the concrete verifier's embedded fixed sandbox-exec
  // Seatbelt profile; Linux runs the identical direct-Deno consumer through
  // the injected LinuxReplayIsolation bubblewrap namespace (--unshare-all,
  // read-only snapshot bind, private tmpfs /tmp). Platforms with no real
  // boundary are explicitly skipped rather than passing without a proof.
  ignore: CONCRETE_VERIFIER_UNSUPPORTED,
  fn: async () => {
    const toy = await makeToyRepo("positive");
    const rig = await makeCausalRig(toy, "positive", {
      concrete: true,
    });
    try {
      // Resolve the composed fixture BEFORE the positive run and commit its
      // exact bytes into the toy candidate (identical permanent fixture).
      const fixture = await resolveComposedFixture(rig);
      assert.notEqual(
        fixture.proof,
        undefined,
        "the concrete verifier must bind a proof",
      );
      const proof = fixture.proof;
      if (proof !== undefined) {
        assert.equal(proof.verifier, GATEWAY_CAUSAL_VERIFIER_ID);
        assert.equal(proof.consumerCommandId, CAUSAL_CONSUMER_COMMAND_ID);
        assert.equal(
          proof.proofRef,
          gatewayCausalProofRef(INCIDENT_A, CAPTURE_ID_A, proof.bundleDigest),
        );
        // Observed execution evidence, distinct from the expected-matcher
        // identity: the concrete verifier actually executed the committed
        // consumer twice and both runs failed for the intended specific
        // failure. The expected-failure identity is a classification label,
        // never an observed execution signature.
        assert.equal(
          proof.expectedFailureIdentity,
          await deriveExpectedFailureIdentity(EXPECTED_FAILURE),
        );
        for (
          const observation of [
            proof.originalObservation,
            proof.sanitizedObservation,
          ]
        ) {
          assert.equal(observation.intended, true);
          assert.match(observation.outputDigest, /^[0-9a-f]{64}$/);
          assert.deepEqual(observation.observedTestIds, [TEST_ID]);
          assert.equal(observation.exitCode, 1);
        }
      }
      const candidateSha = await commitCandidateFixture(toy, fixture.entries);
      assert.notEqual(candidateSha, toy.originalSha);
      rig.setCandidateHead(candidateSha);
      const unrelatedSha = await commitUnrelated(toy);
      assert.notEqual(unrelatedSha, candidateSha);

      const outcome1 = await rig.run(60 * 60_000);
      assert.equal(outcome1.status, "idle", JSON.stringify(outcome1));
      const state = await rig.snapshot();

      // The incident advanced past missing_evidence through the real loop.
      assert.equal(state.incidents.length, 1);
      const incident = state.work.find((work) =>
        work.source.kind === "incident"
      )!;
      assert.ok(incident, "incident work item must exist");
      assert.equal(incident.related.incidentId, INCIDENT_A);
      assert.equal(incident.failingRevision, toy.originalSha);
      assert.equal(incident.nextStep, "review");
      assert.equal(incident.wait?.reason, "review_pending");
      assert.equal(incident.target.head, candidateSha);
      assert.ok(incident.target.pr !== null, "PR published");

      // Exactly one sequential implementation session for the incident.
      assert.equal(rig.sessions.length, 1);
      assert.equal(rig.sessions[0]!.closeCalls, 1);

      // PR/review publication intent through the fake GitHub transport.
      assert.equal(rig.github.publishedHeads.length, 1);
      assert.equal(rig.github.publishedHeads[0], candidateSha);
      assert.ok(
        rig.github.calls.includes(`createPr:${incident.target.pr}`),
        "PR created",
      );
      assert.ok(
        rig.github.calls.includes("requestReview"),
        "review requested",
      );

      // A durable ReplayResultV1 with exact identities and limitations [].
      assert.equal(state.replays.length, 1);
      const replay = state.replays[0]!;
      assert.equal(replay.repository.owner, REPO.owner);
      assert.equal(replay.repository.name, REPO.name);
      assert.equal(replay.repository.installationId, REPO.installationId);
      assert.equal(replay.original.revision, toy.originalSha);
      assert.equal(replay.original.outcome, "failed");
      assert.equal(replay.original.failure?.intended, true);
      assert.equal(replay.candidate.revision, candidateSha);
      assert.equal(replay.candidate.outcome, "passed");
      assert.equal(replay.fixture.ref, fixture.fixtureRef);
      assert.equal(replay.fixture.digest, fixture.fixtureDigest);
      assert.deepEqual(replay.fixture.testIds, [TEST_ID]);
      assert.equal(replay.commands.replay, GATEWAY_COMMAND);
      assert.equal(replay.commands.test, TEST_COMMAND);
      assert.deepEqual(replay.limitations, []);
      assert.ok(replay.id.length > 0);

      // The retained evidence carries the composed replay identity.
      assert.equal(state.evidence.length, 1);
      assert.equal(state.evidence[0]!.replay?.commandId, GATEWAY_COMMAND);

      // Runtime evidence: the real before-failure and after-pass executions.
      const targetRuns = rig.replayRuntime.runs.filter((run) =>
        run.input.executable === "deno"
      );
      assert.ok(targetRuns.length >= 2, "before + after executions");
      const afterRun = targetRuns[targetRuns.length - 1]!;
      // Every before execution runs the configured replay command at the
      // exact original revision and fails for the intended reason.
      for (const run of targetRuns.slice(0, -1)) {
        assert.deepEqual(run.input.args, ["task", "replay"]);
        assert.equal(run.exitCode, 1, "original revision must fail");
        assert.ok(run.outputText.includes(TEST_ID_MARKER));
        assert.ok(
          run.outputText.includes("stream terminated unexpectedly"),
          "original failure is for the intended reason",
        );
      }
      // The final execution is the candidate's ordinary deno task test.
      assert.deepEqual(afterRun.input.args, ["task", "test"]);
      assert.equal(afterRun.exitCode, 0, "candidate task test must pass");
      assert.ok(afterRun.outputText.includes(TEST_ID_MARKER));

      // The exact composed bundle ran through the concrete verifier: the
      // private original request/upstream and the sanitized bundle both
      // executed the SAME committed consumer at the original SHA under the
      // REAL restricted-execution boundary for this platform — macOS: the
      // embedded fixed sandbox-exec seatbelt profile (DENO/SNAPSHOT/CACHE
      // realpath-resolved substitution parameters, cwd = the snapshot); Linux:
      // the injected LinuxReplayIsolation bubblewrap namespace with the exact
      // snapshot bound read-only at its own absolute path — and both failed
      // for the intended specific failure.
      const verifierRuns = rig.replayRuntime.runs.filter((run) =>
        run.input.executable ===
          (Deno.build.os === "darwin"
            ? CAUSAL_SANDBOX_EXEC_PATH
            : LINUX_BWRAP_PATH)
      );
      assert.ok(verifierRuns.length >= 2, "original + sanitized consumer runs");

      // Snapshot evidence comes ONLY from the actual per-platform boundary
      // argv, never from the outer runtime cwd.
      const consumerSnapshots = verifierRuns.map((run) =>
        consumerSnapshot(run.input.args, Deno.build.os)
      );
      assert.ok(
        consumerSnapshots.every((value) =>
          value !== null && value.startsWith("/")
        ),
        "exact realpath-resolved snapshot paths",
      );
      assert.equal(
        new Set(consumerSnapshots).size,
        verifierRuns.length,
        "each consumer run sees only its own unique snapshot",
      );

      if (Deno.build.os === "darwin") {
        for (const run of verifierRuns) {
          const args = run.input.args;
          assert.equal(args[0], "-p", "fixed embedded seatbelt profile");
          assert.ok(
            args.includes("--no-config") && args.includes("--no-remote"),
            "fixed no-config/no-remote consumer protocol",
          );
          assert.equal(
            args[args.length - 1],
            `${run.input.cwd}/scripts/replay.ts`,
            "the fixed bound consumer at its own snapshot path",
          );
          assert.ok(
            !args.includes("task"),
            "verifier never runs deno task",
          );
          assert.equal(run.exitCode, 1, "consumer must fail at original SHA");
          assert.ok(run.outputText.includes(TEST_ID_MARKER));
          assert.ok(
            run.outputText.includes("stream terminated unexpectedly"),
            "consumer failure is the intended specific failure",
          );
        }
        // Each run has its OWN home/cache and sees only its OWN snapshot.
        const [firstConsumer, secondConsumer] = verifierRuns;
        assert.notEqual(firstConsumer!.input.cwd, secondConsumer!.input.cwd);
        assert.notEqual(
          firstConsumer!.input.env.HOME,
          secondConsumer!.input.env.HOME,
          "no shared home between original and sanitized executions",
        );
        assert.notEqual(
          firstConsumer!.input.env.DENO_DIR,
          secondConsumer!.input.env.DENO_DIR,
          "no shared cache between original and sanitized executions",
        );
        assert.ok(
          firstConsumer!.input.env.HOME.includes("home-original"),
          "original run home is its own",
        );
        assert.ok(
          secondConsumer!.input.env.HOME.includes("home-sanitized"),
          "sanitized run home is its own",
        );
      } else {
        // Linux: each snapshot is the ACTUAL `--chdir` of the recorded bwrap
        // argv, never the outer runtime cwd (which is `/` for every bwrap
        // spawn).
        assert.ok(
          verifierRuns.every((run) => run.input.cwd === "/"),
          "Linux isolation spawns bwrap from / and enters via --chdir",
        );
        for (let index = 0; index < verifierRuns.length; index += 1) {
          const run = verifierRuns[index]!;
          const args = run.input.args;
          const snapshot = consumerSnapshots[index]!;
          for (
            const flag of [
              "--unshare-all",
              "--clearenv",
              "--new-session",
              "--die-with-parent",
            ]
          ) {
            assert.ok(args.includes(flag), `fixed ${flag} boundary flag`);
          }
          assert.equal(
            argvFlagValue(args, "--tmpfs"),
            "/tmp",
            "private tmpfs /tmp per namespace",
          );
          // The fixed sandbox HOME/DENO_DIR strings are identical in both
          // recorded runs, but each run owns an unshared namespace with its
          // own tmpfs /tmp, so no home or cache is shared between the
          // original and sanitized executions.
          assert.equal(bwrapSetenvValue(args, "HOME"), "/tmp/home");
          assert.equal(bwrapSetenvValue(args, "DENO_DIR"), "/tmp/deno");
          // The exact snapshot is bound READ-ONLY at its own absolute path
          // and never read-write.
          assert.ok(
            args.some((arg, argIndex) =>
              arg === "--ro-bind" && args[argIndex + 1] === snapshot &&
              args[argIndex + 2] === snapshot
            ),
            "the exact snapshot is --ro-bind at its own absolute path",
          );
          assert.equal(
            args.some((arg, argIndex) =>
              arg === "--bind" &&
              (args[argIndex + 1] === snapshot ||
                args[argIndex + 2] === snapshot)
            ),
            false,
            "no read-write --bind of the private snapshot checkout",
          );
          assert.ok(
            args.includes("--no-config") && args.includes("--no-remote"),
            "fixed no-config/no-remote consumer protocol",
          );
          assert.ok(!args.includes("task"), "verifier never runs deno task");
          assert.equal(
            args[args.length - 1],
            `${snapshot}/scripts/replay.ts`,
            "the fixed bound consumer at its own snapshot path",
          );
          assert.equal(run.exitCode, 1, "consumer must fail at original SHA");
          assert.ok(run.outputText.includes(TEST_ID_MARKER));
          assert.ok(
            run.outputText.includes("stream terminated unexpectedly"),
            "consumer failure is the intended specific failure",
          );
        }
      }

      // The identical permanent fixture ran through the candidate's ordinary
      // deno task test and passed: the committed bytes equal the composed
      // fixture bytes exactly.
      for (const entry of fixture.entries) {
        const committed = await gitRun(
          toy.root,
          ["show", `${candidateSha}:${entry.path}`],
          toy.env,
        );
        assert.ok(
          committed.ok,
          `fixture path missing in candidate: ${entry.path}`,
        );
        assert.deepEqual(
          new TextEncoder().encode(committed.stdout),
          entry.bytes,
          `candidate ${entry.path} must byte-match the composed fixture`,
        );
      }

      // The private sentinel never appears in committed fixture bytes, the
      // candidate Git tree, fake model/session input, public evidence/state
      // or the composed fixture bytes.
      const treeGrep = await gitRun(
        toy.root,
        ["grep", "-l", SENTINEL, candidateSha, "--", "."],
        toy.env,
      );
      assert.ok(
        treeGrep.code !== 0,
        `sentinel leaked into the candidate tree: ${treeGrep.stdout}`,
      );
      assert.ok(!JSON.stringify(fixture.entries).includes(SENTINEL));
      assert.ok(!JSON.stringify(state).includes(SENTINEL));
      assert.ok(
        !JSON.stringify(rig.sessions[0]!.sent).includes(SENTINEL),
        "sentinel leaked into fake model/session input",
      );
      const checkoutFiles = await walkFiles(`${rig.ctx.tmp}/model-checkout`);
      for (const file of checkoutFiles) {
        const text = await Deno.readTextFile(file);
        assert.ok(
          !text.includes(SENTINEL),
          `sentinel leaked into model checkout: ${file}`,
        );
      }

      // Read-only producer transport; one retained encrypted artifact.
      rig.transport.assertReadOnly([INDEX_PATH, REPLAY_PATH]);
      rig.transport.assertNoWriteEndpoints();
      const storeStats = await rig.gatewayStore.stats();
      assert.ok(storeStats.ok && storeStats.value.count === 1);
    } finally {
      await rig.cleanup();
      await toy.cleanup();
    }
  },
});

Deno.test(
  "causal capture: no verifier/proof keeps the redacted fixture blocked at missing_evidence",
  async () => {
    const toy = await makeToyRepo("noverifier");
    const rig = await makeCausalRig(toy, "noverifier");
    try {
      const first = await rig.run();
      assert.equal(first.status, "idle", JSON.stringify(first));
      const state = await rig.snapshot();
      const incident = state.work.find((work) =>
        work.source.kind === "incident"
      )!;
      assert.equal(incident.nextStep, "blocked");
      assert.equal(incident.blocker?.kind, "missing_evidence");
      assert.equal(rig.sessions.length, 0, "no implementation admitted");
      assert.equal(state.replays.length, 0, "no fabricated clean replay");
      assert.equal(
        rig.github.calls.some((call) =>
          call === "createPr" || call.startsWith("push:")
        ),
        false,
        "no publication without a bound proof",
      );
      // The fixture stays redacted and the loop's before-run recorded the
      // truthful limitation.
      assert.equal(
        rig.replayRuntime.runs.filter((run) => run.input.executable === "deno")
          .length,
        1,
        "one bound redacted before-run, no other target command",
      );
    } finally {
      await rig.cleanup();
      await toy.cleanup();
    }
  },
);

Deno.test({
  name:
    "causal capture: mismatched proof identities (bundle digest, original SHA) stay blocked as missing evidence",
  ignore: CONCRETE_VERIFIER_UNSUPPORTED,
  fn: async () => {
    const variants: Array<{
      name: string;
      verifier: (m: GatewayCausalProofV1) => GatewayCausalProofV1 | null;
    }> = [
      {
        name: "wrong bundle digest",
        verifier: (proof) => ({
          ...proof,
          bundleDigest: asFixtureDigest("d".repeat(64)),
        }),
      },
      {
        name: "wrong original SHA",
        verifier: (proof) => ({
          ...proof,
          originalGitSha: asGitSha("2".repeat(40)),
        }),
      },
    ];
    for (const variant of variants) {
      const slug = `mismatch-${variant.name.replaceAll(" ", "-")}`;
      const toy = await makeToyRepo(slug);
      const rig = await makeCausalRig(toy, slug, {
        concrete: true,
        mutateProof: variant.verifier,
      });
      try {
        const first = await rig.run();
        assert.equal(first.status, "idle", JSON.stringify(first));
        const state = await rig.snapshot();
        const incident = state.work.find((work) =>
          work.source.kind === "incident"
        )!;
        assert.equal(
          incident.nextStep,
          "blocked",
          `${variant.name} must stay blocked`,
        );
        assert.equal(
          incident.blocker?.kind,
          "missing_evidence",
          `${variant.name} must block on missing evidence`,
        );
        assert.equal(rig.sessions.length, 0, "no implementation admitted");
        assert.equal(state.replays.length, 0, "no clean replay fabricated");
      } finally {
        await rig.cleanup();
        await toy.cleanup();
      }
    }
  },
});

Deno.test({
  name:
    "causal capture: a redaction-damaged (text-dependent) capture cannot be causally proved and stays blocked",
  ignore: CONCRETE_VERIFIER_UNSUPPORTED,
  fn: async () => {
    const toy = await makeToyRepo("textdamage");
    const rig = await makeCausalRig(toy, "textdamage", {
      concrete: true,
      capture: {
        completed: true,
        bodyInput:
          `{"model":"synthetic-model","input":"${TRIGGER}","stream":true}`,
      },
    });
    try {
      // The verifier refuses a proof when the sanitized fixture loses the
      // private trigger: the fixture cannot reproduce the original failure.
      const fixture = await resolveComposedFixture(rig);
      assert.equal(
        fixture.proof,
        undefined,
        "redaction-damaged fixture must carry no trusted proof",
      );
      // The private trigger and sentinel stay out of the composed fixture.
      assert.ok(!JSON.stringify(fixture.entries).includes(TRIGGER));
      assert.ok(!JSON.stringify(fixture.entries).includes(SENTINEL));

      const first = await rig.run();
      assert.equal(first.status, "idle", JSON.stringify(first));
      const state = await rig.snapshot();
      const incident = state.work.find((work) =>
        work.source.kind === "incident"
      )!;
      assert.equal(incident.nextStep, "blocked");
      assert.equal(incident.blocker?.kind, "missing_evidence");
      assert.equal(rig.sessions.length, 0);
      assert.equal(state.replays.length, 0);
    } finally {
      await rig.cleanup();
      await toy.cleanup();
    }
  },
});

Deno.test({
  name:
    "causal capture: an unrelated candidate failure never publishes and never fabricates a clean replay",
  ignore: CONCRETE_VERIFIER_UNSUPPORTED,
  fn: async () => {
    const toy = await makeToyRepo("unrelated");
    const rig = await makeCausalRig(toy, "unrelated", {
      concrete: true,
    });
    try {
      const fixture = await resolveComposedFixture(rig);
      assert.notEqual(fixture.proof, undefined);
      await commitCandidateFixture(toy, fixture.entries);
      const unrelatedSha = await commitUnrelated(toy);
      rig.setCandidateHead(unrelatedSha);

      // Direct boundary evidence: the identical fixture fails INTENDED at the
      // exact original revision with zero limitations, and the unrelated
      // revision never matches the expected failure.
      const deps = composeRepairHost(rig.options);
      const beforeRunExact = await (deps.replay as ReplayPortImpl).runReplay({
        taskId: "incident:gateway-causal-0001" as WorkItemId,
        repository: REPO,
        revision: toy.originalSha,
        commandId: GATEWAY_COMMAND,
        fixtureRef: fixture.fixtureRef,
        fixtureDigest: fixture.fixtureDigest,
        testIds: [TEST_ID],
        outputLimitBytes: 262_144,
      });
      assert.ok(beforeRunExact.ok, JSON.stringify(beforeRunExact));
      if (beforeRunExact.ok) {
        assert.equal(beforeRunExact.value.outcome, "failed");
        assert.equal(beforeRunExact.value.failure?.intended, true);
        assert.deepEqual(beforeRunExact.value.limitations, []);
      }
      const unrelatedRun = await (deps.replay as ReplayPortImpl).runReplay({
        taskId: "incident:gateway-causal-0001" as WorkItemId,
        repository: REPO,
        revision: unrelatedSha,
        commandId: TEST_COMMAND,
        fixtureRef: fixture.fixtureRef,
        fixtureDigest: fixture.fixtureDigest,
        testIds: [TEST_ID],
        outputLimitBytes: 262_144,
      });
      assert.ok(unrelatedRun.ok, JSON.stringify(unrelatedRun));
      if (unrelatedRun.ok) {
        assert.equal(unrelatedRun.value.outcome, "failed");
        assert.equal(unrelatedRun.value.failure?.intended, false);
      }

      // The full loop with the unrelated head: no publication, no fabricated
      // clean replay, and no review request; the record stays non-terminal.
      const first = await rig.run();
      assert.ok(
        first.status === "idle" || first.status === "step_limit",
        JSON.stringify(first),
      );
      const state = await rig.snapshot();
      const incident = state.work.find((work) =>
        work.source.kind === "incident"
      )!;
      assert.notEqual(incident.nextStep, "review", "never reviewed");
      assert.ok(rig.sessions.length >= 1, "implementation attempted");
      assert.equal(state.replays.length, 0);
      assert.equal(rig.github.publishedHeads.length, 0, "never published");
      assert.equal(
        rig.github.calls.some((call) => call === "requestReview"),
        false,
        "no review request for an unrelated failure",
      );
    } finally {
      await rig.cleanup();
      await toy.cleanup();
    }
  },
});
