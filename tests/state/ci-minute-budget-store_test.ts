import {
  acceptedCiMinutePolicy,
  CI_MINUTE_MAX_BYTES,
  CI_MINUTE_MAX_CATALOG_RUNS,
  CI_MINUTE_MAX_RECORDS,
  INACTIVE_CI_MINUTE_POLICY,
  parseCiMinuteLedger,
  validateCiMinuteTransition,
} from "../../src/contracts/ci-minute-budget.ts";
import type {
  CiMinuteCoordinatorV1,
  CiMinuteObserverV1,
  CiMinuteReconcilerFactoryV1,
} from "../../src/contracts/ci-minute-budget.ts";
import assert from "node:assert/strict";
import { ciMinuteDigest } from "../../src/contracts/ci-minute-budget.ts";
import {
  ciStateGitArgs,
  composePrivateCiMinutes,
  createHostedPrivateCiCapabilities,
} from "../../src/host/hosted-app-principal.ts";
import {
  readHostedPrivateCiData,
  readHostedPrivateCiScope,
} from "../../src/host/hosted-app-principal-native.ts";
import { createPrivateCiEffectResolver } from "../../ops/hosted-autonomy-github-jobs.ts";
import { principalNativeFixture } from "../host/hosted-app-principal-fixtures.ts";
import { GitCiMinuteStore } from "../../src/state/ci-minute-budget-store.ts";
import { DenoGitRunner } from "../../src/state/state-git.ts";
import type { GitRunnerV1 } from "../../src/state/state-git.ts";
import {
  CI_MINUTE_PRIVATE_REMOTE,
  CI_MINUTE_REF,
  ciPolicyDigest,
  ciTerminalEstimateDigest,
} from "../../src/contracts/ci-minute-budget.ts";
import type {
  CiMinuteJobProofV1,
  CiMinuteLedgerV1,
} from "../../src/contracts/ci-minute-budget.ts";
import {
  createCiMinuteController,
  proposedCiMinutePolicy,
} from "../../src/budget/ci-minutes.ts";
import { verifyCiMinuteSchedulingBasis } from "../../src/budget/ci-minutes.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";

const ACCEPTANCE = "a".repeat(64);
const NOW = Date.UTC(2028, 0, 31);
function estimatedJob(job: CiMinuteJobProofV1): CiMinuteJobProofV1 {
  assert.ok(job.estimate);
  return {
    ...job,
    estimate: {
      ...job.estimate,
      terminalProofDigest: ciTerminalEstimateDigest(job),
    },
  };
}
async function fixture() {
  await Deno.mkdir(".data/ci-minute-tests", { recursive: true });
  const tmp = await Deno.makeTempDir({
    dir: ".data/ci-minute-tests",
    prefix: "store-",
  });
  const path = await Deno.realPath(tmp);
  const bare = `${path}/remote.git`;
  const git = new DenoGitRunner(path);
  const init = await git.runGit(["init", "--bare", bare], { cwd: path });
  assert.equal(init.ok, true, init.stderr);
  const make = (runner: GitRunnerV1 = git) =>
    new GitCiMinuteStore({
      remoteUrl: bare,
      scratchDir: `${path}/scratch`,
      runner,
      storageAcceptance: ACCEPTANCE,
    });
  const ledger: CiMinuteLedgerV1 = {
    version: 1,
    month: "2028-01",
    policyDigest: ciPolicyDigest(proposedCiMinutePolicy()),
    updatedAt: NOW,
    sequence: 1,
    baselineMinutes: 0,
    watermark: NOW,
    reservations: [],
    observed: [],
  };
  return {
    path,
    bare,
    git,
    make,
    ledger,
    cleanup: () => Deno.remove(path, { recursive: true }),
  };
}

Deno.test("CI sidecar real Git: reads never bootstrap and two writers cannot spend the same CAS head", async () => {
  const f = await fixture();
  try {
    const first = f.make(), second = f.make();
    assert.deepEqual(await first.read("2028-01"), {
      ok: true,
      value: { head: null, ledger: null },
    });
    const refs = await f.git.runGit(["for-each-ref", "--format=%(refname)"], {
      cwd: f.bare,
    });
    assert.equal(refs.stdout.trim(), "");
    const saved = await first.write({ expectedHead: null, ledger: f.ledger });
    assert.ok(saved.ok && saved.value.status === "applied");
    const read = await first.read("2028-01");
    assert.ok(
      read.ok && read.value.head !== null && read.value.ledger !== null,
    );
    const a = { ...f.ledger, sequence: 2, updatedAt: NOW + 1 };
    const b = { ...f.ledger, sequence: 2, updatedAt: NOW + 2 };
    const raced = await Promise.all([
      first.write({ expectedHead: read.value.head, ledger: a }),
      second.write({ expectedHead: read.value.head, ledger: b }),
    ]);
    assert.equal(
      raced.filter((r) => r.ok && r.value.status === "applied").length,
      1,
    );
    assert.equal(
      raced.filter((r) => r.ok && r.value.status === "conflict").length,
      1,
    );
    const body = await f.git.runGit([
      "show",
      `${CI_MINUTE_REF}:ci-minutes/ubiquity/2028-01.json`,
    ], { cwd: f.bare });
    assert.ok(body.ok);
    assert.equal(body.stdout.includes("remote.git"), false);
    assert.equal(body.stdout.includes(f.path), false);
  } finally {
    await f.cleanup();
  }
});

