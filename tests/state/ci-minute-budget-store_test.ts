import assert from "node:assert/strict";
import { ciMinuteDigest } from "../../src/contracts/ci-minute-budget.ts";
import {
  ciStateGitArgs,
  composePrivateCiMinutes,
  createHostedPrivateCiCapabilities,
} from "../../src/host/hosted-app-principal.ts";
import { readHostedPrivateCiScope } from "../../src/host/hosted-app-principal-native.ts";
import { principalNativeFixture } from "../host/hosted-app-principal-fixtures.ts";
import { GitCiMinuteStore } from "../../src/state/ci-minute-budget-store.ts";
import { DenoGitRunner } from "../../src/state/state-git.ts";
import type { GitRunnerV1 } from "../../src/state/state-git.ts";
import {
  CI_MINUTE_REF,
  ciPolicyDigest,
} from "../../src/contracts/ci-minute-budget.ts";
import type { CiMinuteLedgerV1 } from "../../src/contracts/ci-minute-budget.ts";
import { proposedCiMinutePolicy } from "../../src/budget/ci-minutes.ts";

const ACCEPTANCE = "a".repeat(64);
const NOW = Date.UTC(2028, 0, 31);
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
