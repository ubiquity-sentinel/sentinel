/** Full raw issue discovery and bounded shared implementation admission. */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { parseMatrixPlanV1 } from "../../src/contracts/matrix.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { MaxText } from "../../src/contracts/validation.ts";
import { MAX_PULL_BODY, MAX_WIRE_TEXT } from "../../src/github/wire.ts";
import { scopeLocalRepairIssues } from "../../src/host/local.ts";
import { planMatrixWave } from "../../src/host/matrix.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { ISSUE_PREREQUISITE_RETRY_MS } from "../../src/repair/loop-bounds.ts";
import { httpRespond, issueWire, makePort } from "../github/helpers.ts";
import { repairConfigs } from "../repair/helpers.ts";
import { makeRig } from "../repair/loop-rig.ts";
import { REPO, SHA1, T0 } from "../state/helpers.ts";
import { r80Available, withR80Parsers } from "./r80-contracts.ts";

const ISSUES = `/repos/${REPO.owner}/${REPO.name}/issues`;
const LARGE_LENGTH = 23_807;
const SKIP = "<!-- sentinel:skip -->\n";

function readPort(body: string | null) {
  return makePort({
    repository: REPO,
    script: [httpRespond("GET", `${ISSUES}/7`, 200, issueWire({ body }))],
  });
}

Deno.test("issue body wire: preserves the complete raw range beyond the review limit", async () => {
  assert.equal(MaxText.body, 16_384);
  assert.equal(MAX_PULL_BODY, 16_384);
  for (const length of [16_384, 16_385, LARGE_LENGTH, MAX_WIRE_TEXT]) {
    const body = "x".repeat(length - 1) + "z";
    const { port, transport } = readPort(body);
    const read = await port.readIssue(7);
    assert.ok(read.ok, `raw body length ${length} must be readable`);
    assert.equal(read.value?.body, body);
    assert.equal(transport.requests.length, 1);
  }
  const empty = await readPort(null).port.readIssue(7);
  assert.ok(empty.ok);
  assert.equal(empty.value?.body, "");
});

Deno.test("issue body wire: the finite raw ceiling still refuses incomplete reads", async () => {
  const body = "x".repeat(MAX_WIRE_TEXT + 1);
  const read = await readPort(body).port.readIssue(7);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.error.kind, "unavailable");
  const { port } = makePort({
    repository: REPO,
    script: [
      httpRespond("GET", `${ISSUES}?state=open&per_page=100&page=1`, 200, [
        issueWire({ number: 1 }),
        issueWire({ number: 2, body }),
      ]),
    ],
  });
  const listed = await port.listOpenIssues();
  assert.equal(listed.ok, false, "overflow cannot return a partial issue list");
});

