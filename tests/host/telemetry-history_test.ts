import assert from "node:assert/strict";
import { Archive } from "../../ops/telemetry-store.ts";
import { apiPath, syncArchive } from "../../ops/telemetry-collect.ts";
import { makeReport } from "../../ops/telemetry-report.ts";
import { importCapture } from "../../ops/telemetry-import.ts";
import {
  bindHealth,
  type StateEvidence,
  transitions,
} from "../../ops/telemetry-proof.ts";
import {
  type Api,
  CONTROLLER,
  digest,
  encoder,
  iso,
  POINTER_PATH,
  TARGETS,
} from "../../ops/telemetry-types.ts";
import { HOSTED_SUPERVISOR_WORKFLOW_ID } from "../../src/contracts/hosted-supervisor-types.ts";
import { parseHostedNotStartedProofV1 } from "../../src/contracts/hosted-supervisor-execution.ts";
const T = Date.parse("2026-10-29T12:00:00Z"),
  A = "a".repeat(40),
  B = "b".repeat(40),
  C = "c".repeat(40),
  base = `repos/${CONTROLLER}`;
const options = {
  since: T - 1000,
  cutoff: T + 10000,
  maxReads: 120,
  deadlineMs: 20000,
};
function test(name: string, fn: (archive: Archive) => Promise<void> | void) {
  Deno.test(name, async () => {
    const root = await Deno.makeTempDir({
      dir: Deno.cwd(),
      prefix: ".telemetry-history-",
    });
    const archive = new Archive(root);
    await archive.open();
    try {
      await fn(archive);
    } finally {
      await archive.close();
      await Deno.remove(root, { recursive: true });
    }
  });
}
const bytes = (v: unknown) => encoder.encode(JSON.stringify(v));
async function capturePages(
  archive: Archive,
  tag: string,
  requests: { page: number; value: unknown; at: number; status?: number }[],
) {
  const root = archive.root + "/" + tag;
  await Deno.mkdir(root);
  const entries = [];
  const receipts = [];
  for (let i = 0; i < requests.length; i++) {
    const r = requests[i],
      output = "/original/" + tag + "/" + i + ".json",
      saved = root + "/" + i + ".json",
      body = bytes(r.value);
    await Deno.writeFile(saved, body);
    entries.push({
      source: output,
      saved,
      bytes: body.length,
      sha256: await digest(body),
    });
    const command = [
      "gh",
      "api",
      "--method",
      "GET",
      `repos/${CONTROLLER}/pulls`,
    ];
    for (
      const [k, v] of new URLSearchParams(
        pullsPath(CONTROLLER, r.page).split("?")[1],
      )
    ) command.push("-f", k + "=" + v);
    receipts.push({
      command,
      output,
      startedAt: iso(r.at),
      status: r.status ?? 0,
    });
  }
  const ledger = bytes(receipts);
  await Deno.writeFile(root + "/github-commands.json", ledger);
  entries.push({
    source: "/original/" + tag + "/github-commands.json",
    saved: root + "/github-commands.json",
    bytes: ledger.length,
    sha256: await digest(ledger),
  });
  const manifest = root + "/IMPORT-MANIFEST.json";
  await Deno.writeFile(manifest, bytes({ entries }));
  await importCapture(archive, manifest);
}
const ex = (
  runId = 10,
  revision = A,
  generation = 10,
  purpose = "ordinary",
  createdAt = T + 1000,
) => ({
  id: `${runId}:1:repair`,
  runId,
  runAttempt: 1,
  revision,
  launcherSha: C,
  generation,
  purpose,
  createdAt,
  releaseId: null,
});
const proof = (e = ex(), outcome = "healthy") => ({
  execution: e,
  repository: CONTROLLER,
  workflowPath: ".github/workflows/supervisor.yml",
  ref: "refs/heads/sentinel-supervisor",
  settled: true,
  jobId: e.runId + 100,
  logDigest: "d".repeat(64),
  outcome,
  startupReady: outcome === "healthy",
  finishedAt: e.createdAt + 500,
});
const pullsPath = (repo: string, page = 1) =>
  apiPath(`repos/${repo}/pulls`, {
    state: "closed",
    sort: "updated",
    direction: "desc",
    per_page: 100,
    page,
  });
const runPath = () =>
  apiPath(`${base}/actions/workflows/supervisor.yml/runs`, {
    per_page: 100,
    page: 1,
    created: `${iso(options.since)}..${iso(options.cutoff)}`,
  });
