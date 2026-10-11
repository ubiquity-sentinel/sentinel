import assert from "node:assert/strict";
import { readLocalRunStatus } from "../../src/host/local-release.ts";
import { SHA1 } from "../state/helpers.ts";
import {
  assertUnavailable,
  blockedWork,
  chargedReservation,
  chargedReservations,
  detail,
  extendedRepairSnapshot,
  FileStatusState,
  FINISHED,
  HOUR,
  makeRoot,
  pathExists,
  produce,
  produceSnapshot,
  repairSnapshot,
  reservationAggregates,
  STARTED,
  StatusState,
  work,
  workAggregates,
} from "./local-status-helpers.ts";
import {
  expectRecorded,
  expectRejected,
  mutated,
} from "./local-status-renderer-helpers.ts";

// ---------------------------------------------------------------------------
// Producer: maximum text bounds and escaping
// ---------------------------------------------------------------------------

Deno.test("status producer: max-length IDs, Unicode login and escaping round-trip", async () => {
  const root = await makeRoot("sentinel-local-text-");
  try {
    const maxId = `w${"a".repeat(255)}`;
    const maxReservationId = `r${"b".repeat(255)}`;
    const longTaskId = "t".repeat(256);
    const login = 'ø"\\中';
    const produced = await produceSnapshot(
      repairSnapshot(
        [blockedWork(maxId, 1_000_000_000_000), blockedWork("blk-1", 42)],
        [chargedReservation(maxReservationId, FINISHED - 1000, {
          taskId: longTaskId,
        })],
      ),
      root,
      { login },
    );
    assert.equal(produced.status.login, login);
    assert.equal(
      detail(produced.status, "work").map((entry) => entry.id).length,
      2,
    );
    assert.equal(detail(produced.status, "reservations")[0].taskId, longTaskId);
    assert.ok(produced.fileText.includes('\\"'), "quotes are JSON-escaped");
    assert.ok(
      produced.fileText.includes("\\u00f8") || produced.fileText.includes("ø"),
    );
    // The renderer only displays bounded numeric issue IDs: a huge id is not shown.
    const rendered = await expectRecorded(
      produced.fileText,
      "RED",
      "blocked work is present",
    );
    assert.ok(!rendered.summary.includes("#1000000000000"));
    assert.ok(rendered.summary.includes("without a bounded numeric issue id"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Producer: no state mutation, retained receipt compatibility
// ---------------------------------------------------------------------------

Deno.test("status producer: reporting leaves the complete snapshot unchanged", async () => {
  const root = await makeRoot("sentinel-local-preserve-");
  try {
    const snapshot = repairSnapshot(
      [blockedWork("blk-1", 7), work("w-1")],
      [chargedReservation("r-1", FINISHED - 1000)],
    );
    const before = JSON.stringify(snapshot);
    const state = new StatusState(snapshot);
    await produce(state, root);
    assert.equal(state.writes, 0, "reporting never writes repair state");
    assert.equal(state.reads, 1);
    assert.equal(
      JSON.stringify(snapshot),
      before,
      "snapshot bytes are unchanged",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("status producer: serialized state fixture is parsed, rendered and preserved", async () => {
  const root = await makeRoot("sentinel-local-statefile-");
  try {
    const path = `${root}/repair-state.json`;
    const snapshot = repairSnapshot(
      [blockedWork("blk-1", 11), work("w-1", "work", 12)],
      [
        chargedReservation("r-1", FINISHED - 1000),
        chargedReservation("r-2", FINISHED - 2000, {
          outcome: "submitted",
          settledAt: FINISHED - 1500,
        }),
      ],
    );
    await Deno.writeTextFile(path, JSON.stringify(snapshot, null, 2) + "\n");
    const stateBefore = await Deno.readFile(path);
    const state = new FileStatusState(path);
    const produced = await produce(state, root, {
      outcome: { status: "state_error", detail: "fixture failure detail" },
    });
    assert.equal(state.reads, 1, "the producer reads the serialized fixture");
    assert.equal(state.writes, 0, "reporting never writes repair state");
    assert.equal(workAggregates(produced.status).total, 2);
    const statusBeforeRender = await Deno.readFile(`${root}/status.json`);

    const available = await readLocalRunStatus(root);
    assert.ok(available.ok, "the produced envelope parses");
    if (!available.ok) throw new Error("unreachable");
    assert.ok(available.value !== null);
    if (available.value === null) throw new Error("unreachable");
    assert.equal(available.value.outcome, "state_error");
    assert.equal(available.value.stateAvailable, true);

    const rendered = await expectRecorded(
      produced.fileText,
      "RED",
      "blocked work is present",
    );
    assert.ok(!rendered.summary.includes("NOT RECORDED"), rendered.summary);

    // The RED report is diagnostic: it rewrites neither the parsed state
    // fixture nor the original status receipt, and it leaves no local
    // supervisor rollback or pointer artifact behind.
    assert.deepEqual(
      await Deno.readFile(path),
      stateBefore,
      "the serialized state fixture bytes are unchanged",
    );
    assert.deepEqual(
      await Deno.readFile(`${root}/status.json`),
      statusBeforeRender,
      "the status receipt bytes are unchanged by rendering",
    );
    const reread = await readLocalRunStatus(root);
    assert.ok(reread.ok);
    if (!reread.ok) throw new Error("unreachable");
    assert.ok(reread.value !== null);
    assert.equal(
      reread.value!.outcome,
      "state_error",
      "the original outcome stays original",
    );
    assert.equal(reread.value!.stateAvailable, true);
    assert.equal(await pathExists(`${root}/local-releases`), false);
    assert.equal(await pathExists(`${root}/active-runtime.json`), false);
    assert.equal(await pathExists(`${root}/supervisor.lock`), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("status producer: retained local receipt consumer reads the v1 envelope", async () => {
  const root = await makeRoot("sentinel-local-receipt-");
  try {
    const produced = await produceSnapshot(
      repairSnapshot([work("w-1")], [
        chargedReservation("r-1", FINISHED - 1000),
      ]),
      root,
    );
    const available = await readLocalRunStatus(root);
    assert.ok(available.ok, "the produced envelope parses");
    if (!available.ok) throw new Error("unreachable");
    const value = available.value;
    assert.ok(value !== null);
    if (value === null) throw new Error("unreachable");
    assert.equal(value.invocationId, "invocation-0001");
    assert.equal(value.controllerSha, SHA1);
    assert.equal(value.startedAt, STARTED);
    assert.equal(value.finishedAt, FINISHED);
    assert.equal(value.outcome, "idle");
    assert.equal(value.stateAvailable, true);
    assert.equal(produced.status.state, undefined);

    const unavailable = await produce(new StatusState(null, true), root);
    assertUnavailable(unavailable);
    const missingState = await readLocalRunStatus(root);
    assert.ok(missingState.ok);
    if (!missingState.ok) throw new Error("unreachable");
    assert.ok(missingState.value !== null);
    assert.equal(missingState.value!.stateAvailable, false);

    await Deno.writeTextFile(`${root}/status.json`, "{not json\n");
    const corrupt = await readLocalRunStatus(root);
    assert.equal(
      corrupt.ok,
      false,
      "a corrupt status is unavailable, not empty",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Embedded renderer: real producer output end to end
// ---------------------------------------------------------------------------

Deno.test("embedded renderer: real producer output renders complete and RED reports", async () => {
  const root = await makeRoot("sentinel-local-render-compose-");
  try {
    const complete = await produceSnapshot(
      repairSnapshot([work("w-1", "work", 1)]),
      root,
    );
    const completeRendered = await expectRecorded(
      complete.fileText,
      "GREEN",
      "Local state: available",
    );
    assert.ok(
      completeRendered.summary.includes(
        "Admission limits: uncapped (no rolling hourly or weekly model-start cap)",
      ),
      completeRendered.summary,
    );
    assert.ok(
      completeRendered.summary.includes(
        "Rolling usage: 0 charged in the last hour; 0 charged in the last seven days (historical usage, no admission caps)",
      ),
      completeRendered.summary,
    );
    assert.ok(
      !completeRendered.summary.includes("of null"),
      completeRendered.summary,
    );
    await expectRecorded(
      complete.fileText,
      "GREEN",
      "Rolling usage: 0 charged in the last hour",
    );
    await expectRecorded(complete.fileText, "GREEN", "Report detail: complete");

    const unavailable = await produce(new StatusState(null, true), root);
    await expectRecorded(
      unavailable.fileText,
      "RED",
      "the local status is unavailable",
    );

    const blocked = await produceSnapshot(
      repairSnapshot(
        [blockedWork("blk-1", 9)],
        chargedReservations("r-cap", 120, FINISHED - 1000),
      ),
      root,
    );
    assert.equal(blocked.status.nextEligibleStartAt, null);
    const rendered = await expectRecorded(
      blocked.fileText,
      "RED",
      "blocked work is present",
    );
    assert.ok(
      rendered.summary.includes("Rolling usage: 120 charged in the last hour"),
    );
    assert.ok(
      rendered.summary.includes(
        "Next eligible local start (UTC): none recorded (admission is uncapped)",
      ),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("embedded renderer: uncapped producer report renders the actual rolling values", async () => {
  const root = await makeRoot("sentinel-local-render-uncapped-");
  try {
    const produced = await produceSnapshot(
      repairSnapshot(
        [work("w-1", "work", 1)],
        [
          ...chargedReservations("uncapped-hour", 120, FINISHED - 1000),
          ...chargedReservations("uncapped-week", 60, FINISHED - 2 * HOUR),
        ],
      ),
      root,
    );
    // The real producer's actual policy and actual rolling aggregates.
    assert.deepEqual(produced.status.limits, {
      perHour: null,
      perSevenDays: null,
    });
    assert.equal(produced.status.nextEligibleStartAt, null);
    const R = reservationAggregates(produced.status);
    assert.equal(R.chargedHour, 120);
    assert.equal(R.chargedSevenDays, 180);

    const rendered = await expectRecorded(
      produced.fileText,
      "GREEN",
      "Admission limits: uncapped (no rolling hourly or weekly model-start cap)",
    );
    // Value acceptance: the rendered usage is built from the report's own
    // aggregate values, not from a fixed expected string.
    assert.ok(
      rendered.summary.includes(
        `Rolling usage: ${R.chargedHour} charged in the last hour; ${R.chargedSevenDays} charged in the last seven days (historical usage, no admission caps)`,
      ),
      rendered.summary,
    );
    assert.ok(
      rendered.summary.includes(
        "Next eligible local start (UTC): none recorded (admission is uncapped)",
      ),
      rendered.summary,
    );
    assert.ok(!rendered.summary.includes("of null"), rendered.summary);

    // Future malformed policy still refuses to render: numeric hourly, numeric
    // weekly and unknown extra keys are all rejected.
    await expectRejected(
      mutated(produced, (status) => {
        (status.limits as Record<string, unknown>).perHour = 1;
      }),
      "admission limits",
    );
    await expectRejected(
      mutated(produced, (status) => {
        (status.limits as Record<string, unknown>).perSevenDays = 0;
      }),
      "admission limits",
    );
    await expectRejected(
      mutated(produced, (status) => {
        (status.limits as Record<string, unknown>).extra = null;
      }),
      "admission limits",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("embedded renderer: approved reserve model survives the runtime launcher boundary", async () => {
  const root = await makeRoot("sentinel-local-render-reserve-");
  try {
    // The real producer is called with the actual owner-approved runtime
    // route; its produced bytes are fed to the renderer unchanged.
    const produced = await produceSnapshot(
      repairSnapshot(
        [work("w-1", "work", 1)],
        [
          ...chargedReservations("reserve-hour", 120, FINISHED - 1000),
          ...chargedReservations("reserve-week", 60, FINISHED - 2 * HOUR),
        ],
      ),
      root,
      { modelId: "gpt-reserve" },
    );
    // The producer reports the actual configured model, not a display label.
    assert.equal(produced.status.model, "gpt-reserve");
    assert.equal(produced.status.reasoning, "max");
    assert.deepEqual(produced.status.limits, {
      perHour: null,
      perSevenDays: null,
    });
    const R = reservationAggregates(produced.status);
    assert.equal(R.chargedHour, 120);
    assert.equal(R.chargedSevenDays, 180);

    // The unchanged produced bytes must render truthfully: the approved model
    // and its actual uncapped usage, with no substitute label.
    const rendered = await expectRecorded(
      produced.fileText,
      "GREEN",
      "Implementation model: gpt-reserve with max reasoning",
    );
    assert.ok(
      rendered.summary.includes(
        `Rolling usage: ${R.chargedHour} charged in the last hour; ${R.chargedSevenDays} charged in the last seven days (historical usage, no admission caps)`,
      ),
      rendered.summary,
    );
    assert.ok(
      rendered.summary.includes(
        "Next eligible local start (UTC): none recorded (admission is uncapped)",
      ),
      rendered.summary,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("embedded renderer: large lifetime history renders unchanged", async () => {
  const root = await makeRoot("sentinel-local-render-large-");
  try {
    const reservations = Array.from(
      { length: 10_000 },
      (_value, index) =>
        chargedReservation(
          `res-${String(index).padStart(5, "0")}`,
          FINISHED - 21 * 24 * 3_600_000 + index,
        ),
    );
    const produced = await produceSnapshot(
      extendedRepairSnapshot([work("w-1")], reservations),
      root,
    );
    await expectRecorded(
      produced.fileText,
      "GREEN",
      "Report detail: truncated",
    );
    await expectRecorded(produced.fileText, "GREEN", "10000 total");

    const withBlocked = await produceSnapshot(
      extendedRepairSnapshot([blockedWork("blk-1", 3)], reservations),
      root,
    );
    const rendered = await expectRecorded(
      withBlocked.fileText,
      "RED",
      "blocked work is present",
    );
    assert.ok(!rendered.summary.includes("NOT RECORDED"));
    assert.ok(rendered.summary.includes("10000 total"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
