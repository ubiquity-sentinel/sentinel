/** Deterministic implementation refusals never spend a reservation. */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
} from "../../src/repair/loop-types.ts";
import { prepareImplementationStart } from "../../src/repair/loop-implementation.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "./helpers.ts";
import { seededSnapshot } from "./loop-rig.ts";
import { SHA1, T0, workRecord } from "../state/helpers.ts";

function rig() {
  const record = workRecord("issue-preflight");
  const state = new MemoryState();
  state.repair = seededSnapshot([record]);
  state.repairHead = SHA1;
  const clock = new FakeClock(T0);
  const configs = repairConfigs({
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
  });
  const github = new FakeGithub();
  const model = new FakeModel();
  const budget = new RollingStartBudget({ clock, state, configs });
  let reservations = 0;
  const reserve = budget.reserveModelStart.bind(budget);
  budget.reserveModelStart = (request) => {
    reservations++;
    return reserve(request);
  };
  const deps: RepairCycleDepsV1 = {
    clock,
    state,
    configs,
    controllerSha: SHA1,
    github,
    model,
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
    incidents: new FakeIncidents({ summaries: [] }),
    replay: new FakeReplay(),
    budget,
  };
  const context: LoopContextV1 = {
    snapshot: state.repair,
    head: SHA1,
    executionBaseline: record,
    bounds: { runDeadline: T0 + 60 * 60_000, modelCutoff: T0 + 60 * 60_000 },
  };
  return {
    record,
    state,
    configs,
    github,
    model,
    deps,
    context,
    reservations: () => reservations,
  };
}

for (
  const [name, configure, reason] of [
    ["protected paths", (config: RepositoryConfigV1) => {
      config.protectedPaths = ["../escape"];
    }, "protected paths are malformed or over bound"],
    ["output bound", (config: RepositoryConfigV1) => {
      config.sessionBound!.maxOutputChars = 0;
    }, "maxOutputChars must be a positive safe integer"],
    ["base branch name", (config: RepositoryConfigV1) => {
      config.baseBranch = "bad..branch";
    }, "target base branch name is invalid"],
  ] as const
) {
  Deno.test(`implementation preflight: ${name} refuses before reservation`, async () => {
    const r = rig();
    configure(r.configs[0]!);
    const result = await prepareImplementationStart(
      r.deps,
      r.context,
      r.record,
      r.configs[0]!,
    );
    assert.equal(result.kind, "progress", JSON.stringify(result));
    assert.equal(
      r.state.repair!.work[0]!.blocker?.message,
      `implementation preflight refused: ${reason}`,
    );
    assert.equal(r.reservations(), 0);
    assert.equal(r.state.repair!.reservations.length, 0);
    assert.equal(r.model.requests.length, 0);
  });
}

for (
  const [name, labels, body] of [
    ["skip label", ["SeNtInEl:SkIp"], "body"],
    ["skip marker", [], "<!-- sentinel:skip -->\nbody"],
  ] as const
) {
  Deno.test(`implementation preflight: fresh ${name} refuses before reservation`, async () => {
    const r = rig();
    const read = await r.github.readIssue(1);
    assert.ok(read.ok && read.value);
    if (!read.ok || !read.value) return;
    r.github.readIssue = () =>
      Promise.resolve(portOk({ ...read.value!, labels: [...labels], body }));
    await prepareImplementationStart(
      r.deps,
      r.context,
      r.record,
      r.configs[0]!,
    );
    assert.equal(
      r.state.repair!.work[0]!.blocker?.message,
      "implementation preflight refused: source issue opted out",
    );
    assert.equal(r.reservations(), 0);
    assert.equal(r.state.repair!.reservations.length, 0);
    assert.equal(r.model.requests.length, 0);
  });
}

Deno.test("implementation preflight: invalid candidate ref refuses before reservation", async () => {
  const r = rig();
  r.record.id = asWorkItemId("issue-candidate.lock");
  r.state.repair = seededSnapshot([r.record]);
  r.context.snapshot = r.state.repair;
  await prepareImplementationStart(r.deps, r.context, r.record, r.configs[0]!);
  assert.equal(
    r.state.repair!.work[0]!.blocker?.message,
    "implementation preflight refused: candidate branch name is invalid",
  );
  assert.equal(r.reservations(), 0);
  assert.equal(r.state.repair!.reservations.length, 0);
});

Deno.test("implementation preflight: missing target base branch refuses before reservation", async () => {
  const r = rig();
  r.github.readRef = () => Promise.resolve(portOk(null));
  await prepareImplementationStart(r.deps, r.context, r.record, r.configs[0]!);
  assert.equal(
    r.state.repair!.work[0]!.blocker?.message,
    "implementation preflight refused: target base branch does not exist",
  );
  assert.equal(r.reservations(), 0);
  assert.equal(r.state.repair!.reservations.length, 0);
});