async function blob(v: unknown) {
  const body = bytes(v),
    header = encoder.encode(`blob ${body.length}\0`),
    raw = new Uint8Array(header.length + body.length);
  raw.set(header);
  raw.set(body, header.length);
  const sha = await digest(raw, "SHA-1");
  return {
    sha,
    body: bytes({
      sha,
      encoding: "base64",
      content: btoa(new TextDecoder().decode(body)),
    }),
  };
}
async function stateArtifacts(
  pointer: unknown,
  journals: Record<string, unknown>[],
) {
  const map = new Map<string, Uint8Array>();
  const entries = [];
  for (
    const [path, value] of [
      [POINTER_PATH, pointer],
      ...await Promise.all(
        journals.map(async (
          j,
        ) => [
          `hostedInstallations/${await digest(
            encoder.encode(String(j.id)),
          )}.json`,
          j,
        ]),
      ),
    ] as [string, unknown][]
  ) {
    const b = await blob(value);
    entries.push({ type: "blob", path, sha: b.sha });
    map.set(`${base}/git/blobs/${b.sha}`, b.body);
  }
  const head = "1".repeat(40);
  map.set(
    `${base}/git/ref/heads/sentinel-state/release`,
    bytes({ object: { sha: head } }),
  );
  map.set(
    apiPath(`${base}/git/trees/${head}`, { recursive: 1 }),
    bytes({ tree: entries }),
  );
  return map;
}
const journal = (
  candidate: string,
  previous: string,
  generation: number,
  start: number,
  run: number,
) => {
  const p = proof(ex(run, candidate, generation + 1, "bootstrap", start));
  return {
    kind: "hosted_installation",
    id: `installation:${candidate}`,
    candidateRevision: candidate,
    previousRevision: previous,
    previousGeneration: generation,
    phase: "accepted",
    bootstrapExecutionId: p.execution.id,
    bootstrapProof: p,
  };
};
const pointer = (revision = A, generation = 10) => ({
  kind: "hosted_runtime",
  id: `${CONTROLLER}:0:production`,
  activeRevision: revision,
  generation,
  updatedAt: T + 9000,
});
const apiFor =
  (map: Map<string, Uint8Array>, calls: string[]): Api => (path) => {
    calls.push(path);
    return Promise.resolve(
      map.has(path)
        ? { status: 200, body: map.get(path)! }
        : { status: 404, body: new Uint8Array() },
    );
  };