Deno.test("issue body admission: real REST scope and mixed matrix retain unsupported work without a grant", async (t) => {
  const ordinary = "a".repeat(16_383) + "z";
  const skipped = SKIP + "s".repeat(LARGE_LENGTH - SKIP.length);
  const oversized = "u".repeat(LARGE_LENGTH - 1) + "z";
  const rows: Record<string, unknown>[] = [
    issueWire({
      number: 11,
      title: "ordinary issue",
      body: ordinary,
      labels: [],
    }),
    issueWire({
      number: 12,
      title: "explicit manual task",
      body: skipped,
      labels: [],
    }),
    issueWire({
      number: 13,
      title: "unsupported full statement",
      body: oversized,
      labels: [{ name: "priority:9" }],
    }),
    { number: 14, pull_request: {} },
  ].map((row) => ({
    ...row,
    created_at: new Date(T0 - 10_000).toISOString(),
    updated_at: new Date(T0 - 10_000).toISOString(),
  }));
  const { port, transport } = makePort({
    repository: REPO,
    script: [
      {
        ...httpRespond(
          "GET",
          `${ISSUES}?state=open&per_page=100&page=1`,
          200,
          rows,
        ),
        repeat: true,
      },
      ...rows.slice(0, 3).map((row) => ({
        ...httpRespond("GET", `${ISSUES}/${row.number}`, 200, row),
        repeat: true,
      })),
    ],
  });
  const raw = await port.listOpenIssues();
  assert.ok(raw.ok, "one large body must not poison complete discovery");
  assert.deepEqual(raw.value.map((row) => row.number), [11, 12, 13]);
  assert.equal(raw.value[1].body, skipped);
  assert.equal(raw.value[2].body, oversized);
  const scoped = scopeLocalRepairIssues(port);
  const visible = await scoped.listOpenIssues();
  assert.ok(visible.ok);
  assert.deepEqual(visible.value.map((row) => row.number), [11, 13]);
  const manual = await scoped.readIssue(12);
  assert.ok(manual.ok);
  assert.equal(manual.value, null);
  const full = await scoped.readIssue(13);
  assert.ok(full.ok);
  assert.equal(full.value?.body, oversized);
  const rig = await makeRig("body-matrix", {
    summaries: false,
    externalImplementations: true,
  });
  try {
    rig.github.listOpenIssues = scoped.listOpenIssues.bind(scoped);
    rig.github.readIssue = scoped.readIssue.bind(scoped);
    const intake = await rig.run(1);
    assert.equal(intake.status, "margin", JSON.stringify(intake));
    const before = await rig.snapshot();
    assert.deepEqual(before.work.map((row) => row.related.issueNumber).sort(), [
      11,
      13,
    ]);
    assert.equal(before.reservations.length, 0);
    const original = before.work.find((row) => row.related.issueNumber === 13)!;
    const issueReads = () =>
      transport.requests.filter((request) =>
        request.url.endsWith(`${ISSUES}/13`)
      ).length;
    const readsBefore = issueReads();
    const configs = repairConfigs({
      sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
    });
    const report = await planMatrixWave({
      clock: rig.clock,
      state: rig.store,
      configs,
      controllerSha: SHA1,
      github: rig.github,
      githubCooldown: new DurableGitHubCooldownGate({
        clock: rig.clock,
        state: rig.store,
      }),
      incidents: rig.incidents,
      replay: rig.replay,
      model: rig.model,
      budget: new RollingStartBudget({
        clock: rig.clock,
        state: rig.store,
        configs,
      }),
    }, {
      waveId: "issue-body-bound",
      run: { runId: 41, runAttempt: 1, launcherSha: SHA1 },
      runtimeSha: SHA1,
      generation: 1,
      deadline: rig.clock.now() + 60 * 60_000,
      plannedAt: rig.clock.now(),
    });
    assert.equal(report.prepared, 1, JSON.stringify(report));
    assert.equal(report.deferred, 1);
    assert.equal(report.plan.cells.length, 1);
    assert.equal(report.plan.cells[0].request.issue?.number, 11);
    assert.equal(report.plan.cells[0].request.issue?.body, ordinary);
    const state = parseRepairStateSnapshotV1(
      JSON.parse(JSON.stringify(await rig.snapshot())),
    );
    const retained = state.work.find((row) => row.related.issueNumber === 13)!;
    assert.deepEqual(retained.source, original.source);
    assert.equal(retained.nextStep, "work");
    assert.deepEqual(retained.wait, {
      reason: "unavailable",
      since: rig.clock.now(),
      until: rig.clock.now() + ISSUE_PREREQUISITE_RETRY_MS,
    });
    assert.equal(retained.intent, null);
    assert.equal(retained.counters.attempts, 0);
    assert.equal(retained.counters.retries, 0);
    assert.equal(retained.counters.reviewRounds, 0);
    assert.equal(state.reservations.length, 1);
    assert.ok(
      state.reservations.every((charge) => charge.taskId !== retained.id),
    );
    assert.equal(
      rig.model.requests.length,
      0,
      "planning never invokes a model",
    );
    assert.equal(
      issueReads() - readsBefore,
      1,
      "the validator reuses the already-read issue",
    );
    assert.deepEqual(
      parseMatrixPlanV1(JSON.parse(JSON.stringify(report.plan))),
      report.plan,
    );
    await t.step({
      name: "frozen R80 parsers accept emitted state and plan",
      ignore: !await r80Available(),
      fn: async () => {
        await withR80Parsers((parsers) => {
          assert.deepEqual(parsers.parseRepairStateSnapshotV1(state), state);
          assert.deepEqual(parsers.parseMatrixPlanV1(report.plan), report.plan);
        });
      },
    });
  } finally {
    await rig.ctx.cleanup();
  }
});
