/**
 * Fan-out repository passes and the single trusted writer (issue #328).
 *
 * Each case runs the ACTUAL step loop per repository against one shared
 * in-memory snapshot (concurrently, never writing it), then applies the
 * sealed deltas through the existing repair-state writer. No network, no
 * model call, no real waiting.
 */
import assert from "node:assert/strict";
import {
  canonicalDigestV1,
  REPAIR_DELTA_ENVELOPE_KIND,
  type RepairDeltaEnvelopeV1,
  sealRepairDeltaV1,
} from "../../src/contracts/repair-delta.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  FANOUT_SUMMARY_LINE_KIND,
  parseFanoutSummaryLine,
} from "../../src/repair/fanout-summary-line.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { PASS_SUMMARY_LINE_KIND } from "../../src/repair/pass-summary-line.ts";
import { applyRepairDeltas } from "../../src/repair/repair-delta-apply.ts";
import { repairFanoutMatrixV1 } from "../../src/repair/repair-fanout-plan.ts";
import { runRepositoryRepairPass } from "../../src/repair/repository-pass.ts";
import { SHA1, SHA2 } from "../state/helpers.ts";
import {
  captured,
  makeRig,
  MINUTE,
  pendingArtifact,
  plan,
  REPOS,
  type Rig,
} from "./repository-pass-rig.ts";

const [ALPHA, BETA, GAMMA] = REPOS;

function fleet(): WorkRecordV1[] {
  return [
    ...[0, 1, 2].map((index) => pendingArtifact(ALPHA, index)),
    ...[100, 101].map((index) => pendingArtifact(BETA, index)),
    pendingArtifact(GAMMA, 200, { nextStep: "done", intent: null }),
  ];
}

/** Every planned repository pass, started together on the planned head. */
async function fanOut(rig: Rig) {
  const { plan: fanout, binding } = await plan(rig);
  const { value: results } = await captured(() =>
    Promise.all(
      fanout.repositories.map((repository) =>
        runRepositoryRepairPass(rig.deps, {
          repository,
          binding,
          baseHead: fanout.baseHead,
          deadline: rig.clock.now() + 90 * MINUTE,
          stepLimit: 1_000,
          modelStartsEnabled: true,
        })
      ),
    )
  );
  const envelopes = results.map((result) => {
    assert.equal(result.status, "sealed", JSON.stringify(result));
    return (result as { envelope: RepairDeltaEnvelopeV1 }).envelope;
  });
  return { fanout, binding, envelopes };
}

/** A correctly sealed envelope around an arbitrary (malformed) body. */
async function sealRawDelta(delta: unknown): Promise<unknown> {
  return {
    version: "v1",
    kind: REPAIR_DELTA_ENVELOPE_KIND,
    delta,
    digest: await canonicalDigestV1({
      kind: REPAIR_DELTA_ENVELOPE_KIND,
      delta,
    }),
  };
}

function artifacts(envelopes: RepairDeltaEnvelopeV1[]) {
  return envelopes.map((envelope) => ({
    repository: envelope.delta.repository,
    envelope: structuredClone(envelope) as unknown,
  }));
}

function row(rig: Rig, id: string): WorkRecordV1 {
  const found = rig.state.repair!.work.find((record) => record.id === id);
  assert.ok(found !== undefined, id);
  return found;
}

function apply(
  rig: Rig,
  binding: Awaited<ReturnType<typeof plan>>["binding"],
  list: { repository: typeof ALPHA; envelope: unknown }[],
  deadline = rig.clock.now() + 10 * MINUTE,
) {
  return captured(() =>
    applyRepairDeltas(rig.deps, { binding, artifacts: list, deadline })
  );
}