Deno.test("CI sidecar real Git: lost push acknowledgement reconciles exact candidate", async () => {
  const f = await fixture();
  try {
    let lost = false;
    const wrapper: GitRunnerV1 = {
      async runGit(args, options) {
        const result = await f.git.runGit(args, options);
        if (args[0] === "push" && result.ok && !lost) {
          lost = true;
          return {
            ok: false,
            code: 1,
            stdout: "",
            stderr: "simulated lost response",
          };
        }
        return result;
      },
    };
    const saved = await f.make(wrapper).write({
      expectedHead: null,
      ledger: f.ledger,
    });
    assert.ok(saved.ok && saved.value.status === "applied");
    const read = await f.make().read("2028-01");
    assert.ok(read.ok && read.value.ledger?.sequence === 1);
    assert.equal(lost, true);
  } finally {
    await f.cleanup();
  }
});

Deno.test("CI sidecar refuses history erasure and keeps previous months", async () => {
  const f = await fixture();
  try {
    f.ledger.reservations.push({
      effectDigest: ACCEPTANCE,
      policyDigest: f.ledger.policyDigest,
      ceilingMinutes: 20,
      state: "ambiguous",
      createdAt: NOW,
      settledAt: null,
      chargedMinutes: 20,
      proofDigest: null,
    });
    const store = f.make();
    const saved = await store.write({ expectedHead: null, ledger: f.ledger });
    assert.ok(saved.ok && saved.value.head !== null);
    const bad = await store.write({
      expectedHead: saved.value.head,
      ledger: { ...f.ledger, sequence: 2, reservations: [] },
    });
    assert.equal(bad.ok, false);
    const february = { ...f.ledger, month: "2028-02", sequence: 1 };
    const next = await store.write({
      expectedHead: saved.value.head,
      ledger: february,
    });
    assert.ok(next.ok && next.value.status === "applied");
    const old = await store.read("2028-01");
    assert.ok(old.ok && old.value.ledger?.reservations.length === 1);
  } finally {
    await f.cleanup();
  }
});

Deno.test("CI private snapshot: orphan root and atomic cursor/proof recovery contain state only", async () => {
  const f = await fixture();
  try {
    const identity = { repositoryId: 101, runId: 11, attempt: 1, jobId: 101 };
    const proof = {
      digest: ciMinuteDigest(identity),
      effectDigest: null,
      startedAt: NOW - 1000,
      completedAt: NOW,
      neverStarted: false,
      terminal: true,
      billedDurationMs: 61000,
      identity,
    };
    f.ledger.watermark = null;
    f.ledger.progress = {
      month: "2028-01",
      through: NOW,
      windowFrom: NOW - 86400000,
      windowThrough: NOW,
      targetIndex: 0,
      cursor: {
        queryDigest: ACCEPTANCE,
        runPage: 1,
        runOffset: 1,
        attempt: 1,
        jobPage: 1,
        jobsSeen: 0,
        runDigest: ACCEPTANCE,
        pageDigest: ACCEPTANCE,
      },
      jobs: [proof],
      completedAttempts: [ACCEPTANCE],
    };
    f.ledger.proofs = [proof];
    const saved = await f.make().write({
      expectedHead: null,
      ledger: f.ledger,
    });
    assert.ok(saved.ok && saved.value.status === "applied");
    const recovered = await f.make().read("2028-01");
    assert.ok(recovered.ok && recovered.value.ledger);
    assert.deepEqual(recovered.value.ledger.progress, f.ledger.progress);
    assert.deepEqual(recovered.value.ledger.proofs, [proof]);
    assert.equal(recovered.value.ledger.watermark, null);
    const parents = await f.git.runGit([
      "rev-list",
      "--parents",
      "-n",
      "1",
      CI_MINUTE_REF,
    ], { cwd: f.bare });
    assert.equal(parents.stdout.trim().split(/\s+/).length, 1);
    const tree = await f.git.runGit([
      "ls-tree",
      "-r",
      "--name-only",
      CI_MINUTE_REF,
    ], { cwd: f.bare });
    assert.equal(tree.stdout.trim(), "ci-minutes/ubiquity/2028-01.json");
  } finally {
    await f.cleanup();
  }
});

Deno.test("CI OFF composition: no authority/grant, scratch, meter or store work", async () => {
  let touched = 0;
  const fail = () => {
    touched++;
    throw new Error("OFF touched private authority");
  };
  const input = {
    policy: proposedCiMinutePolicy(),
    clock: { now: fail },
    scratch: "/not-used/ci-minutes-private",
    authority: fail,
    billingBasis: fail,
  };
  const off = composePrivateCiMinutes(input);
  assert.equal(off.active, false);
  assert.deepEqual(
    await off.reserve({
      repository: { owner: "fixture", name: "first", installationId: 1 },
      kind: "pr_open",
      head: null,
      base: null,
      ref: "",
      pr: null,
    }, 1),
    { kind: "inactive" },
  );
  assert.equal(touched, 0);
  assert.equal(JSON.stringify(off).includes("fixture-token"), false);
  assert.equal(
    await createHostedPrivateCiCapabilities(
      { kind: "hosted_app_principal_context" },
      "/not-used/ci-minutes-private",
      1,
    ),
    null,
  );
  assert.equal(ciStateGitArgs(["clone", "https://example.invalid"]), false);
  assert.equal(
    ciStateGitArgs(["push", "origin", "a".repeat(40) + ":refs/heads/main"]),
    false,
  );
});

