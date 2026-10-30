import assert from "node:assert/strict";
import { join } from "node:path";
import { apiPath, syncArchive } from "../../ops/telemetry-collect.ts";
import { importCapture } from "../../ops/telemetry-import.ts";
import { makeReport } from "../../ops/telemetry-report.ts";
import { Archive } from "../../ops/telemetry-store.ts";
import {
  type Api,
  CONTROLLER,
  digest,
  encoder,
  iso,
  POINTER_PATH,
  TARGETS,
} from "../../ops/telemetry-types.ts";

const T = Date.parse("2026-10-29T20:00:00Z");
const runtime = "b".repeat(40);
const prior = "a".repeat(40);
const launcher = "c".repeat(40);
const base = `repos/${CONTROLLER}`;
const opts = {
  since: T - 1000,
  cutoff: T + 10000,
  maxReads: 80,
  deadlineMs: 20000,
};
function execution(
  runId = 10,
  attempt = 1,
  revision = runtime,
  generation = 11,
  purpose = "ordinary",
  createdAt = T + 2000,
) {
  return {
    id: `${runId}:${attempt}:repair`,
    runId,
    runAttempt: attempt,
    revision,
    launcherSha: launcher,
    generation,
    purpose,
    createdAt,
  };
}
function proof(
  e = execution(),
  logDigest = "f".repeat(64),
  outcome = "healthy",
  jobId = 101,
) {
  return {
    execution: e,
    logDigest,
    outcome,
    jobId,
    repository: CONTROLLER,
    workflowPath: ".github/workflows/supervisor.yml",
    ref: "refs/heads/sentinel-supervisor",
    settled: true,
    startupReady: true,
    finishedAt: T + 4000,
  };
}
function bytes(value: unknown) {
  return encoder.encode(JSON.stringify(value));
}
async function gitBlob(value: unknown) {
  const raw = bytes(value);
  const header = encoder.encode(`blob ${raw.length}\0`);
  const full = new Uint8Array(header.length + raw.length);
  full.set(header);
  full.set(raw, header.length);
  const sha = await digest(full, "SHA-1");
  return {
    sha,
    body: bytes({
      sha,
      encoding: "base64",
      content: btoa(new TextDecoder().decode(raw)),
    }),
  };
}