Deno.test("fan-out: two repositories step concurrently on one snapshot and the trusted writer applies both in one write", async () => {
  const rig = makeRig(fleet());
  const { fanout, binding, envelopes } = await fanOut(rig);
  // The done gamma record plans no cell.
  assert.deepEqual(repairFanoutMatrixV1(fanout).include, [
    { repository: "ubiquity/alpha", installationId: 7 },
    { repository: "ubiquity/beta", installationId: 7 },
  ]);
  // The passes wrote nothing shared and performed no GitHub effect.
  assert.equal(rig.state.repairWrites, 0);
  assert.equal(rig.state.repairHead, SHA1);
  assert.deepEqual(rig.github.effects(), []);
  const [alpha, beta] = envelopes.map((envelope) => envelope.delta);
  assert.equal(alpha.baseHead, SHA1);
  assert.deepEqual(alpha.transitions.map((t) => t.after.id), [
    "issue-alpha-0",
    "issue-alpha-1",
    "issue-alpha-2",
  ]);
  assert.deepEqual(beta.transitions.map((t) => t.after.id), [
    "issue-beta-100",
    "issue-beta-101",
  ]);
  for (const delta of [alpha, beta]) {
    assert.deepEqual(delta.deferredToTrusted, []);
    for (const transition of delta.transitions) {
      assert.ok(transition.after.stepInputs !== undefined);
      assert.equal(transition.after.repository.name, delta.repository.name);
    }
  }

  const { value: applied, lines } = await apply(
    rig,
    binding,
    artifacts(envelopes),
  );
  assert.equal(applied.status, "applied");
  assert.deepEqual(applied.rejected, []);
  assert.equal(rig.state.repairWrites, 1, "one trusted write for both");
  for (const transition of [...alpha.transitions, ...beta.transitions]) {
    assert.deepEqual(row(rig, transition.after.id), transition.after);
  }
  const summary = lines.filter((line) =>
    line.kind === FANOUT_SUMMARY_LINE_KIND
  );
  assert.equal(summary.length, 1);
  const parsed = parseFanoutSummaryLine(summary[0]);
  assert.ok(parsed !== null);
  assert.equal(parsed.deltasApplied, 2);
  assert.equal(parsed.transitionsApplied, 5);
  assert.equal(parsed.repositoryWallMs.length, 2);

  // The applied stamps are the serial pass's own: an unchanged next serial
  // pass steps nothing and writes nothing.
  rig.clock.advance(5 * MINUTE);
  const head = rig.state.repairHead;
  const { lines: serial } = await captured(() =>
    runRepairCycle(rig.deps, {
      deadline: rig.clock.now() + 90 * MINUTE,
      stepLimit: 1_000,
      modelStartsEnabled: true,
    })
  );
  const pass = serial.find((line) => line.kind === PASS_SUMMARY_LINE_KIND);
  assert.equal(pass?.recordsStepped, 0, JSON.stringify(pass));
  assert.deepEqual(pass?.skipReasons, { unchanged_inputs: 5, waiting: 0 });
  assert.equal(rig.state.repairHead, head);
});

Deno.test("fan-out: a delta whose repository base moved is rejected whole while the other applies", async () => {
  const rig = makeRig(fleet());
  const { binding, envelopes } = await fanOut(rig);
  // Another trusted writer moves one alpha record and the unrelated gamma
  // record after the plan; beta's projection is untouched.
  const moved = rig.state.repair!.work.map((record) =>
    record.id === "issue-alpha-1"
      ? {
        ...record,
        wait: {
          reason: "backoff" as const,
          since: record.updatedAt,
          until: record.updatedAt + MINUTE,
        },
      }
      : record.id === "issue-gamma-200"
      ? { ...record, updatedAt: record.updatedAt + 1 }
      : record
  );
  const written = await rig.state.writeRepair(
    { ...rig.state.repair!, sequence: 2, work: moved },
    SHA1,
  );
  assert.ok(written.ok && written.value.status === "applied");
  const before = structuredClone(rig.state.repair!);
  const writes = rig.state.repairWrites;

  const { value: result } = await apply(rig, binding, artifacts(envelopes));
  assert.equal(result.status, "applied");
  assert.deepEqual(result.applied.map((entry) => entry.repository.name), [
    "beta",
  ]);
  assert.deepEqual(result.rejected, [
    { repository: ALPHA, reason: "base_moved" },
  ]);
  assert.equal(rig.state.repairWrites, writes + 1);
  // No alpha row moved at all: the stale delta contributed nothing.
  for (const id of ["issue-alpha-0", "issue-alpha-1", "issue-alpha-2"]) {
    assert.deepEqual(
      row(rig, id),
      before.work.find((record) => record.id === id),
    );
  }
  assert.ok(row(rig, "issue-beta-100").stepInputs !== undefined);

  // Every delta stale now: nothing is written.
  const again = rig.state.repairWrites;
  const { value: none } = await apply(rig, binding, artifacts(envelopes));
  assert.equal(none.status, "none");
  assert.deepEqual(none.rejected.map((entry) => entry.reason), [
    "base_moved",
    "base_moved",
  ]);
  assert.equal(rig.state.repairWrites, again);
});

