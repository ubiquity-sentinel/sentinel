/** Authenticated historical runtime isolation and logical scan deadlines. */
import assert from "node:assert/strict";
import { createActionsMatrixArtifactTransport } from "../../src/host/matrix-artifacts.ts";
import { matrixDigestV1 } from "../../src/contracts/matrix.ts";
import { SHA2, SHA3, T0 } from "../state/helpers.ts";
import {
  bytes,
  fixture,
  RESERVATION,
  RUN,
  RUNTIME,
  WAVE,
  zip,
} from "./matrix-artifact-fixtures.ts";

Deno.test("matrix artifacts: a historical wave bound to its own plan is accepted after the installed runtime moved", async () => {
  const rig = await fixture();
  try {
    const waves = await rig.transport.recover({
      ...rig.input,
      currentRun: undefined,
      runtimeSha: SHA3,
      consumerRun: { ...RUN, runId: 99, runAttempt: 1 },
    });
    assert.equal(waves.length, 1);
    assert.equal(waves[0].planDigest, rig.plannerMarker.planDigest);
    assert.equal(waves[0].plan.waveId, WAVE);
    assert.deepEqual(waves[0].provenance.run, RUN);
    assert.equal(waves[0].results.length, 1);
    assert.equal(waves[0].results[0].runtimeSha, RUNTIME);
    assert.equal(waves[0].results[0].reservationId, RESERVATION);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("matrix artifacts: only authenticated historical runtime mismatch has a typed isolation disposition", async (t) => {
  for (
    const scenario of [
      "current unscoped",
      "current scoped",
      "consumer absent",
      "forged planner",
      "forged cell",
      "archive unavailable",
      "missing cell",
      "saved execution mismatch",
    ] as const
  ) {
    await t.step(scenario, async () => {
      const rig = await fixture();
      try {
        const historical = { ...rig.input, currentRun: undefined };
        const input: Parameters<typeof rig.transport.recover>[0] = {
          ...historical,
          runtimeSha: SHA3,
          consumerRun: { ...RUN, runId: 99, runAttempt: 1 },
        };
        if (scenario === "current unscoped") input.consumerRun = RUN;
        if (scenario === "current scoped") input.currentRun = RUN;
        if (scenario === "consumer absent") delete input.consumerRun;
        if (scenario === "forged planner") rig.jobs[0].head_sha = SHA2;
        if (scenario === "forged cell") {
          rig.artifacts[1].workflow_run = { id: 999 };
        }
        if (scenario === "archive unavailable") rig.artifacts[1].expired = true;
        if (scenario === "missing cell") {
          // Keep the matching native name for selection but remove its job.
          rig.jobs.splice(1, 1);
        }
        if (scenario === "saved execution mismatch") {
          rig.release.hostedRuntimes[0].execution = {
            ...rig.release.hostedRuntimes[0].execution!,
            ...RUN,
            id: WAVE,
            revision: SHA2,
          };
        }
        const custody = structuredClone(rig.repair);
        const archives = [...rig.archives].map((
          [id, content],
        ) => [id, content.slice()]);
        await assert.rejects(
          () => rig.transport.recover(input),
          /provenance unavailable or conflicting/,
        );
        assert.deepEqual(rig.repair, custody);
        assert.deepEqual([...rig.archives], archives);
        assert.deepEqual(
          [...Deno.readDirSync(rig.tmp + "/recovered")],
          [],
          "rejected bundles never escape transport staging",
        );
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
});

Deno.test("matrix artifacts: a historical wave whose cell runtime disagrees with its plan is still refused", async () => {
  const rig = await fixture();
  try {
    const plan = structuredClone(rig.plan);
    plan.cells[0].runtimeSha = SHA2;
    await rig.setArchive(
      501,
      rig.planName,
      await zip([
        { name: "plan.json", content: bytes(plan) },
      ]),
    );
    rig.plannerMarker.planDigest = await matrixDigestV1(plan);
    rig.logs.set(
      401,
      `${new Date(T0).toISOString()} ${JSON.stringify(rig.plannerMarker)}\n`,
    );
    await assert.rejects(
      () =>
        rig.transport.recover({
          ...rig.input,
          currentRun: undefined,
          runtimeSha: SHA3,
          consumerRun: { ...RUN, runId: 99, runAttempt: 1 },
        }),
      /provenance unavailable or conflicting/,
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("matrix artifacts: a historical wave with a missing cell artifact accepts only the authenticated cells", async () => {
  const rig = await fixture(false, true);
  try {
    const custody = structuredClone(rig.repair);
    const waves = await rig.transport.recover({
      ...rig.input,
      currentRun: undefined,
      runtimeSha: SHA3,
      consumerRun: { ...RUN, runId: 99, runAttempt: 1 },
    });
    assert.equal(waves.length, 1);
    assert.equal(waves[0].plan.cells.length, 2);
    assert.equal(waves[0].results.length, 1);
    assert.equal(waves[0].results[0].reservationId, RESERVATION);
    assert.deepEqual(rig.repair, custody);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("matrix artifacts: logical scan deadline only shortens HTTP budgets and expires without new requests", async (t) => {
  for (
    const scenario of [
      "short",
      "long",
      "expired",
      "expires during HTTP",
    ] as const
  ) {
    await t.step(scenario, async () => {
      const rig = await fixture();
      const cwd = Deno.cwd();
      try {
        let now = T0 + 10_000;
        const start = now;
        const bound = scenario === "long"
          ? 240_000
          : scenario === "expired"
          ? 0
          : 5_000;
        const calls: { at: number; deadlineMs?: number }[] = [];
        const transport = createActionsMatrixArtifactTransport({
          state: rig.state,
          token: "fake-local-token",
          artifactRoot: rig.tmp + "/bounded",
          clock: { now: () => now },
          http(request) {
            calls.push({ at: now, deadlineMs: request.deadlineMs });
            now += scenario === "expires during HTTP" ? 5_001 : 100;
            return rig.http(request);
          },
        });
        Deno.chdir(rig.tmp + "/checkout");
        const recover = () =>
          transport.recover({ ...rig.input, deadline: start + bound });
        if (scenario === "expires during HTTP") {
          await assert.rejects(
            recover,
            /provenance unavailable or conflicting/,
          );
          assert.equal(
            calls.length,
            1,
            "no HTTP call may start after the absolute deadline",
          );
        } else {
          const waves = await recover();
          assert.equal(waves.length, scenario === "expired" ? 0 : 1);
          if (scenario === "expired") assert.equal(calls.length, 0);
          else assert.ok(calls.length > 1);
        }
        for (const call of calls) {
          assert.equal(
            call.deadlineMs,
            start + Math.min(bound, 120_000) - call.at,
          );
        }
      } finally {
        Deno.chdir(cwd);
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
});