async function fixture(attempt = 1, outcome = "healthy", mismatch = false) {
  const e = execution(10, attempt);
  const terminal = {
    version: "v1",
    kind: "hosted_runtime_terminal",
    execution: e,
    controllerSha: runtime,
    startedAt: T + 2100,
    finishedAt: T + 4000,
    outcome,
    startupReady: true,
    settled: true,
  };
  const summary = {
    version: "v1",
    kind: "hosted_runtime_summary",
    runId: 10,
    attempt,
    launcherSha: launcher,
    runtimeSha: mismatch ? prior : runtime,
    generation: 11,
    purpose: "ordinary",
    admittedWorkCount: 0,
    prsTouched: [],
    outcome,
  };
  const log = encoder.encode(
    `2026-10-29T20:00:04Z ${JSON.stringify(terminal)}\n2026-10-29T20:00:04Z ${
      JSON.stringify(summary)
    }\n`,
  );
  const p = proof(e, await digest(log), outcome, attempt === 1 ? 101 : 102);
  const bootstrap = proof(
    execution(9, 1, runtime, 11, "bootstrap", T),
    "e".repeat(64),
    "healthy",
    99,
  );
  const journal = {
    kind: "hosted_installation",
    id: `installation:${runtime}`,
    candidateRevision: runtime,
    previousRevision: prior,
    previousGeneration: 10,
    phase: "accepted",
    createdAt: T - 100,
    updatedAt: T + 1000,
    bootstrapExecutionId: bootstrap.execution.id,
    bootstrapProof: bootstrap,
    previousHealthyProof: null,
    rollbackProof: null,
  };
  const pointer = {
    kind: "hosted_runtime",
    id: `${CONTROLLER}:0:production`,
    activeRevision: runtime,
    generation: 11,
    updatedAt: T + 5000,
    lastHealthyProof: outcome === "healthy" ? p : null,
    lastExecutionProof: p,
  };
  const artifacts = new Map<string, Uint8Array>();
  const entries = [];
  for (
    const [path, value] of [[POINTER_PATH, pointer], [
      `hostedInstallations/${await digest(
        encoder.encode(`installation:${runtime}`),
      )}.json`,
      journal,
    ]] as const
  ) {
    const blob = await gitBlob(value);
    entries.push({ path, sha: blob.sha, type: "blob" });
    artifacts.set(`${base}/git/blobs/${blob.sha}`, blob.body);
  }
  const head = "1".repeat(40);
  artifacts.set(
    `${base}/git/ref/heads/sentinel-state/release`,
    bytes({ object: { sha: head } }),
  );
  artifacts.set(
    apiPath(`${base}/git/trees/${head}`, { recursive: 1 }),
    bytes({ tree: entries, truncated: false }),
  );
  const run = {
    id: 10,
    run_attempt: attempt,
    status: "completed",
    conclusion: outcome === "healthy" ? "success" : "failure",
    head_sha: launcher,
    created_at: iso(T + 2000),
    updated_at: iso(T + 4500),
  };
  artifacts.set(
    apiPath(`${base}/actions/workflows/supervisor.yml/runs`, {
      per_page: 100,
      page: 1,
      created: `${iso(opts.since)}..${iso(opts.cutoff)}`,
    }),
    bytes({ total_count: 1, workflow_runs: [run] }),
  );
  for (let a = 1; a <= attempt; a++) {
    artifacts.set(
      `${base}/actions/runs/10/attempts/${a}`,
      bytes({
        ...run,
        run_attempt: a,
        conclusion: a < attempt ? "failure" : run.conclusion,
      }),
    );
    artifacts.set(
      apiPath(`${base}/actions/runs/10/attempts/${a}/jobs`, { per_page: 100 }),
      bytes({
        total_count: 1,
        jobs: [{
          id: a === 1 ? 101 : 102,
          name: "repair",
          run_id: 10,
          run_attempt: a,
          head_sha: launcher,
          status: "completed",
          conclusion: a < attempt || outcome !== "healthy"
            ? "failure"
            : "success",
          started_at: iso(T + 2100),
          completed_at: iso(T + 4000),
        }],
      }),
    );
  }
  artifacts.set(`${base}/actions/jobs/${attempt === 1 ? 101 : 102}/logs`, log);
  for (const repository of TARGETS) {
    artifacts.set(
      apiPath(`repos/${repository}/pulls`, {
        state: "closed",
        sort: "updated",
        direction: "desc",
        per_page: 100,
        page: 1,
      }),
      bytes([]),
    );
  }
  const calls: string[] = [];
  const api: Api = (path) => {
    calls.push(path);
    const body = artifacts.get(path);
    return Promise.resolve(
      body ? { status: 200, body } : { status: 404, body: new Uint8Array() },
    );
  };
  return { artifacts, api, calls, journal, pointer };
}

async function withArchive(
  fn: (archive: Archive, directory: string) => Promise<void>,
) {
  const directory = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: ".telemetry-test-",
  });
  const archive = new Archive(join(directory, "archive"));
  await archive.open();
  try {
    await fn(archive, directory);
  } finally {
    await archive.close();
    await Deno.remove(directory, { recursive: true });
  }
}

Deno.test("telemetry sync archives real consumers and offline report keeps runtime distinct from launcher", async () => {
  await withArchive(async (archive) => {
    const f = await fixture();
    const coverage = await syncArchive(archive, opts, f.api);
    assert.equal(coverage.runsComplete, true);
    const first = await makeReport(archive, opts.since, opts.cutoff);
    const v = first.report.versions.find((v) => v.runtimeSha === runtime)!;
    assert.equal(v.ordinary.healthy, 1);
    assert.equal(v.ordinary.nativeLogCovered, 1);
    assert.equal(v.ordinary.idle, 1);
    assert.equal(v.velocity.newAcceptedAutonomousMerges, 0);
    assert.equal(v.velocity.acceptedDeliveryCount, null);
    assert.equal(v.otherPurposes.bootstrap, 1);
    assert.equal(first.report.current?.rollbackPrior?.revision, prior);
    assert.equal(
      first.report.versions.some((v) => v.runtimeSha === launcher),
      false,
    );
    const before = f.calls.length;
    const offline = await makeReport(archive, opts.since, opts.cutoff);
    assert.equal(f.calls.length, before);
    assert.equal(offline.report.versions[0].ordinary.healthy, 1);
    assert.equal(
      JSON.parse(await Deno.readTextFile(join(archive.root, "latest.json")))
        .schema,
      "sentinel_local_telemetry_v1",
    );
    f.calls.length = 0;
    await syncArchive(archive, opts, f.api);
    assert.equal(
      f.calls.some((p) => /\/actions\/jobs\/\d+\/logs$/.test(p)),
      false,
    );
    assert.equal(
      (await makeReport(archive, opts.since, opts.cutoff)).report.versions.find(
        (v) => v.runtimeSha === runtime,
      )?.runCount,
      2,
    );
  });
});

