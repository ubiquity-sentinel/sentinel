/** Hosted hosted-supervisor-matrix_test responsibility. */
import assert from "node:assert/strict";
import { GitHubApiClient } from "../../src/github/client.ts";
import type { HttpResponseV1 } from "../../src/github/http.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import {
  CANDIDATE,
  LAUNCHER,
  makeRig,
  releaseRequest,
  requireRun,
  reviewReceipt,
  run,
  runProof,
  SELF,
} from "./actions-supervisor-fixture.ts";
import {
  advanceToCandidate,
  bootstrapHealthy,
  ordinaryTurn,
} from "./actions-supervisor-lifecycle-fixture.ts";

Deno.test("ordinary matrix capability: verified old healthy runtime waits for owner installation without a new intent", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    const before = await rig.snapshot();
    const calls: GitSha[] = [];
    Object.assign(rig.evidence, {
      verifyMatrixOrdinaryRevision: (revision: GitSha) => {
        calls.push(revision);
        return Promise.resolve(portOk(false));
      },
    });
    const decision = await rig.prepare(run(2));
    assert.equal(
      decision.status,
      "idle",
      "verified old runtime must wait for the owner's capable installation",
    );
    assert.deepEqual(calls, [before.hostedRuntimes[0].activeRevision]);
    assert.deepEqual(
      await rig.snapshot(),
      before,
      "capability refusal cannot save an intent or admission",
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("ordinary matrix capability: missing unavailable malformed or thrown proof stays pending without a new intent", async (t) => {
  for (const mode of ["missing", "unavailable", "unknown", "null", "throw"]) {
    await t.step(mode, async () => {
      const rig = await makeRig();
      try {
        await bootstrapHealthy(rig);
        const before = await rig.snapshot();
        Object.assign(rig.evidence, {
          verifyMatrixOrdinaryRevision: mode === "missing" ? undefined : () => {
            if (mode === "throw") throw new Error("private failure");
            return Promise.resolve(
              mode === "null"
                ? null
                : mode === "unavailable"
                ? portError("unavailable", "unproven")
                : portOk("unknown"),
            );
          },
        });
        assert.equal((await rig.prepare(run(2))).status, "pending");
        assert.deepEqual(await rig.snapshot(), before);
      } finally {
        await rig.cleanup();
      }
    });
  }
});

Deno.test("ordinary matrix capability: actual client immutable source proof gates real controller admission", async (t) => {
  for (const capable of [false, true]) {
    await t.step(String(capable), async () => {
      const rig = await makeRig();
      try {
        await bootstrapHealthy(rig);
        const before = await rig.snapshot();
        const root = "a".repeat(40),
          src = "b".repeat(40),
          host = "c".repeat(40);
        const requests: string[] = [];
        const client = new GitHubApiClient({
          repository: SELF,
          apiBaseUrl: "https://api.github.com",
          clock: rig.clock,
          auth: {
            authorizationHeader: () =>
              Promise.resolve(portOk("Bearer fixture")),
          },
          cooldownGate: {
            beforeRequest: () => Promise.resolve(portOk(undefined)),
            recordRateLimit: () => Promise.resolve(portOk(undefined)),
          },
          http: (request) => {
            const path = new URL(request.url).pathname;
            requests.push(path);
            const entries = path.endsWith(root)
              ? [{ path: "src", type: "tree", mode: "040000", sha: src }]
              : path.endsWith(src)
              ? [{ path: "host", type: "tree", mode: "040000", sha: host }]
              : capable
              ? [{
                path: "matrix-actions.ts",
                type: "blob",
                mode: "100644",
                sha: "d".repeat(40),
              }]
              : [];
            const body = path.includes("/git/commits/")
              ? { sha: LAUNCHER, tree: { sha: root } }
              : {
                sha: path.split("/").at(-1),
                truncated: false,
                tree: entries,
              };
            return Promise.resolve(
              {
                status: 200,
                headers: new Headers(),
                bodyText: JSON.stringify(body),
              } satisfies HttpResponseV1,
            );
          },
        });
        rig.evidence.verifyMatrixOrdinaryRevision = (revision) =>
          client.verifyMatrixOrdinaryRevision(revision);
        const decision = await rig.prepare(run(2));
        assert.equal(decision.status, capable ? "run" : "idle");
        assert.equal(
          requests[0],
          "/repos/ubiquity/sentinel/git/commits/" +
            before.hostedRuntimes[0].activeRevision,
        );
        assert.ok(requests.every((path) => !path.includes("development")));
        if (capable) {
          const ordinary = requireRun(decision);
          assert.equal(ordinary.purpose, "ordinary");
          assert.equal(
            ordinary.revision,
            before.hostedRuntimes[0].activeRevision,
          );
        } else assert.deepEqual(await rig.snapshot(), before);
      } finally {
        await rig.cleanup();
      }
    });
  }
});

Deno.test("ordinary matrix capability: pointer movement during source proof refuses stale admission", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    let concurrentId: string | null = null;
    rig.evidence.verifyMatrixOrdinaryRevision = async (revision) => {
      assert.equal(revision, LAUNCHER);
      // A real concurrent release saves its prior proof and promotion intent.
      // The fixture never bypasses the state writer's pointer guards.
      rig.evidence.verifyMatrixOrdinaryRevision = () =>
        Promise.resolve(portOk(true));
      await ordinaryTurn(rig, 97);
      const request = releaseRequest();
      await rig.seedRepair([request], [reviewReceipt(request)]);
      rig.evidence.requests.add(request.id);
      const prior = requireRun(await rig.prepare(run(98)));
      assert.equal(prior.purpose, "prior");
      rig.evidence.settlements.set(prior.id, runProof(prior, "healthy"));
      await ordinaryTurn(rig, 96);
      const concurrent = requireRun(await rig.prepare(run(99)));
      assert.equal(concurrent.purpose, "candidate");
      concurrentId = concurrent.id;
      return portOk(true);
    };
    assert.equal((await rig.prepare(run(2))).status, "pending");
    const snapshot = await rig.snapshot();
    assert.equal(snapshot.hostedRuntimes[0].activeRevision, CANDIDATE);
    assert.equal(snapshot.hostedRuntimes[0].generation, 2);
    assert.equal(snapshot.hostedRuntimes[0].execution?.id, concurrentId);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("ordinary matrix capability: bootstrap prior candidate and rollback retain repair verification without the gate", async () => {
  const rig = await makeRig();
  try {
    const advanced = await advanceToCandidate(rig);
    rig.evidence.matrixCalls.length = 0;
    rig.evidence.verifyMatrixOrdinaryRevision = () => {
      throw new Error("verification must not call ordinary capability");
    };
    assert.equal(advanced.prior.purpose, "prior");
    assert.equal(advanced.candidate.purpose, "candidate");
    rig.evidence.settlements.set(
      advanced.candidate.id,
      runProof(advanced.candidate, "failed"),
    );
    const rollback = requireRun(await rig.prepare(run(4)));
    assert.equal(rollback.purpose, "rollback");
    assert.equal(rollback.revision, LAUNCHER);
    assert.equal(rig.evidence.matrixCalls.length, 0);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("ordinary matrix capability: settled candidate verification reaches only the ordinary gate", async () => {
  const rig = await makeRig();
  try {
    const calls: GitSha[] = [];
    const { candidate } = await advanceToCandidate(rig);
    rig.evidence.verifyMatrixOrdinaryRevision = (revision) => {
      calls.push(revision);
      return Promise.resolve(portOk(false));
    };
    rig.evidence.settlements.set(candidate.id, runProof(candidate, "healthy"));
    const decision = await rig.prepare(run(4));
    assert.equal(decision.status, "idle");
    assert.deepEqual(calls, [CANDIDATE]);
    const snapshot = await rig.snapshot();
    assert.equal(snapshot.hostedRuntimes[0].activeRevision, CANDIDATE);
    assert.equal(snapshot.hostedRuntimes[0].execution, null);
    assert.equal(snapshot.hostedReleases[0].phase, "accepted");
  } finally {
    await rig.cleanup();
  }
});