Deno.test("CI private scope: Scope200 alone, expired, wrong-repo, read-only and public visibility never grant writer", async () => {
  for (
    const mode of ["valid", "expired", "wrong_repo", "read_only", "public"]
  ) {
    const f = principalNativeFixture();
    const repo = {
      id: 1337190500,
      node_id: "R_private_fixture",
      name: "prospector",
      full_name: "ubiquity/prospector",
      owner: { login: "ubiquity" },
      private: mode !== "public",
    };
    const scope = await readHostedPrivateCiScope({
      ...f.scopeInput,
      repository: {
        owner: "ubiquity",
        name: mode === "wrong_repo" ? "other" : "prospector",
        installationId: 155687488,
      },
      grant: {
        ...f.grant,
        permissions: {
          contents: mode === "read_only" ? "read" : "write",
          metadata: "read",
        },
        repositoryIds: [repo.id],
        repositoryNames: ["prospector"],
        expiresAt: mode === "expired" ? f.clock.now() - 1 : f.grant.expiresAt,
      },
      http: (request) =>
        Promise.resolve({
          status: 200,
          headers: new Headers(),
          bodyText: JSON.stringify(
            request.url.includes("/installation/repositories")
              ? { total_count: 1, repositories: [repo] }
              : repo,
          ),
        }),
    });
    assert.equal(scope.ok, mode === "valid", mode);
    if (scope.ok) {
      assert.equal(
        await createHostedPrivateCiCapabilities(
          scope.value as never,
          "/not-used/ci-minutes-private",
          f.clock.now() + 1000,
        ),
        null,
        "a repository JSON response is not a genuine private principal context",
      );
      assert.equal(JSON.stringify(scope).includes(f.scopeInput.token), false);
    }
  }
});

Deno.test("CI phase1 source policy is exact retained-estimate data and preserves explicit inactive fixtures", () => {
  const policy = acceptedCiMinutePolicy();
  assert.equal(policy.activated, true);
  assert.equal(policy.accounting, "retained_estimates");
  assert.equal(policy.meterRefunds, false);
  assert.equal(policy.calendar, "utc_month");
  assert.equal(policy.bootstrap, "unknown_month_floor");
  assert.deepEqual([
    policy.managedLimit,
    policy.securityReserve,
    policy.unmanagedReserve,
  ], [1450, 150, 400]);
  assert.deepEqual(
    policy.targets.map(
      (t) => [t.repositoryId, t.job, t.timeoutMinutes, t.ceilingMinutes],
    ),
    [[1337190500, "validation", 20, 25], [1254699258, "deno", 30, 35]],
  );
  policy.targets[0].ceilingMinutes = 999;
  assert.equal(acceptedCiMinutePolicy().targets[0].ceilingMinutes, 25);
  assert.equal(INACTIVE_CI_MINUTE_POLICY.activated, false);
});

Deno.test("CI phase1 terminal estimate provenance retains debit and proves execution month only", () => {
  const policy = acceptedCiMinutePolicy();
  const ledger: CiMinuteLedgerV1 = {
    version: 1,
    month: "2028-01",
    policyDigest: ciPolicyDigest(policy),
    updatedAt: NOW,
    sequence: 1,
    baselineMinutes: 0,
    watermark: null,
    reservations: [{
      effectDigest: ACCEPTANCE,
      policyDigest: ciPolicyDigest(policy),
      ceilingMinutes: 25,
      state: "terminal_estimated",
      createdAt: NOW,
      settledAt: NOW,
      chargedMinutes: 25,
      proofDigest: ACCEPTANCE,
      accounting: {
        kind: "retained_estimate",
        executionMonth: "2027-12",
        terminalProofDigest: ACCEPTANCE,
        startedAt: Date.UTC(2027, 11, 31, 23, 58),
        completedAt: Date.UTC(2027, 11, 31, 23, 59),
      },
    }],
    observed: [],
  };
  assert.equal(parseCiMinuteLedger(ledger).reservations[0].chargedMinutes, 25);
  const lower = structuredClone(ledger);
  lower.reservations[0].chargedMinutes = 1;
  assert.throws(() => parseCiMinuteLedger(lower));
  const cross = structuredClone(ledger);
  cross.reservations[0].accounting!.completedAt = Date.UTC(2028, 0, 1);
  assert.throws(() => parseCiMinuteLedger(cross));
  const missing = structuredClone(ledger);
  delete missing.reservations[0].accounting;
  assert.throws(() => parseCiMinuteLedger(missing));
  const next = structuredClone(ledger);
  next.sequence++;
  next.reservations[0].chargedMinutes = 26;
  validateCiMinuteTransition(ledger, next);
  assert.throws(() => validateCiMinuteTransition(next, ledger));
});

Deno.test("CI phase1 bootstrap is a conservative floor and catalog is finite monotonic private state", () => {
  const policy = acceptedCiMinutePolicy();
  const ledger: CiMinuteLedgerV1 = {
    version: 1,
    month: "2028-01",
    policyDigest: ciPolicyDigest(policy),
    updatedAt: NOW,
    sequence: 1,
    baselineMinutes: 2000,
    watermark: null,
    reservations: [],
    observed: [],
    bootstrap: {
      kind: "conservative_unknown_history",
      month: "2028-01",
      floorMinutes: 2000,
      createdAt: NOW,
      policyDigest: ciPolicyDigest(policy),
    },
    catalog: {
      runs: [{
        repositoryId: 101,
        runId: 7,
        head: ACCEPTANCE.slice(0, 40),
        createdAt: Date.UTC(2027, 0, 1),
        updatedAt: NOW,
        runAttempt: 2,
        checkedAttempt: 1,
        status: "in_progress",
        terminalProofDigest: null,
        refreshRequired: true,
      }],
      cursor: 0,
      passThrough: NOW,
      complete: false,
    },
  };
  const parsed = parseCiMinuteLedger(ledger);
  assert.equal(parsed.bootstrap?.kind, "conservative_unknown_history");
  assert.equal(parsed.catalog?.runs[0].runAttempt, 2);
  const falseComplete = structuredClone(ledger);
  falseComplete.catalog!.complete = true;
  falseComplete.catalog!.cursor = 1;
  assert.throws(() => parseCiMinuteLedger(falseComplete));
  const badFloor = structuredClone(ledger);
  badFloor.bootstrap!.floorMinutes = 0;
  assert.throws(() => parseCiMinuteLedger(badFloor));
  const dropped = structuredClone(ledger);
  dropped.sequence++;
  dropped.catalog!.runs = [];
  assert.throws(() => validateCiMinuteTransition(ledger, dropped));
  const duplicate = structuredClone(ledger);
  duplicate.catalog!.runs.push({ ...duplicate.catalog!.runs[0] });
  assert.throws(() => parseCiMinuteLedger(duplicate));
  const next = structuredClone(ledger);
  next.sequence++;
  next.catalog!.runs[0].runAttempt = 3;
  validateCiMinuteTransition(ledger, next);
});