Deno.test("telemetry failed attempt one then success two retains both and deduplicates merged observations", async () => {
  await withArchive(async (archive) => {
    const first = await fixture(1, "failed");
    await syncArchive(archive, opts, first.api);
    const second = await fixture(2);
    const pull = {
      number: 2,
      merged_at: iso(T + 3000),
      updated_at: iso(T + 3000),
      merge_commit_sha: "d".repeat(40),
      merged_by: { type: "User", login: "owner" },
    };
    second.artifacts.set(
      apiPath(`repos/${CONTROLLER}/pulls`, {
        state: "closed",
        sort: "updated",
        direction: "desc",
        per_page: 100,
        page: 1,
      }),
      bytes([pull, pull]),
    );
    second.artifacts.set(`repos/${CONTROLLER}/pulls/2`, bytes(pull));
    await syncArchive(archive, opts, second.api);
    const report = (await makeReport(archive, opts.since, opts.cutoff)).report;
    const v = report.versions.find((v) => v.runtimeSha === runtime)!;
    assert.equal(v.ordinary.healthy, 1);
    assert.equal(v.ordinary.failed, 1);
    assert.deepEqual(
      v.attempts.filter((a) => a.runId === 10).map((a) => a.attempt).sort(),
      [1, 2],
    );
    assert.equal(v.velocity.observedMerges, 1);
    assert.equal(v.velocity.ownerManualMerges, 1);
    assert.equal(report.workflowOutcomes.attempts, 3);
  });
});

Deno.test("telemetry expired log response cannot erase archived native health; interrupted index is recoverable", async () => {
  await withArchive(async (archive) => {
    const f = await fixture();
    await syncArchive(archive, opts, f.api);
    await archive.record({
      endpoint: `${base}/actions/jobs/101/logs`,
      observedAt: new Date().toISOString(),
      status: 410,
      error: "HTTP 410: unavailable or expired",
      transport: "gh",
    }, null);
    await Deno.writeTextFile(
      join(archive.root, "index.json"),
      "interrupted index",
    );
    await Deno.writeTextFile(
      join(archive.root, "observations", "partial.tmp"),
      "incomplete",
    );
    const result = await makeReport(archive, opts.since, opts.cutoff);
    assert.equal(
      result.report.versions.find((v) => v.runtimeSha === runtime)?.ordinary
        .nativeLogCovered,
      1,
    );
    assert.ok(
      result.report.coverage.errors.some((e) =>
        e.endpoint === `${base}/actions/jobs/101/logs` && e.status === 410
      ),
    );
    assert.ok(
      JSON.parse(await Deno.readTextFile(join(archive.root, "index.json")))
        .observations.length,
    );
  });
});

Deno.test("telemetry partial API failure saves resumable coverage and refuses mismatched native proof", async () => {
  await withArchive(async (archive) => {
    const f = await fixture(1, "healthy", true);
    const limited = await syncArchive(archive, { ...opts, maxReads: 2 }, f.api);
    assert.equal(limited.stopped, "read_budget");
    assert.equal(limited.runsComplete, false);
    await syncArchive(archive, opts, f.api);
    const result = await makeReport(archive, opts.since, opts.cutoff);
    assert.equal(
      result.report.versions.find((v) => v.runtimeSha === runtime)?.ordinary
        .nativeLogCovered,
      0,
    );
    assert.ok(result.report.coverage.nativeRefusals.length);
    assert.equal(result.report.coverage.sessions.length, 2);
  });
});