Deno.test("fan-out: unsealed, tampered, rebound and charging deltas are refused before any write", async () => {
  const rig = makeRig(fleet());
  const { binding, envelopes } = await fanOut(rig);
  const [alpha, beta] = envelopes;
  const tampered = structuredClone(alpha);
  tampered.delta.transitions[0].after.nextStep = "done";
  const unsigned = structuredClone(alpha) as Partial<RepairDeltaEnvelopeV1>;
  delete unsigned.digest;
  // A validly resealed delta that charges an attempt is still refused.
  const charged = structuredClone(alpha.delta);
  charged.transitions[0].after.counters.attempts += 1;
  const resealed = await sealRepairDeltaV1(charged);
  const otherAttempt = await sealRepairDeltaV1({
    ...structuredClone(beta.delta),
    binding: { ...binding, runAttempt: 2 },
  });
  const cases: [unknown, typeof ALPHA, string][] = [
    [unsigned, ALPHA, "unauthenticated"],
    [alpha.delta, ALPHA, "unauthenticated"],
    [
      await sealRawDelta({ ...alpha.delta, extra: 1 }),
      ALPHA,
      "invalid",
    ],
    [tampered, ALPHA, "unauthenticated"],
    [{ ...alpha, digest: "0".repeat(64) }, ALPHA, "unauthenticated"],
    [alpha, BETA, "unauthenticated"],
    [otherAttempt, BETA, "unauthenticated"],
    [resealed, ALPHA, "transition_refused"],
  ];
  for (const [envelope, repository, reason] of cases) {
    const { value: result } = await apply(rig, binding, [
      { repository, envelope },
    ]);
    assert.equal(result.status, "none", reason);
    assert.deepEqual(result.rejected.map((entry) => entry.reason), [reason]);
  }
  assert.equal(rig.state.repairWrites, 0);
  // Two deltas for one repository: the second is a duplicate.
  const { value: duplicate } = await apply(
    rig,
    binding,
    artifacts([beta, beta]),
  );
  assert.deepEqual(duplicate.rejected.map((entry) => entry.reason), [
    "duplicate",
  ]);
  assert.equal(rig.state.repairWrites, 1, "only the one valid beta delta");
});

Deno.test("fan-out: a step that needs a GitHub effect is discarded and deferred to the trusted writer", async () => {
  // A produced candidate with no PR: its step would assign, push and publish.
  const publish = pendingArtifact(ALPHA, 60, {
    intent: null,
    target: {
      base: SHA1,
      branch: "sentinel/repair/issue-alpha-60",
      checkpoint: null,
      head: SHA2,
      pr: null,
    },
  });
  const rig = makeRig([...fleet(), publish]);
  const { binding, envelopes } = await fanOut(rig);
  assert.deepEqual(rig.github.effects(), [], "no effect reached GitHub");
  assert.equal(rig.state.repairWrites, 0);
  const alpha = envelopes[0].delta;
  assert.deepEqual(alpha.deferredToTrusted, ["issue-alpha-60"]);
  // The other records keep the stamps their own clean steps settled.
  assert.deepEqual(alpha.transitions.map((t) => t.after.id), [
    "issue-alpha-0",
    "issue-alpha-1",
    "issue-alpha-2",
  ]);
  const { value: result } = await apply(rig, binding, artifacts(envelopes));
  assert.equal(result.status, "applied");
  assert.deepEqual(row(rig, "issue-alpha-60"), publish);
});

Deno.test("fan-out: intake of a new issue stays with the trusted writer", async () => {
  const rig = makeRig(fleet(), {
    openIssues: [{ number: 999, title: "New failure", body: "Steps" }],
  });
  const { envelopes } = await fanOut(rig);
  assert.equal(rig.state.repairWrites, 0);
  for (const envelope of envelopes) {
    const delta = envelope.delta;
    // No record is created by a delta; the new one is the trusted path's.
    assert.ok(delta.deferredToTrusted.length > 0, JSON.stringify(delta));
    for (const transition of delta.transitions) {
      assert.ok(
        rig.state.repair!.work.some((row) => row.id === transition.after.id),
      );
      assert.equal(
        delta.deferredToTrusted.includes(transition.after.id),
        false,
      );
    }
  }
});

Deno.test("fan-out: no write starts at or after the shared deadline", async () => {
  const rig = makeRig(fleet());
  const { binding, envelopes } = await fanOut(rig);
  const { value: late } = await apply(
    rig,
    binding,
    artifacts(envelopes),
    rig.clock.now(),
  );
  assert.equal(late.status, "none");
  assert.equal(rig.state.repairWrites, 0);
});
