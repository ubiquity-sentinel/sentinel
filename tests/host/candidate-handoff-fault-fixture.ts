/** Shared credential-free hosted test fixtures; this module registers no tests. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portError } from "../../src/contracts/ports.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  createPrepareBaseRefresh,
  unavailableIncidents,
  unavailableReplay,
} from "../../src/host/local.ts";
import {
  createActionsCandidateRestorer,
  createCandidatePreserver,
} from "../../src/host/actions-candidates.ts";
import { composeGitHubHost } from "../../src/host/github.ts";
import { runRepairEntrypoint } from "../../src/main.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { candidateBranch, workItemIdForIssue } from "../../src/repair/keys.ts";
import { createRepairStateStore } from "../../src/state/mod.ts";
import { FakeAuthProvider, FakeReviewService } from "../github/helpers.ts";
import { FakeClock } from "../repair/helpers.ts";
import { repairReadThrough } from "./hosted-autonomy-rig.ts";
import {
  gitRun,
  reservation,
  reviewReceipt,
  T0,
  workRecord,
} from "../state/helpers.ts";
import {
  createExactCandidateLoader,
  createRemoteRefReader,
  makeRefReadingTransport,
} from "./candidate-handoff-worker.ts";
import {
  BASE_BRANCH,
  expectOk,
  gitEnv,
  handoffRepositoryConfig,
  hasObject,
  head,
  ISSUE_NUMBER,
  NOW,
  PR_NUMBER,
  PRODUCER_BRANCH,
  ProducerModel,
  remoteRef,
  REPOSITORY,
  TRUSTED_AUTHOR,
  TRUSTED_PATH,
  TRUSTED_REVIEWER,
} from "./candidate-handoff-fixture.ts";

// ---------------------------------------------------------------------------
// M14 V10: two REAL crash cuts through the same production consumers.
//
// Cut 1: the remote H1 preservation succeeds, but the acknowledgement that
// would attach the descriptor to durable repair state is never applied.
//
// Cut 2: the prepared H2 successor of a base refresh is REALLY preserved
// before the task push, then the child returns one bounded `unavailable`.
// Another process with a NEW empty object store resumes from the saved H2.
// ---------------------------------------------------------------------------

/** Production `CHECK_POLL_MS`, used only as a fixture clock offset. */
export const FIXTURE_CHECK_POLL_MS = 5 * 60_000;

/** Static safe detail for the fixture's injected acknowledgement rejection. */
const INJECTED_ACK_UNAVAILABLE_DETAIL =
  "fixture injected preservation acknowledgement rejection";

export interface PreservationRefV1 {
  ref: string;
  sha: GitSha;
}

/** Actual operation-bound refs on the bare remote, read without writing. */
export async function preservationRefs(
  gitDir: string,
  env: Record<string, string>,
): Promise<PreservationRefV1[]> {
  const read = await gitRun(gitDir, [
    "--git-dir",
    gitDir,
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/heads/sentinel-candidates/",
  ], env);
  if (!read.ok) return [];
  const refs: PreservationRefV1[] = [];
  for (const line of read.stdout.split("\n")) {
    const [ref, sha] = line.trim().split(/\s+/);
    if (ref === undefined || sha === undefined) continue;
    if (!/^refs\/heads\/sentinel-candidates\/[0-9a-f]{64}$/.test(ref)) continue;
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    refs.push({ ref, sha: sha as GitSha });
  }
  return refs.sort((left, right) => left.ref.localeCompare(right.ref));
}

/**
 * Shared parent-side fixture: real bare remote (development B0, candidate H0),
 * private producer repository, trusted source mirror, real repair state seeded
 * with the rejected current-head review and the real production host wiring.
 *
 * `interceptPreservationAcknowledgement` installs the cut-1 fault on the
 * producer's OWN state writer: the exact transition that clears a pending
 * `candidate_preservation` intent while attaching the descriptor is never
 * applied. The caller receives a genuine static `unavailable` error, so the
 * interrupted producer stops at that boundary with the durable intent intact
 * for the fresh-child recovery. All other writes and every read stay on the
 * real store.
 */