Deno.test("telemetry App merger is unknown rather than autonomous or manual", async () => {
  await withArchive(async (archive) => {
    const f = await fixture();
    const pull = {
      number: 2,
      merged_at: iso(T + 3000),
      updated_at: iso(T + 3000),
      merge_commit_sha: "d".repeat(40),
      merged_by: { type: "Bot", login: "official-app[bot]" },
    };
    f.artifacts.set(
      apiPath(`repos/${CONTROLLER}/pulls`, {
        state: "closed",
        sort: "updated",
        direction: "desc",
        per_page: 100,
        page: 1,
      }),
      bytes([pull]),
    );
    f.artifacts.set(`repos/${CONTROLLER}/pulls/2`, bytes(pull));
    await syncArchive(archive, opts, f.api);
    const v = (await makeReport(archive, opts.since, opts.cutoff)).report
      .versions.find((v) => v.runtimeSha === runtime)!;
    assert.equal(v.velocity.ownerManualMerges, 0);
    assert.equal(v.velocity.unclassifiedMerges, 1);
    assert.equal(v.velocity.newAcceptedAutonomousMerges, null);
  });
});

Deno.test("telemetry archive lock is exclusive and corruption fails without deleting bytes", async () => {
  await withArchive(async (archive) => {
    const second = new Archive(archive.root);
    await assert.rejects(() => second.open(), /Archive locked/);
    const f = await fixture();
    await syncArchive(archive, opts, f.api);
    const row = (await archive.evidence()).find((r) => r.observation.blob)!;
    const path = join(archive.root, "blobs", row.observation.blob!);
    await Deno.writeTextFile(path, "damaged");
    await assert.rejects(
      () => makeReport(archive, opts.since, opts.cutoff),
      /Corrupt blob/,
    );
    assert.equal(await Deno.readTextFile(path), "damaged");
  });
});

Deno.test("telemetry import validates original captured bytes, is idempotent and rejects credentials", async () => {
  await withArchive(async (archive, directory) => {
    const f = await fixture();
    const seed = join(directory, "seed");
    await Deno.mkdir(seed);
    const entries = [];
    const commands = [];
    let index = 0;
    for (const [endpoint, body] of f.artifacts) {
      const saved = join(seed, `${index++}.data`);
      await Deno.writeFile(saved, body);
      const source = `/original/${index}.data`;
      entries.push({
        source,
        saved,
        bytes: body.length,
        sha256: await digest(body),
      });
      const [path, query] = endpoint.split("?");
      const command = ["gh", "api", "--method", "GET", path];
      for (const [key, value] of new URLSearchParams(query)) {
        command.push("-f", `${key}=${value}`);
      }
      commands.push({
        command,
        startedAt: new Date().toISOString(),
        status: 0,
        output: source,
      });
    }
    const ledger = bytes(commands);
    const ledgerPath = join(seed, "github-commands.json");
    await Deno.writeFile(ledgerPath, ledger);
    entries.push({
      source: "/original/github-commands.json",
      saved: ledgerPath,
      bytes: ledger.length,
      sha256: await digest(ledger),
    });
    const manifest = join(seed, "IMPORT-MANIFEST.json");
    await Deno.writeFile(manifest, bytes({ entries }));
    await importCapture(archive, manifest);
    const before = (await archive.evidence()).length;
    await importCapture(archive, manifest);
    assert.equal((await archive.evidence()).length, before);
    assert.equal((await archive.sessions()).length, 1);
    assert.equal(
      (await makeReport(archive, opts.since, opts.cutoff)).report.versions.find(
        (v) => v.runtimeSha === runtime,
      )?.ordinary.healthy,
      1,
    );
    const secret = encoder.encode(
      "Authorization: Bearer " + "ghp_" + "x".repeat(40),
    );
    const rejected = await archive.record({
      endpoint: `${base}/actions/jobs/101/logs`,
      observedAt: new Date().toISOString(),
      status: 200,
      error: null,
      transport: "gh",
    }, secret);
    assert.equal(rejected.body, null);
    assert.equal(rejected.observation.blob, null);
    await Deno.writeTextFile(ledgerPath, "corrupted capture");
    await assert.rejects(
      () => importCapture(archive, manifest),
      /digest mismatch/,
    );
  });
});