async function add(
  a: Archive,
  endpoint: string,
  value: unknown,
  at = T + 11000,
) {
  await a.record({
    endpoint,
    observedAt: iso(at),
    status: 200,
    error: null,
    transport: "gh",
  }, value instanceof Uint8Array ? value : bytes(value));
}
test("refresh job listing captured while queued", async (archive) => {
  const a = archive, map = new Map<string, Uint8Array>(), calls: string[] = [];
  const run = {
    id: 10,
    run_attempt: 1,
    head_sha: C,
    created_at: iso(T + 1000),
    updated_at: iso(T + 1000),
    status: "queued",
    conclusion: null as string | null,
  };
  map.set(runPath(), bytes({ total_count: 1, workflow_runs: [run] }));
  for (const r of TARGETS) map.set(pullsPath(r), bytes([]));
  const jobs = apiPath(`${base}/actions/runs/10/attempts/1/jobs`, {
    per_page: 100,
  });
  map.set(jobs, bytes({ total_count: 0, jobs: [] }));
  await syncArchive(a, options, apiFor(map, calls));
  calls.length = 0;
  map.set(
    runPath(),
    bytes({
      total_count: 1,
      workflow_runs: [{
        ...run,
        status: "completed",
        conclusion: "success",
        updated_at: iso(T + 4000),
      }],
    }),
  );
  map.set(
    jobs,
    bytes({
      total_count: 1,
      jobs: [{
        id: 110,
        run_id: 10,
        run_attempt: 1,
        name: "repair",
        head_sha: C,
        status: "completed",
        conclusion: "success",
        started_at: iso(T + 2000),
      }],
    }),
  );
  map.set(`${base}/actions/jobs/110/logs`, encoder.encode("now available"));
  await syncArchive(a, options, apiFor(map, calls));
  assert.ok(
    calls.includes(jobs),
    "queued empty list must not be cached permanently",
  );
});
test("sync discovers failed candidate journal after rollback", async (archive) => {
  const a = archive, calls: string[] = [];
  const installed = journal(A, "0".repeat(40), 9, T, 8),
    failed = {
      ...journal(B, A, 10, T + 3000, 9),
      phase: "rolled_back",
      rollbackExecutionId: "12:1:repair",
      rollbackProof: proof(ex(12, A, 12, "bootstrap", T + 6000)),
    };
  const map = await stateArtifacts(pointer(A, 12), [installed, failed]);
  for (const r of TARGETS) map.set(pullsPath(r), bytes([]));
  map.set(runPath(), bytes({ total_count: 0, workflow_runs: [] }));
  await syncArchive(a, options, apiFor(map, calls));
  const r = (await makeReport(a, options.since, options.cutoff)).report;

  assert.ok(
    r.installations.some((i) => i.candidateRevision === B),
    "rollback journal must be fetched",
  );
});
test("partial page refresh preserves known merged evidence", async (archive) => {
  const a = archive;
  const map = await stateArtifacts(pointer(), [
    journal(A, "0".repeat(40), 9, T, 8),
  ]);
  for (const [p, b] of map) await add(a, p, b);
  const filler = Array.from(
    { length: 99 },
    (_, i) => ({ number: i + 100, updated_at: iso(T + 6000), merged_at: null }),
  );
  const merged = {
    number: 1,
    updated_at: iso(T + 6000),
    merged_at: iso(T + 5000),
    merge_commit_sha: "e".repeat(40),
    merged_by: { type: "Bot" },
  };
  await add(a, pullsPath(CONTROLLER), [merged, ...filler]);
  await add(a, pullsPath(CONTROLLER, 2), []);
  for (const r of TARGETS.slice(1)) await add(a, pullsPath(r), []);
  await makeReport(a, options.since, options.cutoff);
  await add(
    a,
    pullsPath(CONTROLLER),
    Array.from(
      { length: 100 },
      (_, i) => ({
        number: i + 500,
        updated_at: iso(T + 12000),
        merged_at: null,
      }),
    ),
    T + 14000,
  );
  const second = (await makeReport(a, options.since, options.cutoff)).report;

  assert.equal(
    second.versions[0].velocity.observedMerges,
    1,
    "archived merge should remain counted",
  );
  assert.equal(second.coverage.mergeLists[CONTROLLER].complete, false);
  assert.equal(second.versions[0].velocity.newAcceptedAutonomousMerges, null);
});
test("native not-started settlement remains bound", async () => {
  const notStarted = parseHostedNotStartedProofV1({
    execution: ex(),
    workflowId: HOSTED_SUPERVISOR_WORKFLOW_ID,
    repository: CONTROLLER,
    workflowPath: ".github/workflows/supervisor.yml",
    ref: "refs/heads/sentinel-supervisor",
    jobId: null,
    finishedAt: T + 4000,
    observedAt: T + 5000,
    outcome: "not_started",
    evidenceDigest: "e".repeat(64),
  });
  const state: StateEvidence[] = [{
    path: POINTER_PATH,
    evidence: "proof",
    value: { kind: "hosted_runtime", lastExecutionProof: notStarted },
  }];
  const attempts = new Map();
  await bindHealth([], state, attempts, options.since, options.cutoff);
  assert.equal(attempts.get("10/1")?.health, "unstarted");
});
test("bootstrap retry does not move original installation clock", () => {
  const original = proof(ex(8, A, 10, "bootstrap", T), "failed");
  const j = {
    ...journal(A, "0".repeat(40), 9, T + 6000, 9),
    retriedBootstrapProof: original,
  };
  const t = transitions([{ value: j, evidence: "journal", path: "journal" }]);
  assert.equal(t[0]?.start, T);
});