Deno.test("CI phase1 driver/observer APIs keep effect-only ports unchanged and reader write-free", async () => {
  const coordinator: CiMinuteCoordinatorV1 = {
    active: false,
    reserve: () => Promise.resolve({ kind: "inactive" }),
    reconcile: () => Promise.resolve({ kind: "inactive" }),
  };
  assert.deepEqual(await coordinator.reconcile(1), { kind: "inactive" });
  const factory: CiMinuteReconcilerFactoryV1 = (_input) => {
    const observer: CiMinuteObserverV1 = () => Promise.resolve(null);
    return observer;
  };
  const read = factory({
    policy: acceptedCiMinutePolicy(),
    request: () => Promise.resolve(null),
    clock: { now: () => NOW },
  });
  assert.equal(typeof read, "function");
});

Deno.test("CI phase1 explicit terminal-unmetered proof is not a fabricated actual quantity", () => {
  const policy = acceptedCiMinutePolicy();
  const ledger: CiMinuteLedgerV1 = {
    version: 1,
    month: "2028-01",
    policyDigest: ciPolicyDigest(policy),
    updatedAt: NOW,
    sequence: 1,
    baselineMinutes: 0,
    watermark: null,
    reservations: [],
    observed: [],
    proofs: [{
      digest: ACCEPTANCE,
      effectDigest: null,
      startedAt: NOW - 497000,
      completedAt: NOW,
      neverStarted: false,
      terminal: true,
      billedDurationMs: 0,
      estimate: {
        kind: "retained_estimate",
        minutes: 25,
        executionMonth: "2028-01",
        terminalProofDigest: ACCEPTANCE,
      },
    }],
  };
  ledger.proofs![0] = estimatedJob(ledger.proofs![0]);
  const parsed = parseCiMinuteLedger(ledger);
  assert.equal(parsed.proofs![0].billedDurationMs, 0);
  assert.equal(parsed.proofs![0].estimate?.minutes, 25);
  const naked = structuredClone(ledger);
  delete naked.proofs![0].estimate;
  assert.throws(() => parseCiMinuteLedger(naked));
  const cross = structuredClone(ledger);
  cross.proofs![0].startedAt = Date.UTC(2027, 11, 31);
  assert.throws(() => parseCiMinuteLedger(cross));
  cross.proofs![0].estimate!.executionMonth = null;
  cross.proofs![0] = estimatedJob(cross.proofs![0]);
  parseCiMinuteLedger(cross);
});