Deno.test("telemetry rollback groups repeated deployments and retains failed installation outcomes", async () => {
  await withArchive(async (archive) => {
    const earlier = proof(
      execution(8, 1, prior, 10, "bootstrap", T - 3000),
      "d".repeat(64),
      "healthy",
      88,
    );
    earlier.finishedAt = T - 2000;
    const candidate = proof(
      execution(9, 1, runtime, 11, "bootstrap", T),
      "e".repeat(64),
      "failed",
      99,
    );
    const restored = proof(
      execution(12, 1, prior, 12, "rollback", T + 6000),
      "c".repeat(64),
      "healthy",
      112,
    );
    restored.finishedAt = T + 8000;
    const failureSha = "f".repeat(40);
    const journals = [
      {
        kind: "hosted_installation",
        id: `installation:${prior}`,
        candidateRevision: prior,
        previousRevision: "0".repeat(40),
        previousGeneration: 9,
        phase: "accepted",
        bootstrapProof: earlier,
        bootstrapExecutionId: earlier.execution.id,
      },
      {
        kind: "hosted_installation",
        id: `installation:${runtime}`,
        candidateRevision: runtime,
        previousRevision: prior,
        previousGeneration: 10,
        phase: "rolled_back",
        bootstrapProof: candidate,
        bootstrapExecutionId: candidate.execution.id,
        rollbackProof: restored,
        rollbackExecutionId: restored.execution.id,
      },
      {
        kind: "hosted_installation",
        id: `installation:${failureSha}`,
        candidateRevision: failureSha,
        previousRevision: prior,
        previousGeneration: 12,
        phase: "failed",
        createdAt: T + 8500,
        updatedAt: T + 9000,
        bootstrapProof: null,
      },
    ];
    const entries = [];
    const responses = new Map<string, Uint8Array>();
    for (const journal of journals) {
      const blob = await gitBlob(journal);
      entries.push({
        type: "blob",
        path: `hostedInstallations/${await digest(
          encoder.encode(journal.id),
        )}.json`,
        sha: blob.sha,
      });
      responses.set(`${base}/git/blobs/${blob.sha}`, blob.body);
    }
    const pointer = await gitBlob({
      kind: "hosted_runtime",
      id: `${CONTROLLER}:0:production`,
      activeRevision: prior,
      generation: 12,
      updatedAt: T + 9000,
      lastHealthyProof: restored,
    });
    entries.push({ type: "blob", path: POINTER_PATH, sha: pointer.sha });
    responses.set(`${base}/git/blobs/${pointer.sha}`, pointer.body);
    const head = "2".repeat(40);
    responses.set(
      `${base}/git/ref/heads/sentinel-state/release`,
      bytes({ object: { sha: head } }),
    );
    responses.set(
      apiPath(`${base}/git/trees/${head}`, { recursive: 1 }),
      bytes({ tree: entries }),
    );
    for (const [endpoint, body] of responses) {
      await archive.record({
        endpoint,
        observedAt: new Date().toISOString(),
        status: 200,
        error: null,
        transport: "gh",
      }, body);
    }
    const r = (await makeReport(archive, opts.since, opts.cutoff)).report;
    const restoredVersion = r.versions.find((v) => v.runtimeSha === prior)!;
    assert.equal(restoredVersion.intervals.length, 2);
    assert.deepEqual(restoredVersion.intervals.map((i) => i.generation), [
      10,
      12,
    ]);
    assert.equal(restoredVersion.intervals[1].kind, "rollback");
    assert.equal(restoredVersion.ordinary.completed, 0);
    assert.equal(
      r.installations.some((i) =>
        i.phase === "failed" && i.candidateRevision === failureSha
      ),
      true,
    );
    assert.equal(
      r.versions.find((v) => v.runtimeSha === failureSha)?.ordinary.goodPercent,
      null,
    );
    assert.equal(
      r.versions.find((v) => v.runtimeSha === runtime)?.otherPurposes.bootstrap,
      1,
    );
  });
});

Deno.test("telemetry metadata cannot supply runtime identity and durable log mismatch is refused", async () => {
  await withArchive(async (archive) => {
    const f = await fixture();
    // Keep the valid job and terminal but change the raw bytes the durable receipt hashes.
    const logPath = `${base}/actions/jobs/101/logs`;
    const raw = f.artifacts.get(logPath)!;
    f.artifacts.set(
      logPath,
      encoder.encode(new TextDecoder().decode(raw) + "extra archived line\n"),
    );
    await syncArchive(archive, opts, f.api);
    const r = (await makeReport(archive, opts.since, opts.cutoff)).report;
    assert.equal(
      r.versions.find((v) => v.runtimeSha === runtime)?.ordinary.healthy,
      0,
    );
    assert.equal(r.coverage.unassignedAttempts, 1);
    assert.match(r.coverage.nativeRefusals.join(" "), /durable\/log mismatch/);
    assert.equal(r.versions.some((v) => v.runtimeSha === launcher), false);
  });
});
