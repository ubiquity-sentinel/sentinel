/** Base-bound bundles, disabled hooks and sanitized model errors. */
import assert from "node:assert/strict";
import {
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
} from "@zip.js/zip.js";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { matrixDigestV1 } from "../../src/contracts/matrix.ts";
import type {
  ImplementationPort,
  ModelRunReceiptV1,
} from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import {
  ingestMatrixResults,
  planMatrixWave,
  runMatrixCell,
  runMatrixCellEntrypoint,
} from "../../src/host/matrix.ts";
import { writeLocalModelResult } from "../../src/host/local.ts";
import { gitRun, T0 } from "../state/helpers.ts";
import {
  ACTUAL,
  freshIssue,
  makeRig,
  PROVIDER,
  RUN,
  seedSnapshot,
  snapshot,
  WAVE,
} from "./matrix-runtime-fixtures.ts";

Deno.test("matrix runtime: delta bundle requires its base and ignores model-controlled Git hooks", async () => {
  const rig = await makeRig([501], 1);
  try {
    const written = await rig.store.writeRepair(
      seedSnapshot([freshIssue(501, rig.base)]),
      null,
    );
    assert.ok(written.ok && written.value.status === "applied");
    const planned = await planMatrixWave(rig.deps, rig.planOptions());
    const cell = planned.plan.cells[0]!;
    const ctx = await rig.claimCell(cell);
    const hooks = ctx.bundlesDir + "/hooks";
    const marker = ctx.bundlesDir + "/hook-ran";
    await Deno.mkdir(hooks);
    await Deno.writeTextFile(
      hooks + "/reference-transaction",
      '#!/bin/sh\nprintf hook > "' + marker + '"\nexit 1\n',
      { mode: 0o700 },
    );
    const exporter = ctx.deps.bundle;
    ctx.deps.bundle = {
      create: async (request) => {
        assert.ok(
          (await gitRun(
            ctx.repositoryDir,
            ["config", "core.hooksPath", hooks],
            rig.env,
          )).ok,
        );
        return exporter.create(request);
      },
    };
    const result = await runMatrixCell(
      ctx.deps,
      { waveId: WAVE, run: RUN, cell },
      ACTUAL,
      T0,
    );
    assert.equal(result.status, "completed");
    assert.ok(result.bundle);
    const bytes = await Deno.readFile(
      ctx.bundlesDir + "/" + result.bundle.file,
    );
    const header = new TextDecoder().decode(bytes.slice(0, 4096)).split(
      "\n\n",
    )[0]!;
    assert.ok(
      header.split("\n").some((line) => line.startsWith("-" + rig.base + " ")),
      "planned base is an external prerequisite, not bundled history",
    );
    await assert.rejects(Deno.stat(marker), Deno.errors.NotFound);
    await rig.transfer([result], [ctx]);
    assert.ok(
      (await gitRun(
        rig.mirrorRepo,
        ["config", "core.hooksPath", hooks],
        rig.env,
      )).ok,
    );
    const report = await ingestMatrixResults(
      rig.deps,
      planned.plan,
      [result],
      rig.ingestOptions(),
    );
    assert.equal(report.ingested, 1);
    assert.equal(await rig.objectPresent(result.bundle.head), true);
    await assert.rejects(Deno.stat(marker), Deno.errors.NotFound);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("matrix runtime: private model error stays out of exported JSON logs and uploaded artifact bytes", async () => {
  const rig = await makeRig([601], 1);
  const sentinel = "PRIVATE_MODEL_ERROR_SENTINEL_601";
  const logs: string[] = [];
  const originalLog = console.log;
  try {
    const seeded = await rig.store.writeRepair(
      seedSnapshot([freshIssue(601, rig.base)]),
      null,
    );
    assert.ok(seeded.ok && seeded.value.status === "applied");
    const planned = await planMatrixWave(rig.deps, rig.planOptions());
    const cell = planned.plan.cells[0]!;
    const ctx = await rig.claimCell(cell);
    const privateRoot = rig.tmp + "/private-model-evidence";
    await Deno.mkdir(privateRoot, { mode: 0o700 });
    const privateWire = privateRoot + "/session-wire.json";
    const privateReceipt: ModelRunReceiptV1 = {
      invocationId: "failed-private-invocation",
      outcome: "failed",
      actual: {
        evidenceKind: "request-runtime",
        provider: PROVIDER,
        threadId: "private-thread",
        turnId: "private-turn",
        terminalOrigin: "runtime",
        observedTerminalStatus: "failed",
        observedModel: "gpt-reserve",
        observedReasoning: "max",
        durationMs: 10,
        outputChars: 10,
      },
      candidate: null,
      error: sentinel,
    };
    const model: ImplementationPort = {
      modelId: "gpt-reserve",
      runModel: async (request) => {
        // The fake external model keeps its original wire evidence privately,
        // then runs the production private diagnostic writer before cell export.
        await Deno.writeTextFile(privateWire, JSON.stringify(privateReceipt), {
          mode: 0o600,
        });
        await writeLocalModelResult(
          privateRoot,
          request,
          portOk(privateReceipt),
          T0,
        );
        return portOk(privateReceipt);
      },
    };
    const publicRoot = rig.tmp + "/.sentinel-matrix";
    await Deno.mkdir(publicRoot);
    const cellPath = publicRoot + "/cell.json",
      resultPath = publicRoot + "/result.json";
    await Deno.writeTextFile(
      cellPath,
      JSON.stringify({ waveId: WAVE, run: RUN, cell }),
    );
    console.log = (...values) => {
      logs.push(values.map(String).join(" "));
    };
    const result = await runMatrixCellEntrypoint({
      deps: { ...ctx.deps, model },
      actual: ACTUAL,
      cellPath,
      resultPath,
      completedAt: T0,
    });
    console.log = originalLog;
    const jsonBytes = await Deno.readFile(resultPath);
    // This is the same public result.json selected by upload-artifact. Package
    // those actual exported bytes, then send the archive across a fake HTTP
    // upload boundary; storage mode makes byte-level absence meaningful.
    const writer = new ZipWriter(new Uint8ArrayWriter(), {
      useWebWorkers: false,
    });
    await writer.add("result.json", new Uint8ArrayReader(jsonBytes), {
      level: 0,
      unixMode: 0o100600,
    });
    const archive = await writer.close();
    let uploaded: Uint8Array | null = null;
    const fakeUpload = async (request: Request) => {
      uploaded = new Uint8Array(await request.arrayBuffer());
      return new Response(null, { status: 201 });
    };
    const response = await fakeUpload(
      new Request("https://artifact-upload.invalid/cell", {
        method: "POST",
        body: archive.slice(),
      }),
    );
    assert.equal(response.status, 201);
    assert.deepEqual(uploaded, archive);
    const reader = new ZipReader(new Uint8ArrayReader(archive), {
      useWebWorkers: false,
    });
    const entries = await reader.getEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.filename, "result.json");
    const entry = entries[0]!;
    assert.equal(entry.directory, false);
    if (entry.directory) throw Error("expected a result file");
    const packedJson = await entry.getData!(new Uint8ArrayWriter());
    await reader.close();
    assert.deepEqual(packedJson, jsonBytes);
    assert.ok((await Deno.readTextFile(privateWire)).includes(sentinel));
    assert.equal((await Deno.stat(privateWire)).mode! & 0o077, 0);
    assert.equal(
      privateReceipt.error,
      sentinel,
      "public projection never rewrites private evidence",
    );
    assert.equal(
      new TextDecoder().decode(jsonBytes).includes(sentinel),
      false,
      "exported JSON leaks no private error",
    );
    assert.equal(
      new TextDecoder().decode(archive).includes(sentinel),
      false,
      "uploaded artifact bytes leak no private error",
    );
    assert.ok(
      logs.length > 0,
      "actual private diagnostic emitted its safe log projection",
    );
    assert.equal(logs.join("\n").includes(sentinel), false);
    assert.equal(result.status, "completed", "wrapper status is preserved");
    assert.equal(result.receipt?.outcome, "failed");
    assert.equal(result.receipt?.error, "runtime_error");
    assert.equal(result.reservationId, cell.reservationId);
    assert.equal(
      await matrixDigestV1(JSON.parse(new TextDecoder().decode(jsonBytes))),
      await matrixDigestV1(result),
    );
    assert.equal(
      canonicalStringify(result).includes(sentinel),
      false,
      "production canonical payload is sanitized too",
    );
    for (
      const [outcome, error, expected] of [
        ["interrupted", sentinel, "runtime_error"],
        ["failed", null, null],
        ["failed", "failed_command_loop", "failed_command_loop"],
      ] as const
    ) {
      const original: ModelRunReceiptV1 = {
        ...privateReceipt,
        outcome,
        error,
        actual: { ...privateReceipt.actual, observedTerminalStatus: outcome },
      };
      const projected = await runMatrixCellEntrypoint({
        deps: {
          ...ctx.deps,
          model: {
            modelId: "gpt-reserve",
            runModel: () => Promise.resolve(portOk(original)),
          },
        },
        actual: ACTUAL,
        cellPath,
        resultPath,
        completedAt: T0,
      });
      assert.deepEqual(projected.receipt, { ...original, error: expected });
      assert.equal(original.error, error, "private receipt remains unchanged");
      assert.equal(
        (await Deno.readTextFile(resultPath)).includes(sentinel),
        false,
      );
    }
    const before = await snapshot(rig);
    const ingested = await ingestMatrixResults(
      rig.deps,
      planned.plan,
      [result],
      rig.ingestOptions(),
    );
    assert.equal(ingested.ingested, 1);
    const after = await snapshot(rig);
    assert.equal(after.reservations.length, before.reservations.length);
    assert.equal(after.reservations[0]!.id, cell.reservationId);
    assert.equal(
      after.reservations[0]!.outcome,
      "ambiguous",
      "failed execution stays charged",
    );
    assert.equal(after.work[0]!.nextStep, "blocked");
  } finally {
    console.log = originalLog;
    await rig.cleanup();
  }
});