Deno.test("CI capacity synthetic catalog and retained proofs serialize through real Git within finite bounds", async () => {
  assert.equal(CI_MINUTE_MAX_CATALOG_RUNS, 8192);
  assert.equal(CI_MINUTE_MAX_BYTES, 4 * 2 ** 20);
  assert.equal(CI_MINUTE_MAX_RECORDS, 4096);
  const f = await fixture();
  try {
    const run = (index: number) => ({
      repositoryId: index < 2000 ? 101 : 102,
      runId: 10000000000 + index,
      head: "a".repeat(40),
      createdAt: NOW - 497000,
      updatedAt: NOW,
      runAttempt: 1,
      checkedAttempt: 1,
      status: "completed" as const,
      terminalProofDigest: ciMinuteDigest({ run: index }),
      refreshRequired: false,
    });
    const proof = (index: number) =>
      estimatedJob({
        digest: ciMinuteDigest({ job: index }),
        effectDigest: null,
        startedAt: NOW - 497000,
        completedAt: NOW,
        neverStarted: false,
        terminal: true,
        billedDurationMs: 0,
        estimate: {
          kind: "retained_estimate" as const,
          minutes: 25,
          executionMonth: "2028-01",
          terminalProofDigest: ciMinuteDigest({ job: index }),
        },
      });
    f.ledger.catalog = {
      runs: Array.from({ length: 4000 }, (_, index) => run(index)),
      cursor: 4000,
      passThrough: NOW,
      complete: true,
    };
    f.ledger.proofs = Array.from({ length: 64 }, (_, index) => proof(index));
    f.ledger.observed = f.ledger.proofs.map((job) => ({
      digest: job.digest,
      effectDigest: null,
      minutes: job.estimate!.minutes,
    }));
    const bytes = new TextEncoder().encode(canonicalStringify(f.ledger)).length;
    assert.ok(bytes > 2 ** 20 && bytes < CI_MINUTE_MAX_BYTES, String(bytes));
    parseCiMinuteLedger(f.ledger);
    const store = f.make();
    const saved = await store.write({ expectedHead: null, ledger: f.ledger });
    assert.ok(saved.ok && saved.value.status === "applied");
    const read = await store.read("2028-01");
    assert.ok(read.ok && read.value.ledger !== null);
    assert.deepEqual(read.value.ledger, f.ledger);

    const boundary = structuredClone(f.ledger);
    boundary.catalog!.runs = Array.from(
      { length: CI_MINUTE_MAX_CATALOG_RUNS },
      (_, index) => run(index),
    );
    boundary.catalog!.cursor = CI_MINUTE_MAX_CATALOG_RUNS;
    parseCiMinuteLedger(boundary);
    boundary.catalog!.runs.push(run(CI_MINUTE_MAX_CATALOG_RUNS));
    boundary.catalog!.cursor++;
    assert.throws(
      () => parseCiMinuteLedger(boundary),
      /invalid CI catalog cursor/,
    );
    boundary.catalog!.runs.pop();
    boundary.catalog!.cursor--;
    boundary.proofs = Array.from(
      { length: CI_MINUTE_MAX_RECORDS },
      (_, index) => proof(index),
    );
    boundary.observed = boundary.proofs.map((job) => ({
      digest: job.digest,
      effectDigest: null,
      minutes: job.estimate!.minutes,
    }));
    assert.ok(
      new TextEncoder().encode(canonicalStringify(boundary)).length >
        CI_MINUTE_MAX_BYTES,
    );
    assert.throws(() => parseCiMinuteLedger(boundary), /CI ledger bound/);
    console.log(
      JSON.stringify({
        syntheticRuns: 4000,
        retainedProofs: 64,
        serializedBytes: bytes,
        maxCatalogRuns: CI_MINUTE_MAX_CATALOG_RUNS,
        maxLedgerBytes: CI_MINUTE_MAX_BYTES,
      }),
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("CI pacing production composition refuses changed source basis before authority or store work", async () => {
  let touched = 0;
  const policy = acceptedCiMinutePolicy();
  policy.unmanagedReserve--;
  const controller = composePrivateCiMinutes({
    policy,
    clock: { now: () => NOW },
    scratch: "/not-used/ci-minutes-private",
    authority: () => {
      touched++;
      throw new Error("invalid source touched authority");
    },
    billingBasis: verifyCiMinuteSchedulingBasis,
  });
  assert.equal((await controller.reconcile(NOW + 60000)).kind, "unavailable");
  assert.equal(
    (await controller.reserve({
      repository: { owner: "ubiquity", name: "prospector", installationId: 1 },
      kind: "pr_open",
      head: "a".repeat(40),
      base: "b".repeat(40),
      ref: "refs/heads/task",
      pr: 1,
    }, NOW + 60000)).kind,
    "unavailable",
  );
  assert.equal(touched, 0);
});

Deno.test("CI acceptance native composition reuses readiness and exempts public targets from pending private reconciliation", async () => {
  const f = await fixture();
  let now = NOW;
  let applied = false;
  let pendingRuns = false;
  const paths: string[] = [];
  const policy = acceptedCiMinutePolicy();
  const capability = {
    verify: () => Promise.resolve(true),
    request(path: string) {
      paths.push(path);
      const profile = policy.targets.find((target) =>
        path.startsWith(`/repos/${target.owner}/${target.name}`)
      );
      assert.ok(profile, path);
      const run = (id: number) => ({
        id,
        repository: { id: profile.repositoryId },
        head_sha: "a".repeat(40),
        run_attempt: 1,
        status: "queued",
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
      });
      if (path.includes("/actions/runs?")) {
        return Promise.resolve(
          pendingRuns
            ? {
              total_count: 9,
              workflow_runs: Array.from(
                { length: 9 },
                (_, index) => run(index + 1),
              ),
            }
            : { total_count: 0, workflow_runs: [] },
        );
      }
      if (path.includes("/actions/runs/")) {
        return Promise.resolve(run(Number(path.split("/").at(-1))));
      }
      if (path.includes("/contents/")) {
        const workflow =
          `on: [pull_request]\njobs:\n  ${profile.job}:\n    runs-on: ubuntu-latest\n    timeout-minutes: ${profile.timeoutMinutes}\n    steps:\n      - run: true\n`;
        return Promise.resolve({
          type: "file",
          encoding: "base64",
          sha: profile.workflowBlob,
          content: btoa(workflow),
        });
      }
      if (path.includes("/pulls?")) {
        return Promise.resolve(
          applied ? [{ head: { sha: "a".repeat(40) } }] : [],
        );
      }
      assert.equal(path, `/repos/${profile.owner}/${profile.name}`);
      return Promise.resolve({
        id: profile.repositoryId,
        private: true,
        default_branch: "development",
      });
    },
    runGit(args: string[], options: Parameters<GitRunnerV1["runGit"]>[1]) {
      const local = args[0] === "remote" && args[3] === CI_MINUTE_PRIVATE_REMOTE
        ? [...args.slice(0, 3), f.bare]
        : args;
      return f.git.runGit(local, options);
    },
  };
  const make = (deadlineAt?: number) =>
    composePrivateCiMinutes({
      policy,
      clock: { now: () => now },
      scratch: `${f.path}/production/ci-minutes-private`,
      deadlineAt,
      authority: () => Promise.resolve(capability),
      billingBasis: verifyCiMinuteSchedulingBasis,
    });
  const effect = {
    repository: { owner: "ubiquity", name: "prospector", installationId: 1 },
    kind: "pr_open" as const,
    head: "a".repeat(40),
    base: "b".repeat(40),
    ref: "refs/heads/task",
    pr: 1,
  };
  try {
    const first = await make().reconcile(now + 60000);
    assert.equal(first.kind, "ready");
    const store = f.make();
    const initial = await store.read("2028-01");
    assert.ok(initial.ok && initial.value.ledger?.bootstrap);
    assert.equal(initial.value.ledger.baselineMinutes, 1450);
    assert.equal(initial.value.ledger.reservations.length, 0);
    assert.equal((await make().reserve(effect, now + 60000)).kind, "held");
    const resumed = await store.read("2028-01");
    assert.ok(resumed.ok && resumed.value.ledger);
    assert.ok(resumed.value.ledger.sequence > initial.value.ledger.sequence);
    assert.equal(resumed.value.ledger.baselineMinutes, 1450);
    const refs = await f.git.runGit(["for-each-ref", "--format=%(refname)"], {
      cwd: f.bare,
    });
    assert.equal(refs.stdout.trim(), CI_MINUTE_REF);
    now = Date.UTC(2028, 1, 29, 23);
    assert.equal((await make().reserve(effect, now + 60000)).kind, "admitted");
    applied = true;
    assert.equal(
      (await make().reserve(effect, now + 60000)).kind,
      "reconciled",
    );
    const later = await store.read("2028-02");
    assert.ok(later.ok && later.value.ledger);
    assert.equal(later.value.ledger.reservations.length, 1);
    assert.equal(later.value.ledger.reservations[0].chargedMinutes, 25);
    const count = paths.length;
    assert.equal((await make(now).reconcile(now + 60000)).kind, "unavailable");
    assert.equal(
      paths.length,
      count,
      "the existing native deadline can only shorten caller work",
    );
    applied = false;
    now = Date.UTC(2028, 2, 2);
    const period = { start: Date.UTC(2028, 2, 1), end: Date.UTC(2028, 3, 1) };
    const earned = Math.floor(
      1450 * (now - period.start) / (period.end - period.start),
    );
    const known: CiMinuteLedgerV1 = {
      version: 1,
      month: "2028-03",
      policyDigest: ciPolicyDigest(policy),
      updatedAt: now,
      sequence: 1,
      baselineMinutes: earned - 25,
      watermark: null,
      reservations: [],
      observed: [],
    };
    const seeded = await store.write({
      expectedHead: later.value.head,
      ledger: known,
    });
    assert.ok(seeded.ok && seeded.value.status === "applied");
    const oneTurn = make(now + 60000);
    assert.equal((await oneTurn.reconcile(now + 60000)).kind, "ready");
    const afterObservation = paths.filter((path) =>
      path.includes("/actions/runs")
    ).length;
    const profileReads = paths.filter((path) =>
      path.includes("/contents/")
    ).length;
    assert.equal(
      (await oneTurn.reserve({ ...effect, head: "e".repeat(40) }, now + 60000))
        .kind,
      "admitted",
    );
    assert.equal(
      (await oneTurn.reserve({ ...effect, head: "f".repeat(40) }, now + 60000))
        .kind,
      "held",
    );
    assert.equal(
      paths.filter((path) => path.includes("/actions/runs")).length,
      afterObservation,
      "ready reconciliation is observed exactly once in a native turn",
    );
    assert.equal(
      paths.filter((path) => path.includes("/contents/")).length,
      profileReads + 2,
      "both actual effects revalidate their authenticated profile",
    );
    const capacity = await store.read("2028-03");
    assert.ok(capacity.ok && capacity.value.ledger);
    assert.equal(capacity.value.ledger.reservations.length, 1);
    now += 60001;
    assert.equal(
      (await oneTurn.reconcile(now + 60000)).kind,
      "unavailable",
      "cached readiness expires at the fixed native deadline",
    );
    now = Date.UTC(2028, 3, 2);
    pendingRuns = true;
    const pendingTurn = make(now + 60000);
    assert.equal((await pendingTurn.reconcile(now + 60000)).kind, "pending");
    const afterPending = paths.length;
    assert.equal((await pendingTurn.reserve(effect, now + 60000)).kind, "held");
    assert.equal(
      (await pendingTurn.reserve(
        { ...effect, head: "e".repeat(40) },
        now + 60000,
      )).kind,
      "held",
    );
    assert.equal(
      paths.length,
      afterPending,
      "pending reconciliation is reused without a new observation or effect",
    );
    assert.equal(
      (await pendingTurn.reserve({
        ...effect,
        repository: { owner: "fixture", name: "public", installationId: 1 },
      }, now + 60000)).kind,
      "inactive",
    );
    assert.equal(
      paths.length,
      afterPending,
      "public effects never consult pending private reconciliation",
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("CI acceptance public composition effects bypass unavailable private authority and every private preflight", async () => {
  const policy = acceptedCiMinutePolicy();
  const effect = {
    repository: { owner: "fixture", name: "public", installationId: 1 },
    kind: "pr_open" as const,
    head: "a".repeat(40),
    base: "b".repeat(40),
    ref: "refs/heads/synthetic",
    pr: 1,
  };
  let authorityCalls = 0;
  const capability = composePrivateCiMinutes({
    policy,
    clock: { now: () => NOW },
    scratch: "/not-used/ci-minutes-private",
    authority: () => {
      authorityCalls++;
      return Promise.resolve(null);
    },
    billingBasis: verifyCiMinuteSchedulingBasis,
  });
  assert.equal((await capability.reconcile(NOW + 60000)).kind, "unavailable");
  assert.equal(authorityCalls, 1);
  assert.equal(
    (await capability.reserve(effect, NOW + 60000)).kind,
    "inactive",
  );
  assert.equal(authorityCalls, 1);
  assert.equal(
    (await capability.reserve({
      ...effect,
      repository: {
        owner: policy.targets[0].owner,
        name: policy.targets[0].name,
        installationId: 1,
      },
    }, NOW + 60000)).kind,
    "unavailable",
  );
  const fail = () => {
    throw new Error("public effect touched private preflight");
  };
  const untouched = composePrivateCiMinutes({
    policy,
    clock: { now: fail },
    scratch: "/not-used/ci-minutes-private",
    authority: fail,
    billingBasis: fail,
  });
  assert.equal((await untouched.reserve(effect, 0)).kind, "inactive");
});

Deno.test("CI acceptance native request adapter allows only managed numeric workflow reads and carries exact rerun qualification", async () => {
  const f = principalNativeFixture(),
    policy = acceptedCiMinutePolicy(),
    target = policy.targets[0];
  const scope = `/repos/${target.owner}/${target.name}`,
    sha = "a".repeat(40),
    paths: string[] = [];
  const input = {
    ...f.scopeInput,
    http: (request: Parameters<typeof f.scopeInput.http>[0]) => {
      assert.equal(request.method, "GET");
      paths.push(new URL(request.url).pathname);
      const path = new URL(request.url).pathname;
      let body: unknown = { id: 77, path: ".github/workflows/ci.yml" };
      if (path === scope) {
        body = {
          id: target.repositoryId,
          private: true,
          default_branch: "main",
        };
      } else if (path === `${scope}/actions/runs/7`) {
        body = {
          id: 7,
          repository: { id: target.repositoryId },
          head_sha: sha,
          run_attempt: 1,
          status: "completed",
          workflow_id: 77,
          path: ".github/workflows/ci.yml",
        };
      } else if (path.includes("/contents/")) {
        body = {
          type: "file",
          encoding: "base64",
          sha: target.workflowBlob,
          content: btoa(
            `on: [push]\njobs:\n  ${target.job}:\n    runs-on: ubuntu-latest\n    timeout-minutes: ${target.timeoutMinutes}\n    steps:\n      - run: true\n`,
          ),
        };
      }
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        bodyText: JSON.stringify(body),
      });
    },
  };
  for (const managed of policy.targets) {
    assert.deepEqual(
      await readHostedPrivateCiData(
        input,
        `/repos/${managed.owner}/${managed.name}/actions/workflows/77`,
      ),
      { id: 77, path: ".github/workflows/ci.yml" },
    );
  }
  const before = paths.length;
  for (
    const path of [
      "/repos/fixture/project/actions/workflows/77",
      `${scope}/actions/workflows/name.yml`,
      `${scope}/actions/workflows/77/dispatches`,
      `${scope}/actions/workflows`,
      `${scope}/actions/workflows/0`,
      `${scope}/actions/workflows/-1`,
    ]
  ) {
    assert.equal(await readHostedPrivateCiData(input, path), null, path);
  }
  assert.equal(
    paths.length,
    before,
    "unsupported routes never reach HTTP transport",
  );
  const resolve = createPrivateCiEffectResolver({
    policy,
    request: (path, deadline) =>
      readHostedPrivateCiData({ ...input, deadline }, path),
  });
  const facts = await resolve({
    repository: { owner: target.owner, name: target.name, installationId: 1 },
    kind: "rerun",
    head: sha,
    base: null,
    ref: "refs/heads/synthetic",
    pr: null,
    runId: 7,
    attempt: 2,
  }, f.clock.now() + 1000);
  assert.ok(facts);
  assert.equal(
    await verifyCiMinuteSchedulingBasis(policy, f.clock.now() + 1000, facts),
    true,
  );
  assert.ok(paths.includes(`${scope}/actions/workflows/77`));
});

Deno.test("CI gap recovery real Git carries the same unresolved reservation across missing months until authenticated terminal closure", async () => {
  const f = await fixture();
  const policy = acceptedCiMinutePolicy(), profile = policy.targets[0];
  const november = Date.UTC(2028, 10, 30, 23);
  let now = november;
  let jobs: NonNullable<CiMinuteLedgerV1["proofs"]> = [];
  const effect = {
    repository: { owner: profile.owner, name: profile.name, installationId: 1 },
    kind: "pr_open" as const,
    head: "a".repeat(40),
    base: "b".repeat(40),
    ref: "refs/heads/synthetic",
    pr: 1,
  };
  const controller = () =>
    createCiMinuteController({
      policy,
      clock: { now: () => now },
      store: f.make(),
      authorizePolicy: verifyCiMinuteSchedulingBasis,
      resolve: () =>
        Promise.resolve({
          repositoryId: profile.repositoryId,
          workflowBlob: profile.workflowBlob,
          job: profile.job,
          jobs: 1,
          runner: profile.runner,
          timeoutMinutes: profile.timeoutMinutes,
          ceilingMinutes: profile.ceilingMinutes,
          qualificationDigest: policy.ceilingQualification!,
          triggered: true,
          effectState: "not_applied",
        }),
      observe: (month) =>
        Promise.resolve({
          month,
          complete: true,
          watermark: now,
          observedAt: now,
          jobs,
        }),
    });
  try {
    const store = f.make();
    const seeded = await store.write({
      expectedHead: null,
      ledger: {
        ...f.ledger,
        month: "2028-11",
        policyDigest: ciPolicyDigest(policy),
        updatedAt: now,
        watermark: now,
      },
    });
    assert.ok(seeded.ok && seeded.value.status === "applied");
    const reserved = await controller().reserve(effect, now + 60000);
    assert.equal(reserved.kind, "admitted");
    if (reserved.kind !== "admitted") return;
    const id = reserved.reservationDigest;
    const submitted = await store.read("2028-11");
    assert.ok(submitted.ok && submitted.value.ledger);
    submitted.value.ledger.reservations[0].state = "ambiguous";
    submitted.value.ledger.sequence++;
    const ambiguous = await store.write({
      expectedHead: submitted.value.head,
      ledger: submitted.value.ledger,
    });
    assert.ok(ambiguous.ok && ambiguous.value.status === "applied");
    const december = await store.read("2028-12");
    assert.ok(december.ok && december.value.ledger === null);
    now = Date.UTC(2029, 0, 31, 23);
    assert.equal((await controller().reconcile(now + 60000)).kind, "ready");
    const january = await store.read("2029-01");
    assert.ok(january.ok && january.value.ledger);
    assert.equal(
      january.value.ledger.reservations.find((row) => row.effectDigest === id)
        ?.chargedMinutes,
      25,
    );
    assert.equal(january.value.ledger.bootstrap, undefined);
    assert.equal(
      january.value.ledger.reservations.find((row) => row.effectDigest === id)
        ?.state,
      "ambiguous",
    );
    now = Date.UTC(2029, 1, 28, 23);
    const next = await controller().reserve(
      { ...effect, head: "c".repeat(40) },
      now + 60000,
    );
    assert.equal(next.kind, "admitted");
    const february = await store.read("2029-02");
    assert.ok(february.ok && february.value.ledger);
    assert.equal(
      february.value.ledger.reservations.find((row) => row.effectDigest === id)
        ?.chargedMinutes,
      25,
    );
    jobs = [estimatedJob({
      digest: ACCEPTANCE,
      effectDigest: id,
      startedAt: november - 497000,
      completedAt: november,
      terminal: true,
      neverStarted: false,
      billedDurationMs: 0,
      estimate: {
        kind: "retained_estimate",
        minutes: 25,
        executionMonth: "2028-11",
        terminalProofDigest: ACCEPTANCE,
      },
    })];
    assert.equal((await controller().reconcile(now + 60000)).kind, "ready");
    now = Date.UTC(2029, 2, 31, 23);
    jobs = [];
    assert.equal((await controller().reconcile(now + 60000)).kind, "ready");
    const march = await store.read("2029-03");
    assert.ok(march.ok && march.value.ledger);
    assert.equal(
      march.value.ledger.reservations.some((row) => row.effectDigest === id),
      false,
    );
    assert.equal(march.value.ledger.reservations.length, 1);
    const historical = await store.read("2028-11");
    assert.ok(historical.ok && historical.value.ledger);
    assert.equal(historical.value.ledger.reservations[0].chargedMinutes, 25);
  } finally {
    await f.cleanup();
  }
});

Deno.test("CI gap prior discovery uses validated current-tree month metadata and refuses corrupt or unreadable state", async () => {
  const f = await fixture();
  try {
    const store = f.make();
    assert.deepEqual(await store.readPrior("2029-01"), {
      ok: true,
      value: { head: null, ledger: null },
    });
    const older = { ...f.ledger, month: "2028-09" };
    const latest = {
      ...f.ledger,
      month: "2028-11",
      reservations: [{
        effectDigest: ACCEPTANCE,
        policyDigest: f.ledger.policyDigest,
        ceilingMinutes: 25,
        state: "ambiguous" as const,
        createdAt: NOW,
        settledAt: null,
        chargedMinutes: 37,
        proofDigest: null,
      }],
    };
    const first = await store.write({ expectedHead: null, ledger: latest });
    assert.ok(first.ok && first.value.status === "applied");
    const second = await store.write({
      expectedHead: first.value.head,
      ledger: older,
    });
    assert.ok(second.ok && second.value.status === "applied");
    const third = await store.write({
      expectedHead: second.value.head,
      ledger: { ...f.ledger, month: "2030-01" },
    });
    assert.ok(third.ok && third.value.status === "applied");
    const prior = await store.readPrior("2029-01");
    assert.ok(prior.ok && prior.value.ledger);
    assert.equal(prior.value.head, third.value.head);
    assert.equal(prior.value.ledger.month, "2028-11");
    assert.equal(prior.value.ledger.reservations[0].effectDigest, ACCEPTANCE);
    assert.equal(prior.value.ledger.reservations[0].chargedMinutes, 37);
    assert.deepEqual(await store.readPrior("2028-09"), {
      ok: true,
      value: { head: third.value.head, ledger: null },
    });
    for (
      const mode of ["corrupt_blob", "unreadable_blob", "unknown_path"] as const
    ) {
      const runner: GitRunnerV1 = {
        async runGit(args, options) {
          if (args[0] === "cat-file" && args[1] === "blob") {
            if (mode === "corrupt_blob") {
              return { ok: true, code: 0, stdout: "{invalid", stderr: "" };
            }
            if (mode === "unreadable_blob") {
              return {
                ok: false,
                code: 1,
                stdout: "",
                stderr: "synthetic read failure",
              };
            }
          }
          const result = await f.git.runGit(args, options);
          return mode === "unknown_path" && args[0] === "ls-tree" && result.ok
            ? {
              ...result,
              stdout: result.stdout +
                `100644 blob ${"a".repeat(40)}\tunknown.json\n`,
            }
            : result;
        },
      };
      const refused = await f.make(runner).readPrior("2029-01");
      assert.equal(refused.ok, false, mode);
    }
    const unchanged = await store.readPrior("2029-01");
    assert.ok(unchanged.ok && unchanged.value.head === third.value.head);
    assert.equal(unchanged.value.ledger?.reservations[0].chargedMinutes, 37);
  } finally {
    await f.cleanup();
  }
});