export async function setupCandidateFaultFixture(
  tmp: string,
  options: { interceptPreservationAcknowledgement?: boolean } = {},
) {
  const home = `${tmp}/home`;
  await Deno.mkdir(home, { recursive: true });
  const env = gitEnv(home);

  const remoteGitDir = `${tmp}/remote.git`;
  const remoteWork = `${tmp}/remote-work`;
  expectOk(
    await gitRun(tmp, ["init", "-q", "--bare", remoteGitDir], env),
    "fixture bare remote init failed",
  );
  await Deno.mkdir(remoteWork, { recursive: true });
  expectOk(
    await gitRun(remoteWork, ["init", "-q"], env),
    "fixture work init failed",
  );
  expectOk(
    await gitRun(remoteWork, ["checkout", "-q", "-b", BASE_BRANCH], env),
    "fixture development checkout failed",
  );
  await Deno.writeTextFile(`${remoteWork}/shared.txt`, "shared B0\n");
  expectOk(await gitRun(remoteWork, ["add", "-A"], env), "fixture add");
  expectOk(
    await gitRun(remoteWork, ["commit", "-q", "-m", "base B0"], env),
    "fixture base commit failed",
  );
  const b0 = await head(remoteWork, env);
  expectOk(
    await gitRun(
      remoteWork,
      ["remote", "add", "origin", `file://${remoteGitDir}`],
      env,
    ),
    "fixture remote add failed",
  );
  expectOk(
    await gitRun(remoteWork, ["push", "-q", "origin", BASE_BRANCH], env),
    "fixture base push failed",
  );

  const workId = workItemIdForIssue(REPOSITORY, ISSUE_NUMBER);
  const branch = candidateBranch(workId);
  expectOk(
    await gitRun(remoteWork, ["checkout", "-q", "-b", branch], env),
    "fixture candidate branch failed",
  );
  await Deno.writeTextFile(`${remoteWork}/candidate.txt`, "candidate H0\n");
  expectOk(await gitRun(remoteWork, ["add", "-A"], env), "fixture add");
  expectOk(
    await gitRun(remoteWork, ["commit", "-q", "-m", "candidate H0"], env),
    "fixture candidate commit failed",
  );
  const h0 = await head(remoteWork, env);
  expectOk(
    await gitRun(
      remoteWork,
      ["push", "-q", "origin", `refs/heads/${branch}`],
      env,
    ),
    "fixture candidate push failed",
  );
  expectOk(
    await gitRun(remoteWork, ["checkout", "-q", BASE_BRANCH], env),
    "fixture return to development failed",
  );
  assert.notEqual(h0, b0, "fixture candidate must differ from the base");
  assert.equal(
    await remoteRef(remoteGitDir, env, `refs/heads/${BASE_BRANCH}`),
    b0,
    "fixture remote development must be B0",
  );
  assert.equal(
    await remoteRef(remoteGitDir, env, `refs/heads/${branch}`),
    h0,
    "fixture remote candidate branch must be H0",
  );

  const producerDir = `${tmp}/producer`;
  const mirrorDir = `${tmp}/mirror`;
  await Deno.mkdir(producerDir, { recursive: true });
  expectOk(
    await gitRun(producerDir, ["init", "-q"], env),
    "producer init failed",
  );
  expectOk(
    await gitRun(
      producerDir,
      ["remote", "add", "origin", `file://${remoteGitDir}`],
      env,
    ),
    "producer remote add failed",
  );
  expectOk(
    await gitRun(
      producerDir,
      ["fetch", "-q", "origin", `refs/heads/${branch}`],
      env,
    ),
    "producer fetch failed",
  );
  expectOk(
    await gitRun(
      producerDir,
      ["checkout", "-q", "-b", PRODUCER_BRANCH, "FETCH_HEAD"],
      env,
    ),
    "producer checkout failed",
  );
  await Deno.mkdir(mirrorDir, { recursive: true });
  expectOk(
    await gitRun(mirrorDir, ["init", "-q"], env),
    "mirror init failed",
  );
  expectOk(
    await gitRun(
      mirrorDir,
      ["remote", "add", "origin", `file://${remoteGitDir}`],
      env,
    ),
    "mirror remote add failed",
  );
  expectOk(
    await gitRun(mirrorDir, [
      "fetch",
      "-q",
      "origin",
      `refs/heads/${BASE_BRANCH}`,
      `refs/heads/${branch}`,
    ], env),
    "mirror fetch failed",
  );

  expectOk(
    await gitRun(tmp, ["init", "-q", "--bare", `${tmp}/state.git`], env),
    "state bare init failed",
  );
  const state = createRepairStateStore({
    scratchDir: `${tmp}/state-scratch`,
    remoteUrl: `${tmp}/state.git`,
  });
  state.readRepair = repairReadThrough(
    state.readRepair.bind(state),
    `${tmp}/state.git`,
  );
  let ackRejections = 0;
  if (options.interceptPreservationAcknowledgement === true) {
    const original = state.writeRepair.bind(state);
    state.writeRepair = async (next, expectedHead) => {
      if (expectedHead !== null) {
        const current = await state.readRepair();
        if (
          current.ok && current.value.status === "found" &&
          current.value.head === expectedHead
        ) {
          const before = current.value.snapshot.work.find((work) =>
            work.id === workId
          );
          const after = next.work.find((work) => work.id === workId);
          const beforeCandidate = before?.target.candidateState;
          const afterCandidate = after?.target.candidateState;
          if (
            before !== undefined && before.intent?.kind ===
              "candidate_preservation" &&
            beforeCandidate !== undefined &&
            beforeCandidate.preserved === null &&
            after !== undefined && after.intent === null &&
            afterCandidate !== undefined && afterCandidate.preserved !== null
          ) {
            // Injected acknowledgement loss: the descriptor transition is
            // NEVER applied and no state write occurs. The caller observes a
            // genuine static `unavailable` boundary instead of a forged
            // `applied`, so the interrupted producer stops here rather than
            // inventing a follow-on transition from a forged head; the durable
            // preservation intent survives for the fresh child.
            ackRejections += 1;
            return portError("unavailable", INJECTED_ACK_UNAVAILABLE_DETAIL);
          }
        }
      }
      return await original(next, expectedHead);
    };
  }

  const seeded = parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: [
      workRecord(workId, {
        repository: REPOSITORY,
        source: { kind: "issue", id: String(ISSUE_NUMBER), revision: b0 },
        related: { incidentId: null, issueNumber: ISSUE_NUMBER },
        failingRevision: b0,
        classification: { severity: "P3", priority: null },
        controller: { sha: b0 },
        target: {
          base: b0,
          branch,
          checkpoint: null,
          head: h0,
          pr: PR_NUMBER,
        },
        nextStep: "work",
        counters: { attempts: 1, retries: 0, reviewRounds: 1 },
        firstSeenAt: T0,
        createdAt: T0 + 100,
        updatedAt: T0 + 1000,
      }),
    ],
    reservations: [
      reservation("reservation-48-review", {
        repository: REPOSITORY,
        taskId: workId,
        attempt: 1,
        head: h0,
        purpose: "review_request",
        createdAt: T0 - 5000,
        outcome: "submitted",
        settledAt: T0 - 4000,
        proofRef: null,
      }),
    ],
    reviews: [
      reviewReceipt("review-51-h0", {
        requestId: "review-request-51",
        expectedReviewer: TRUSTED_REVIEWER,
        observedReviewer: TRUSTED_REVIEWER,
        repository: REPOSITORY,
        pullRequest: { number: PR_NUMBER, head: h0, base: b0 },
        outcome: "completed",
        resultId: "result-51-h0",
        summary: null,
        findings: [{
          id: "finding-51-1",
          severity: "P1",
          path: "candidate.txt",
          message: "correction required",
          fingerprint: "e".repeat(64),
          resolved: false,
          resolutionEvidence: null,
        }],
        findingsUncounted: 0,
        unresolvedSeverities: ["P1"],
        submittedAt: T0 - 2000,
        completedAt: T0 - 1000,
        observedAt: T0 - 500,
      }),
    ],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
  const seededWrite = await state.writeRepair(seeded, null);
  assert.ok(
    seededWrite.ok && seededWrite.value.status === "applied",
    "fixture repair state seed failed",
  );

  const clock = new FakeClock(NOW);
  const gate = new DurableGitHubCooldownGate({ state, clock });
  const config = handoffRepositoryConfig();
  const http = makeRefReadingTransport({
    repository: REPOSITORY,
    pullRequestNumber: PR_NUMBER,
    issueNumber: ISSUE_NUMBER,
    candidateBranch: branch,
    baseBranch: BASE_BRANCH,
    trustedPrAuthor: TRUSTED_AUTHOR,
    readRef: createRemoteRefReader(remoteGitDir, env),
  });
  const host = composeGitHubHost({
    repository: REPOSITORY,
    http,
    auth: new FakeAuthProvider(),
    cooldownGate: gate,
    clock,
    reviewService: new FakeReviewService(),
    trustedPrAuthor: TRUSTED_AUTHOR,
    trustedReviewer: TRUSTED_REVIEWER,
    trustedResolutionAuthors: [TRUSTED_AUTHOR],
    includeIssueRelations: true,
    git: {
      localDir: mirrorDir,
      remoteUrl: `file://${remoteGitDir}`,
      gitHome: home,
      gitPath: "git",
    },
  });
  const candidates = createActionsCandidateRestorer({
    state,
    gate,
    token: "candidate-handoff-fixture-token",
    http,
    clock,
    sourcePath: mirrorDir,
    scratch: home,
    trustedPath: TRUSTED_PATH,
    gitExecutable: "git",
    remoteUrl: `file://${remoteGitDir}`,
    apiBaseUrl: "https://api.github.com",
  });
  host.port.prepareBaseRefresh = createPrepareBaseRefresh({
    git: host.git,
    observer: host.port,
    baseBranch: BASE_BRANCH,
    trustedPrAuthor: TRUSTED_AUTHOR,
    ensureCandidateObjects: (value) => candidates.ensure(value),
  });
  host.port.preserveCandidate = createCandidatePreserver({
    state,
    gate,
    token: "candidate-handoff-fixture-token",
    http,
    clock,
    sourcePath: mirrorDir,
    scratch: home,
    trustedPath: TRUSTED_PATH,
    gitExecutable: "git",
    remoteUrl: `file://${remoteGitDir}`,
    apiBaseUrl: "https://api.github.com",
    port: host.port,
    protectedPaths: config.protectedPaths,
    ensureLocalCandidate: createExactCandidateLoader({
      sourcePath: mirrorDir,
      env,
    }),
  });

  const produced: GitSha[] = [];
  const produceH1 = async (): Promise<GitSha> => {
    await Deno.writeTextFile(
      `${producerDir}/candidate.txt`,
      "candidate H1 correction\n",
    );
    expectOk(
      await gitRun(producerDir, ["add", "-A"], env),
      "producer add failed",
    );
    expectOk(
      await gitRun(producerDir, ["commit", "-q", "-m", "candidate H1"], env),
      "producer commit failed",
    );
    const h1 = await head(producerDir, env);
    produced.push(h1);
    expectOk(
      await gitRun(
        mirrorDir,
        ["fetch", "--no-tags", producerDir, PRODUCER_BRANCH],
        env,
      ),
      "mirror import failed",
    );
    assert.equal(
      await hasObject(mirrorDir, env, h1),
      true,
      "H1 objects must exist in the trusted source mirror after import",
    );
    await Deno.writeTextFile(`${remoteWork}/base-moved.txt`, "moved B1\n");
    expectOk(
      await gitRun(remoteWork, ["add", "-A"], env),
      "base add failed",
    );
    expectOk(
      await gitRun(remoteWork, ["commit", "-q", "-m", "base B1"], env),
      "base commit failed",
    );
    expectOk(
      await gitRun(remoteWork, ["push", "-q", "origin", BASE_BRANCH], env),
      "base push failed",
    );
    return h1;
  };
  const model = new ProducerModel(produceH1);
  const budget = new RollingStartBudget({ clock, state, configs: [config] });
  const entrypointDeps = {
    clock,
    state,
    configs: [config],
    controllerSha: b0,
    github: host.port,
    githubCooldown: gate,
    incidents: unavailableIncidents,
    replay: unavailableReplay,
    model,
    budget,
  };
  const runOneStep = () =>
    runRepairEntrypoint(entrypointDeps, {
      deadline: clock.now() + 60 * 60_000,
      stepLimit: 1,
    });

  return {
    tmp,
    home,
    env,
    remoteGitDir,
    remoteWork,
    producerDir,
    mirrorDir,
    branch,
    workId,
    b0,
    h0,
    state,
    clock,
    gate,
    config,
    host,
    candidates,
    model,
    produced,
    runOneStep,
    ackRejections: () => ackRejections,
  };
}