test("completed partial jobs from an in-flight attempt are refreshed", async (archive) => {
  const a = archive, calls: string[] = [], map = new Map<string, Uint8Array>();
  const run = {
    id: 10,
    run_attempt: 1,
    head_sha: C,
    created_at: iso(T + 1000),
    updated_at: iso(T + 1000),
    status: "in_progress",
    conclusion: null,
  };
  const jobs = apiPath(`${base}/actions/runs/10/attempts/1/jobs`, {
    per_page: 100,
  });
  map.set(runPath(), bytes({ total_count: 1, workflow_runs: [run] }));
  map.set(
    jobs,
    bytes({
      total_count: 1,
      jobs: [{ id: 109, name: "maintenance", status: "completed" }],
    }),
  );
  for (const r of TARGETS) map.set(pullsPath(r), bytes([]));
  await syncArchive(a, options, apiFor(map, calls));
  calls.length = 0;
  map.set(
    runPath(),
    bytes({
      total_count: 1,
      workflow_runs: [{ ...run, status: "completed", conclusion: "success" }],
    }),
  );
  map.set(
    jobs,
    bytes({
      total_count: 2,
      jobs: [{ id: 109, name: "maintenance", status: "completed" }, {
        id: 110,
        name: "repair",
        run_id: 10,
        run_attempt: 1,
        head_sha: C,
        status: "completed",
        started_at: iso(T + 2000),
        conclusion: "success",
      }],
    }),
  );
  map.set(
    `${base}/actions/jobs/110/logs`,
    encoder.encode("completed attempt log"),
  );
  await syncArchive(a, options, apiFor(map, calls));
  assert.ok(calls.includes(jobs));
  assert.ok(calls.includes(`${base}/actions/jobs/110/logs`));
});

test("bounded sync obtains current native health before old merge detail enrichment", async (archive) => {
  const calls: string[] = [],
    map = await stateArtifacts(pointer(A, 10), [
      journal(A, "0".repeat(40), 9, T, 8),
    ]);
  const e = { ...ex(), launcherSha: A };
  map.set(
    runPath(),
    bytes({
      total_count: 1,
      workflow_runs: [{
        id: 10,
        run_attempt: 1,
        head_sha: A,
        created_at: iso(T + 1000),
        updated_at: iso(T + 4000),
        status: "completed",
        conclusion: "success",
      }],
    }),
  );
  map.set(
    apiPath(`${base}/actions/runs/10/attempts/1/jobs`, { per_page: 100 }),
    bytes({
      total_count: 1,
      jobs: [{
        id: 110,
        name: "repair",
        run_id: 10,
        run_attempt: 1,
        head_sha: A,
        status: "completed",
        started_at: iso(T + 2000),
        conclusion: "success",
      }],
    }),
  );
  const terminal = {
    version: "v1",
    kind: "hosted_runtime_terminal",
    execution: e,
    controllerSha: A,
    settled: true,
    startupReady: true,
    outcome: "healthy",
    finishedAt: T + 4000,
  };
  const summary = {
    version: "v1",
    kind: "hosted_runtime_summary",
    runId: 10,
    attempt: 1,
    launcherSha: A,
    runtimeSha: A,
    generation: 10,
    purpose: "ordinary",
    outcome: "healthy",
    admittedWorkCount: 0,
    prsTouched: [],
  };
  map.set(
    `${base}/actions/jobs/110/logs`,
    encoder.encode(
      JSON.stringify(terminal) + "\n" + JSON.stringify(summary) + "\n",
    ),
  );
  for (const r of TARGETS) {
    map.set(
      pullsPath(r),
      bytes(
        Array.from(
          { length: 20 },
          (_, i) => ({
            number: i + 1,
            merged_at: iso(T + 3000),
            updated_at: iso(T + 3000),
            merge_commit_sha: "e".repeat(40),
          }),
        ),
      ),
    );
  }
  const coverage = await syncArchive(
    archive,
    { ...options, maxReads: 7 },
    apiFor(map, calls),
  );
  assert.equal(coverage.reads, 7);
  assert.ok(calls.includes(`${base}/actions/jobs/110/logs`));
  assert.equal(calls.some((p) => /\/pulls\/\d+$/.test(p)), false);
  const r = (await makeReport(archive, options.since, options.cutoff)).report;
  assert.equal(
    r.versions.find((v) => v.runtimeSha === A)?.ordinary.nativeLogCovered,
    1,
  );
  assert.equal(r.coverage.mergeLists[CONTROLLER].complete, false);
});

test("historical rollback predecessor resolves its exact prior generation", async (archive) => {
  const a = journal(A, "0".repeat(40), 9, T - 5000, 8);
  const b = {
    ...journal(B, A, 10, T + 2000, 9),
    phase: "rolled_back",
    rollbackExecutionId: "12:1:repair",
    rollbackProof: proof(ex(12, A, 12, "rollback", T + 4000)),
  };
  const c = {
    ...journal(C, A, 12, T + 7000, 13),
    previousHealthyProof: proof(ex(11, A, 12, "ordinary", T + 5000)),
  };
  const map = await stateArtifacts(pointer(C, 13), [a, b, c]);
  map.set(runPath(), bytes({ total_count: 0, workflow_runs: [] }));
  for (const r of TARGETS) map.set(pullsPath(r), bytes([]));
  await syncArchive(archive, options, apiFor(map, []));
  const report =
    (await makeReport(archive, options.since, options.cutoff)).report;
  const intervals = report.versions.flatMap((v) => v.intervals);
  assert.deepEqual(intervals.map((i) => i.generation).sort(), [10, 11, 12, 13]);
  const restored = intervals.find((i) => i.generation === 12)!;
  assert.equal(restored.revision, A);
  assert.equal(restored.start, iso(T + 4000));
  assert.equal(restored.end, iso(T + 7000));
  assert.ok(report.installations.some((j) => j.candidateRevision === B));
});