Deno.test("implementation preflight: unavailable target branch retains its bounded uncharged wait", async () => {
  const r = rig();
  r.github.readRef = () =>
    Promise.resolve(portError("unavailable", "test offline"));
  const result = await prepareImplementationStart(
    r.deps,
    r.context,
    r.record,
    r.configs[0]!,
  );
  assert.equal(result.kind, "progress");
  assert.equal(r.state.repair!.work[0]!.wait?.reason, "unavailable");
  assert.equal(r.state.repair!.work[0]!.wait?.until, T0 + 60 * 60_000);
  assert.equal(r.reservations(), 0);
  assert.equal(r.state.repair!.reservations.length, 0);
});

Deno.test("implementation preflight: stale source identity refuses before reservation", async () => {
  const r = rig();
  const read = await r.github.readIssue(1);
  assert.ok(read.ok && read.value);
  if (!read.ok || !read.value) return;
  r.github.readIssue = () =>
    Promise.resolve(portOk({ ...read.value!, number: 2 }));
  await prepareImplementationStart(r.deps, r.context, r.record, r.configs[0]!);
  assert.equal(
    r.state.repair!.work[0]!.blocker?.message,
    "implementation preflight refused: source issue identity changed",
  );
  assert.equal(r.reservations(), 0);
  assert.equal(r.state.repair!.reservations.length, 0);
});

Deno.test("implementation preflight: an exact denylist that cannot fit refuses instead of truncating", async () => {
  const r = rig();
  r.configs[0]!.protectedPaths = Array.from(
    { length: 80 },
    (_, n) => `dir-${n}/${"x".repeat(420)}/`,
  );
  await prepareImplementationStart(r.deps, r.context, r.record, r.configs[0]!);
  assert.equal(
    r.state.repair!.work[0]!.blocker?.message,
    "implementation preflight refused: implementation constraints exceed the prompt bound",
  );
  assert.equal(r.reservations(), 0);
  assert.equal(r.state.repair!.reservations.length, 0);
});

Deno.test("implementation preflight: port prerequisites complete before any charged admission", async () => {
  const r = rig();
  r.deps.model = {
    preflightModel: () => {
      assert.equal(r.reservations(), 0);
      return Promise.resolve(
        portError("not_found", "target base commit does not exist"),
      );
    },
    runModel: () => {
      throw new Error("must not launch");
    },
  };
  await prepareImplementationStart(r.deps, r.context, r.record, r.configs[0]!);
  assert.equal(
    r.state.repair!.work[0]!.blocker?.message,
    "implementation preflight refused: target base commit does not exist",
  );
  assert.equal(r.reservations(), 0);
  assert.equal(r.state.repair!.reservations.length, 0);
});

Deno.test("implementation preflight: valid work preserves the ordinary durable reservation", async () => {
  const r = rig();
  const result = await prepareImplementationStart(
    r.deps,
    r.context,
    r.record,
    r.configs[0]!,
  );
  assert.equal(result.kind, "prepared", JSON.stringify(result));
  assert.equal(r.reservations(), 1);
  assert.equal(r.state.repair!.reservations.length, 1);
  assert.equal(r.state.repair!.work[0]!.counters.attempts, 1);
  assert.equal(r.model.requests.length, 0);
});

