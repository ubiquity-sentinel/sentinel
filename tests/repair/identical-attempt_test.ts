/** #334: identical attempts are refused by base, patch and findings. */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import {
  ATTEMPT_INPUT_DOMAINS,
  attemptFindingsDigestV1,
  attemptInputFingerprintV1,
  attemptPatchDigestV1,
  IDENTICAL_ATTEMPT_FACT_PREFIX,
} from "../../src/contracts/attempt-input.ts";
import type { AttemptInputV1 } from "../../src/contracts/attempt-input.ts";
import {
  attemptMemoryIdV1,
  parseAttemptMemoryRecordV1,
} from "../../src/contracts/attempt-memory.ts";
import type { AttemptMemoryRecordV1 } from "../../src/contracts/attempt-memory.ts";
import { canonicalStringifySha256 } from "../../src/contracts/canonical.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  ATTEMPT_DETAIL_INCOMPLETE,
  ATTEMPT_DETAIL_PROVIDER_THROTTLED,
  attemptMemorySettlementMutationV1,
} from "../../src/repair/attempt-policy.ts";
import {
  attemptInputsForRecordV1,
  identicalAttemptRefusalV1,
} from "../../src/repair/identical-attempt.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { prepareImplementationStart } from "../../src/repair/loop-implementation.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
} from "../../src/repair/loop-types.ts";
import { buildPrompt } from "../../src/repair/model-port-prompt.ts";
import {
  reviewReceipt,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "./helpers.ts";
import { exactOpenPr, positiveLifecycle } from "./loop-candidate-fixtures.ts";
import { seededSnapshot } from "./loop-rig.ts";

const PRIOR_ATTEMPT = "a".repeat(64);
const HEAD = SHA2;
const ID = "issue-1";
const BRANCH = candidateBranch(asWorkItemId(ID));

/** The live 65-attempt / 70-round shape: a published head under correction. */
function loopedRecord(): WorkRecordV1 {
  return workRecord(ID, {
    source: { kind: "issue", id: "1", revision: SHA1 },
    related: { incidentId: null, issueNumber: 1 },
    target: {
      base: SHA1,
      branch: BRANCH,
      checkpoint: null,
      head: HEAD,
      pr: 7,
      candidateState: { preserved: null, publishedHead: HEAD },
    },
    counters: { attempts: 65, retries: 64, reviewRounds: 70 },
  });
}

function rejection(message: string) {
  return reviewReceipt("review-rejected", {
    pullRequest: { number: 7, head: HEAD, base: SHA1 },
    outcome: "completed",
    resultId: "result-1",
    observedReviewer: "chatgpt-codex-connector[bot]",
    findings: [{
      id: "finding-p0",
      severity: "P0",
      path: "src/app.ts",
      message,
      fingerprint: "b".repeat(64),
      resolved: false,
      resolutionEvidence: null,
    }],
    unresolvedSeverities: ["P0"],
    completedAt: T0 + 1500,
  });
}

/** Many identical semantic outcomes (bounded entries) plus one input row. */
async function familyWith(
  record: WorkRecordV1,
  row: AttemptInputV1 | null,
): Promise<AttemptMemoryRecordV1> {
  const id = await attemptMemoryIdV1({
    repository: record.repository,
    taskId: record.id,
    base: record.target.base,
    purpose: "implementation",
  });
  const entries = Array.from({ length: 16 }, (_, index) => ({
    fingerprint: index.toString(16).padStart(64, "0"),
    stage: "model" as const,
    failureClass: "semantic_no_progress" as const,
    detail: ATTEMPT_DETAIL_INCOMPLETE,
    controllerSha: SHA1,
    count: index === 15 ? 50 : 1,
    firstAtMs: T0 - 100_000 + index,
    lastAtMs: T0 - 100_000 + index,
  }));
  return parseAttemptMemoryRecordV1({
    version: "v1",
    kind: "attempt_memory",
    id,
    repository: record.repository,
    taskId: record.id,
    base: record.target.base,
    purpose: "implementation",
    entries,
    ...(row === null ? {} : { inputs: [row] }),
  });
}

function priorRow(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
  refused = false,
): AttemptInputV1 {
  const inputs = attemptInputsForRecordV1(snapshot, record, SHA1);
  return {
    ...inputs,
    attemptId: PRIOR_ATTEMPT,
    atMs: T0 - 1000,
    refusals: refused ? 1 : 0,
    lastRefusedAtMs: refused ? T0 - 500 : null,
  };
}

function rig(snapshot: RepairStateSnapshotV1) {
  const state = new MemoryState();
  state.repair = snapshot;
  state.repairHead = SHA1;
  const clock = new FakeClock(T0);
  const configs = repairConfigs({
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
  });
  const github = new FakeGithub({
    baseSha: SHA1,
    candidateLifecycle: {
      ...positiveLifecycle(),
      refs: { [`refs/heads/${BRANCH}`]: HEAD },
      pullRequests: [exactOpenPr(7, HEAD, BRANCH)],
    },
  });
  const deps: RepairCycleDepsV1 = {
    clock,
    state,
    configs,
    controllerSha: SHA1,
    github,
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
    incidents: new FakeIncidents({ summaries: [] }),
    replay: new FakeReplay(),
    model: new FakeModel(),
    budget: new RollingStartBudget({ clock, state, configs }),
  };
  const context: LoopContextV1 = {
    snapshot,
    head: SHA1,
    executionBaseline: snapshot.work[0]!,
    bounds: {
      runDeadline: clock.now() + 60 * 60_000,
      modelCutoff: clock.now() + 60 * 60_000,
    },
  };
  const start = () =>
    prepareImplementationStart(
      deps,
      context,
      snapshot.work[0]!,
      configs[0]!,
      undefined,
      { existingHeadContinuation: true },
    );
  const read = async () => {
    const after = await state.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    if (!after.ok || after.value.status !== "found") throw new Error("state");
    return after.value.snapshot;
  };
  return { start, read };
}

Deno.test("the second identical attempt is refused before reservation with the prior attempt id", async () => {
  const record = loopedRecord();
  const base = seededSnapshot([record], { reviews: [rejection("fix it")] });
  const family = await familyWith(record, priorRow(base, record));
  const snapshot = { ...base, attemptMemory: [family] };
  const { start, read } = rig(snapshot);

  const result = await start();
  assert.equal(result.kind, "progress", JSON.stringify(result));
  const after = await read();
  const refused = after.work.find((row) => row.id === record.id)!;
  assert.equal(refused.nextStep, "blocked");
  assert.equal(refused.blocker?.kind, "other");
  assert.match(
    refused.blocker?.message ?? "",
    new RegExp(`^identical_attempt_refused: prior attempt ${PRIOR_ATTEMPT} `),
  );
  assert.deepEqual(
    refused.counters,
    record.counters,
    "no attempt is started or counted",
  );
  assert.equal(after.reservations.length, 0, "no reservation is written");
  const row = after.attemptMemory[0]!.inputs![0]!;
  assert.equal(row.attemptId, PRIOR_ATTEMPT, "the prior row is not rewritten");
  assert.equal(row.refusals, 1);
  assert.equal(row.lastRefusedAtMs, T0);
  assert.deepEqual(
    after.attemptMemory[0]!.entries,
    family.entries,
    "prior failure history and counts are untouched",
  );
});

Deno.test("changed findings are a distinct attempt, admitted with the refusal fact", async () => {
  const record = loopedRecord();
  const prior = seededSnapshot([record], { reviews: [rejection("fix it")] });
  const family = await familyWith(record, priorRow(prior, record, true));
  const snapshot = seededSnapshot([record], {
    reviews: [rejection("a different finding")],
    attemptMemory: [family],
  });
  const { start, read } = rig(snapshot);

  const prepared = await start();
  assert.equal(prepared.kind, "prepared", JSON.stringify(prepared));
  if (prepared.kind !== "prepared") return;
  assert.equal((await read()).reservations.length, 1, "admitted as today");
  const fact = prepared.request.priorAttempts?.[0];
  assert.ok(fact !== undefined);
  assert.equal(
    fact.detail,
    `${IDENTICAL_ATTEMPT_FACT_PREFIX}prior attempt ${PRIOR_ATTEMPT}; ` +
      "identical inputs: base tip, candidate patch, runtime revision; " +
      "changed: review findings",
  );
  const prompt = buildPrompt(prepared.request, false);
  assert.match(prompt, /IDENTICAL ATTEMPT REFUSED/);
  assert.ok(prompt.includes(PRIOR_ATTEMPT));
  assert.equal(
    prompt.split(IDENTICAL_ATTEMPT_FACT_PREFIX).length,
    2,
    "the refusal is rendered once, outside the already-tried list",
  );
});

Deno.test("a changed base tip is a distinct attempt and is admitted", async () => {
  const record = loopedRecord();
  const snapshot0 = seededSnapshot([record], {
    reviews: [rejection("fix it")],
  });
  // The prior attempt ran against an older base tip with the same candidate
  // head and findings.
  const olderBase = { ...record, target: { ...record.target, base: SHA3 } };
  const row = priorRow(snapshot0, olderBase);
  const family = await familyWith(record, row);
  const snapshot = { ...snapshot0, attemptMemory: [family] };
  assert.equal(identicalAttemptRefusalV1(snapshot, record, SHA1), null);
  const { start, read } = rig(snapshot);
  const prepared = await start();
  assert.equal(prepared.kind, "prepared", JSON.stringify(prepared));
  assert.equal((await read()).reservations.length, 1);
});

Deno.test("a changed candidate head or runtime revision is distinct", async () => {
  const record = loopedRecord();
  const snapshot0 = seededSnapshot([record], {
    reviews: [rejection("fix it")],
  });
  const family = await familyWith(record, priorRow(snapshot0, record));
  const snapshot = { ...snapshot0, attemptMemory: [family] };
  assert.notEqual(identicalAttemptRefusalV1(snapshot, record, SHA1), null);
  assert.equal(identicalAttemptRefusalV1(snapshot, record, SHA3), null);
  const moved = { ...record, target: { ...record.target, head: SHA3 } };
  assert.equal(identicalAttemptRefusalV1(snapshot, moved, SHA1), null);
});

Deno.test("historical attempt memory without inputs parses and never matches", async () => {
  const record = loopedRecord();
  const family = await familyWith(record, null);
  assert.equal("inputs" in family, false, "the legacy shape is never injected");
  const reparsed = parseAttemptMemoryRecordV1(
    JSON.parse(JSON.stringify(family)),
  );
  assert.deepEqual(reparsed, family);
  const snapshot = seededSnapshot([record], {
    reviews: [rejection("fix it")],
    attemptMemory: [family],
  });
  assert.equal(identicalAttemptRefusalV1(snapshot, record, SHA1), null);
  const { start } = rig(snapshot);
  assert.equal((await start()).kind, "prepared");
});

Deno.test("only proven outcomes record the admitted attempt's inputs", async () => {
  const intent = {
    kind: "implementation" as const,
    key: "implementation:x",
    startedAt: T0,
    branch: BRANCH,
    expectedHead: null,
    observedBase: SHA1,
    pr: null,
    requestId: PRIOR_ATTEMPT,
    resultId: null,
  };
  const record = { ...loopedRecord(), intent } as WorkRecordV1;
  const settle = async (detail: string) => {
    const draft = seededSnapshot([record], { reviews: [rejection("fix it")] });
    const mutation = await attemptMemorySettlementMutationV1({
      record,
      detail,
      now: T0,
      runtimeSha: SHA1,
    });
    mutation(draft);
    return draft;
  };
  const semantic = await settle(ATTEMPT_DETAIL_INCOMPLETE);
  const rows = semantic.attemptMemory[0]!.inputs!;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.attemptId, PRIOR_ATTEMPT);
  assert.equal(
    rows[0]!.fingerprint,
    attemptInputsForRecordV1(semantic, record, SHA1).fingerprint,
  );
  parseAttemptMemoryRecordV1(semantic.attemptMemory[0]);
  const transient = await settle(ATTEMPT_DETAIL_PROVIDER_THROTTLED);
  assert.equal(
    transient.attemptMemory[0]!.inputs,
    undefined,
    "a transient failure proves nothing about its inputs",
  );
});

Deno.test("attempt input digest domains are distinct and canonical", async () => {
  const findings = [{ severity: "P0", path: null, message: "x" }];
  assert.equal(
    attemptFindingsDigestV1(findings),
    await canonicalStringifySha256({
      domain: ATTEMPT_INPUT_DOMAINS.findings,
      findings,
    }),
  );
  assert.equal(attemptFindingsDigestV1(null), attemptFindingsDigestV1([]));
  const two = [...findings, { severity: "P1", path: "a", message: "y" }];
  assert.equal(
    attemptFindingsDigestV1(two),
    attemptFindingsDigestV1([...two].reverse()),
  );
  const patch = attemptPatchDigestV1({ base: SHA1, head: null });
  const values = new Set([
    patch,
    attemptFindingsDigestV1([]),
    attemptInputFingerprintV1({
      taskId: asWorkItemId(ID),
      purpose: "implementation",
      controllerSha: SHA1,
      baseTip: SHA1,
      patchDigest: patch,
      findingsDigest: patch,
    }),
  ]);
  assert.equal(values.size, 3);
  assert.equal(
    new Set(Object.values(ATTEMPT_INPUT_DOMAINS)).size,
    3,
  );
});