test("legacy imported ledger retries cannot combine terminal pages or erase known merges", async (archive) => {
  for (
    const [path, body] of await stateArtifacts(pointer(), [
      journal(A, "0".repeat(40), 9, T, 8),
    ])
  ) await add(archive, path, body);
  const filler = Array.from(
    { length: 100 },
    (_, i) => ({ number: i + 100, updated_at: iso(T + 9000), merged_at: null }),
  );
  await capturePages(archive, "retry-ledger", [
    { page: 1, value: { message: "unavailable" }, status: 1, at: T + 11000 },
    { page: 2, value: [], at: T + 12000 },
    { page: 1, value: filler, at: T + 14000 },
  ]);
  for (const r of TARGETS.slice(1)) await add(archive, pullsPath(r), []);
  const first =
    (await makeReport(archive, options.since, options.cutoff)).report;
  assert.equal(first.coverage.mergeLists[CONTROLLER].complete, false);
  assert.equal(first.versions[0].velocity.newAcceptedAutonomousMerges, null);
  const known = {
    number: 1,
    updated_at: iso(T + 5000),
    merged_at: iso(T + 5000),
    merge_commit_sha: "e".repeat(40),
    merged_by: { type: "Bot" },
  };
  await capturePages(archive, "older-known", [{
    page: 1,
    value: [known],
    at: T + 10000,
  }]);
  const after =
    (await makeReport(archive, options.since, options.cutoff)).report;
  assert.equal(after.versions[0].velocity.observedMerges, 1);
  assert.equal(after.coverage.mergeLists[CONTROLLER].complete, false);
  assert.ok((await archive.evidence()).every((r) => !r.observation.collection));
});

test("complete attempt ZIP bytes are cached and survive later expiry evidence", async (archive) => {
  const map = new Map<string, Uint8Array>(), calls: string[] = [];
  map.set(
    runPath(),
    bytes({
      total_count: 1,
      workflow_runs: [{
        id: 10,
        run_attempt: 1,
        head_sha: A,
        status: "completed",
        conclusion: "success",
        created_at: iso(T + 1000),
        updated_at: iso(T + 4000),
      }],
    }),
  );
  map.set(
    apiPath(`${base}/actions/runs/10/attempts/1/jobs`, { per_page: 100 }),
    bytes({ total_count: 0, jobs: [] }),
  );
  for (const r of TARGETS) map.set(pullsPath(r), bytes([]));
  // A valid empty ZIP with a two-byte binary comment exercises the opaque byte path.
  const zip = new Uint8Array(24);
  zip.set([80, 75, 5, 6]);
  zip[20] = 2;
  zip[22] = 255;
  zip[23] = 128;
  const path = `${base}/actions/runs/10/attempts/1/logs`;
  map.set(path, zip);
  const first = await syncArchive(archive, options, apiFor(map, calls));
  assert.equal(first.attemptLogArchives?.captured, 1);
  const saved = (await archive.evidence()).find((r) =>
    r.observation.endpoint === path && r.observation.status === 200
  )!;
  assert.deepEqual(saved.body, zip);
  assert.equal(saved.observation.blob, await digest(zip));
  await archive.record({
    endpoint: path,
    observedAt: iso(T + 20000),
    status: 410,
    error: "expired",
    transport: "gh",
  }, null);
  calls.length = 0;
  map.delete(path);
  const second = await syncArchive(archive, options, apiFor(map, calls));
  assert.equal(second.attemptLogArchives?.reused, 1);
  assert.equal(calls.includes(path), false);
  assert.deepEqual(
    (await archive.evidence()).find((r) => r.id === saved.id)?.body,
    zip,
  );
  const report = await makeReport(archive, options.since, options.cutoff);
  assert.ok(
    report.report.coverage.errors.some((r) =>
      r.endpoint === path && r.status === 410
    ),
  );
});