Deno.test("implementation preflight: real target mirror absence refuses uncharged, trusted catch-up admits once", async (t) => {
  const { LocalCheckoutModelPort } = await import(
    "../../src/host/local-model.ts"
  );
  const { LocalSessionTracker } = await import(
    "../../src/host/local-client.ts"
  );
  const { gitRun, testGitEnv } = await import("../state/helpers.ts");
  const root = await Deno.makeTempDir({
    prefix: "sentinel-implementation-preflight-",
    dir: Deno.cwd(),
  });
  try {
    const env = testGitEnv(root);
    const source = `${root}/source`;
    const mirror = `${root}/mirror.git`;
    await Deno.mkdir(source);
    assert.equal((await gitRun(source, ["init", "-q"], env)).ok, true);
    assert.equal(
      (await gitRun(source, [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "--allow-empty",
        "-qm",
        "base",
      ], env)).ok,
      true,
    );
    const base = (await gitRun(source, ["rev-parse", "HEAD"], env)).stdout
      .trim() as typeof SHA1;
    assert.equal(
      (await gitRun(root, ["init", "-q", "--bare", mirror], env)).ok,
      true,
    );
    for (const catchUp of [false, true]) {
      await t.step(
        catchUp ? "trusted exact-base fetch" : "missing exact base",
        async () => {
          const r = rig();
          r.record.target.base = base;
          r.github.readRef = (ref) =>
            Promise.resolve(portOk({ ref, sha: base }));
          let fetches = 0;
          let fetchError: unknown;
          r.deps.model = new LocalCheckoutModelPort({
            stateRoot: `${root}/state`,
            sourcePath: mirror,
            scratch: root,
            trustedPath: Deno.env.get("PATH") ?? "/usr/bin:/bin",
            codexExecutable: "/nonexistent/must-not-launch-codex",
            denoExecutable: Deno.execPath(),
            modelToken: "unused-fixture-token",
            tracker: new LocalSessionTracker(),
            clock: r.deps.clock,
            targetConfigs: r.configs,
            ...(catchUp
              ? {
                ensureBaseObject: async (
                  { base: requested }: { base: typeof SHA1 },
                ) => {
                  try {
                    assert.equal(r.reservations(), 0);
                    assert.equal(requested, base);
                    fetches++;
                    const fetched = await gitRun(mirror, [
                      "fetch",
                      "--no-tags",
                      source,
                      requested,
                    ], env);
                    return fetched.ok
                      ? portOk(undefined)
                      : portError("unavailable", "fixture fetch failed");
                  } catch (error) {
                    fetchError = error;
                    throw error;
                  }
                },
              }
              : {}),
          });
          const result = await prepareImplementationStart(
            r.deps,
            r.context,
            r.record,
            r.configs[0]!,
          );
          if (fetchError !== undefined) throw fetchError;
          if (catchUp) {
            assert.equal(result.kind, "prepared", JSON.stringify(result));
            assert.equal(fetches, 1);
            assert.equal(r.reservations(), 1);
            assert.equal(r.state.repair!.reservations.length, 1);
          } else {
            assert.equal(
              r.state.repair!.work[0]!.blocker?.message,
              "implementation preflight refused: target base commit does not exist in the target source mirror",
            );
            assert.equal(r.reservations(), 0);
            assert.equal(r.state.repair!.reservations.length, 0);
          }
          await assert.rejects(
            Deno.stat(`${root}/state`),
            Deno.errors.NotFound,
            "preflight creates neither a model client nor a task checkout",
          );
        },
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("preservation refusal names the post-inference content check and retains its submitted charge", async () => {
  const { candidatePreservationRef, implementationIntentKey } = await import(
    "../../src/repair/keys.ts"
  );
  const { executeCandidatePreservation } = await import(
    "../../src/repair/loop-preservation.ts"
  );
  const { PUBLICATION_PROTECTED_DETAIL } = await import(
    "../../src/github/snapshot-policy.ts"
  );
  const { reservation, SHA3 } = await import("../state/helpers.ts");
  const r = rig();
  const id = "1".repeat(64);
  const key = implementationIntentKey(id);
  r.record.counters.attempts = 1;
  r.record.target.head = SHA3;
  r.record.target.branch = "sentinel/repair/issue-preflight";
  r.record.target.candidateState = { preserved: null, publishedHead: null };
  r.record.intent = {
    kind: "candidate_preservation",
    key,
    requestId: id,
    branch: await candidatePreservationRef(
      r.record.repository,
      r.record.id,
      key,
    ),
    startedAt: T0,
    expectedHead: SHA3,
    observedBase: SHA1,
    pr: null,
    resultId: null,
  };
  const charge = reservation(id, {
    taskId: r.record.id,
    outcome: "submitted",
    settledAt: T0,
    proofRef: null,
  });
  r.state.repair = seededSnapshot([r.record], { reservations: [charge] });
  r.context.snapshot = r.state.repair;
  const { parseRepairStateSnapshotV1 } = await import(
    "../../src/contracts/state-snapshots.ts"
  );
  parseRepairStateSnapshotV1(r.state.repair);
  r.github.preserveCandidate = () =>
    Promise.resolve(portError("invalid", PUBLICATION_PROTECTED_DETAIL));
  const result = await executeCandidatePreservation(
    r.deps,
    r.context,
    r.record,
  );
  assert.ok(
    r.state.repair!.work[0]!.blocker,
    JSON.stringify({ result, wait: r.state.repair!.work[0]!.wait }),
  );
  assert.equal(
    r.state.repair!.work[0]!.blocker?.message,
    `candidate preservation validation refused: post-inference generated candidate check: ${PUBLICATION_PROTECTED_DETAIL}`,
  );
  assert.deepEqual(r.state.repair!.reservations, [charge]);
  assert.equal(r.state.repair!.work[0]!.target.head, SHA3);
  assert.equal(r.state.repair!.work[0]!.intent, null);
  assert.equal(r.model.requests.length, 0);
});
