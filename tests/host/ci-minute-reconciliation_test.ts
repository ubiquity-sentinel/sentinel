import assert from "node:assert/strict";
import { readCiMinuteWindow } from "../../ops/hosted-autonomy-github-jobs.ts";
import { createCiMinuteReconciler } from "../../ops/ci-minute-reconciliation.ts";
import {
  ciJobMinutes,
  ciMinuteDigest,
  ciPolicyDigest,
  INACTIVE_CI_MINUTE_POLICY,
  parseCiMinuteLedger,
} from "../../src/contracts/ci-minute-budget.ts";
import type {
  CiMinuteLedgerV1,
  CiMinuteObservationV1,
  CiMinutePolicyV1,
  CiMinuteReconcilerFactoryV1,
} from "../../src/contracts/ci-minute-budget.ts";

const HEAD = "a".repeat(40);
const NOW = Date.UTC(2028, 0, 2);
function timing(rows: { job_id: number; duration_ms: number }[]) {
  return {
    run_duration_ms: 5000,
    billable: {
      UBUNTU: {
        jobs: rows.length,
        total_ms: rows.reduce((n, r) => n + r.duration_ms, 0),
        job_runs: rows,
      },
    },
  };
}
function job(id: number, run: number, attempt: number, seconds = 60) {
  return {
    id,
    run_id: run,
    run_attempt: attempt,
    head_sha: HEAD,
    status: "completed",
    conclusion: "failure",
    runner_id: 1,
    labels: ["ubuntu-latest"],
    steps: [{ number: 1, status: "completed" }],
    started_at: new Date(NOW - seconds * 1000).toISOString(),
    completed_at: new Date(NOW).toISOString(),
  };
}
function run(id: number, attempts = 1) {
  return {
    id,
    repository: { id: 101 },
    head_sha: HEAD,
    run_attempt: attempts,
    status: "completed",
  };
}
const base = {
  repositoryId: 101,
  scope: "fixture/project",
  from: NOW - 86_400_000,
  through: NOW,
  deadline: NOW + 60_000,
  now: () => NOW,
};

Deno.test("CI repository reader counts every attempt and job page, including failed and cancelled work", async () => {
  const requests: string[] = [];
  const result = await readCiMinuteWindow({
    ...base,
    request(path) {
      requests.push(path);
      if (path.endsWith("/timing")) {
        return Promise.resolve(timing([
          ...Array.from(
            { length: 100 },
            (_, i) => ({ job_id: i + 1, duration_ms: 60_000 }),
          ),
          { job_id: 101, duration_ms: 61_000 },
          { job_id: 102, duration_ms: 59_000 },
        ]));
      }
      if (path.includes("actions/runs?")) {
        return Promise.resolve({ total_count: 1, workflow_runs: [run(10, 2)] });
      }
      if (path.includes("attempts/1/jobs")) {
        const page = new URL(`https://fixture.invalid${path}`).searchParams.get(
          "page",
        );
        return Promise.resolve({
          total_count: 101,
          jobs: page === "1"
            ? Array.from({ length: 100 }, (_, i) => job(i + 1, 10, 1))
            : [job(101, 10, 1, 61)],
        });
      }
      return Promise.resolve({
        total_count: 1,
        jobs: [{ ...job(102, 10, 2, 59), conclusion: "cancelled" }],
      });
    },
  });
  assert.equal(result.complete, true);
  assert.equal(result.cursor, null);
  assert.equal(result.jobs.length, 102);
  assert.equal(new Set(result.jobs.map((j) => j.digest)).size, 102);
  assert.equal(result.jobs.reduce((sum, j) => sum + ciJobMinutes(j), 0), 103);
  assert.equal(requests.length, 5);
});

Deno.test("CI repository reader returns a bound private continuation after eight job reads", async () => {
  const requests: string[] = [];
  const request = (path: string) => {
    requests.push(path);
    if (path.includes("actions/runs?")) {
      return Promise.resolve({
        total_count: 9,
        workflow_runs: Array.from({ length: 9 }, (_, i) => run(i + 1)),
      });
    }
    const id = Number(/runs\/(\d+)\//.exec(path)![1]);
    if (path.endsWith("/timing")) {
      return Promise.resolve(timing([{ job_id: id, duration_ms: 60_000 }]));
    }
    return Promise.resolve({ total_count: 1, jobs: [job(id, id, 1)] });
  };
  const first = await readCiMinuteWindow({ ...base, request });
  assert.equal(first.complete, false);
  assert.equal(first.reason, "read_bound");
  assert.equal(first.jobs.length, 4);
  assert.equal(requests.length, 9);
  assert.ok(first.cursor);
  const second = await readCiMinuteWindow({
    ...base,
    request,
    cursor: first.cursor,
  });
  assert.equal(second.complete, false);
  assert.equal(second.jobs.length, 4);
  const third = await readCiMinuteWindow({
    ...base,
    request,
    cursor: second.cursor!,
  });
  assert.equal(third.complete, true);
  assert.equal(third.jobs.length, 1);
  assert.equal(
    new Set([...first.jobs, ...second.jobs, ...third.jobs].map((j) => j.digest))
      .size,
    9,
  );
  assert.equal(JSON.stringify(first.cursor).includes("fixture/project"), false);
});

Deno.test("CI reader refuses missing coverage, another repository, another head and queued work", async () => {
  for (
    const mode of [
      "coverage",
      "repository",
      "head",
      "pending",
      "dense",
    ] as const
  ) {
    const result = await readCiMinuteWindow({
      ...base,
      request(path) {
        if (path.endsWith("/timing")) {
          return Promise.resolve(timing([{ job_id: 1, duration_ms: 60_000 }]));
        }
        if (path.includes("actions/runs?")) {
          if (mode === "dense") {
            return Promise.resolve({ total_count: 1001, workflow_runs: [] });
          }
          return Promise.resolve({
            total_count: mode === "coverage" ? 2 : 1,
            workflow_runs: [{
              ...run(1),
              ...(mode === "repository" ? { repository: { id: 999 } } : {}),
              ...(mode === "pending" ? { status: "queued" } : {}),
            }],
          });
        }
        return Promise.resolve({
          total_count: 1,
          jobs: [{
            ...job(1, 1, 1),
            ...(mode === "head" ? { head_sha: "b".repeat(40) } : {}),
          }],
        });
      },
    });
    assert.equal(result.complete, false, mode);
    assert.equal(result.jobs.length, 0, mode);
  }
});

Deno.test("CI cursor cannot be reused for another time window or job page", async () => {
  let requests = 0;
  const result = await readCiMinuteWindow({
    ...base,
    request() {
      requests++;
      return Promise.resolve(null);
    },
    cursor: {
      queryDigest: "f".repeat(64),
      runPage: 1,
      runOffset: 0,
      attempt: 1,
      jobPage: 2,
      jobsSeen: 0,
      runDigest: null,
    },
  });
  assert.equal(result.complete, false);
  assert.equal(result.reason, "cursor_binding");
  assert.equal(requests, 0);
});

Deno.test("CI provider meter: no timestamp or run-duration fallback and mismatched job IDs hold", async () => {
  for (const mode of ["valid", "missing", "wrong_job", "wrong_total"]) {
    const result = await readCiMinuteWindow({
      ...base,
      request: async (path) => {
        await Promise.resolve(); // Preserve asynchronous transport behavior.
        if (path.includes("actions/runs?")) {
          return { total_count: 1, workflow_runs: [run(1)] };
        }
        if (path.endsWith("/timing")) {
          if (mode === "missing") return null;
          const data = timing([{
            job_id: mode === "wrong_job" ? 999 : 1,
            duration_ms: 120001,
          }]);
          if (mode === "wrong_total") data.billable.UBUNTU.total_ms++;
          return data;
        }
        return { total_count: 1, jobs: [job(1, 1, 1, 5)] };
      },
    });
    if (mode === "valid") {
      assert.equal(result.complete, true);
      assert.equal(ciJobMinutes(result.jobs[0]), 3);
      assert.equal(result.jobs[0].billedDurationMs, 120001);
    } else assert.equal(result.complete, false, mode);
  }
});

Deno.test("CI reader retained estimate: a started497s job with timing zero retains25 minutes", async () => {
  const input = {
    ...base,
    estimateMinutes: 25,
    request: async (path: string) => {
      await Promise.resolve();
      if (path.includes("actions/runs?")) {
        return { total_count: 1, workflow_runs: [run(7)] };
      }
      if (path.endsWith("/timing")) {
        return timing([{ job_id: 71, duration_ms: 0 }]);
      }
      return { total_count: 1, jobs: [job(71, 7, 1, 497)] };
    },
  };
  const result = await readCiMinuteWindow(input);
  assert.equal(result.complete, true);
  assert.equal(result.jobs[0].billedDurationMs, 0);
  assert.equal(result.jobs[0].estimate?.minutes, 25);
  assert.equal(result.jobs[0].estimate?.kind, "retained_estimate");
});

Deno.test("CI retained estimates preserve positive, missing and unsupported meter evidence without refunds", async () => {
  for (
    const mode of [
      "positive",
      "overrun",
      "missing",
      "unsupported",
      "wrong_job",
    ] as const
  ) {
    const result = await readCiMinuteWindow({
      ...base,
      estimateMinutes: 25,
      request: async (path) => {
        await Promise.resolve();
        if (path.includes("actions/runs?")) {
          return { total_count: 1, workflow_runs: [run(1)] };
        }
        if (path.endsWith("/timing")) {
          if (mode === "missing") return null;
          if (mode === "unsupported") {
            return { billable: { WINDOWS: {} }, run_duration_ms: 1 };
          }
          return timing([{
            job_id: mode === "wrong_job" ? 999 : 1,
            duration_ms: mode === "overrun" ? 31 * 60_000 : 120001,
          }]);
        }
        return { total_count: 1, jobs: [job(1, 1, 1, 497)] };
      },
    });
    assert.equal(result.complete, true, mode);
    const proof = result.jobs[0];
    assert.equal(proof.estimate?.minutes, mode === "overrun" ? 31 : 25, mode);
    assert.equal(
      proof.billedDurationMs,
      mode === "positive" ? 120001 : mode === "overrun" ? 31 * 60_000 : null,
      mode,
    );
    assert.equal(proof.estimate?.executionMonth, "2028-01");
    assert.match(proof.estimate!.terminalProofDigest, /^[a-f0-9]{64}$/);
  }
});

Deno.test("CI retained reader distinguishes authenticated never-started zero from started work", async () => {
  const result = await readCiMinuteWindow({
    ...base,
    estimateMinutes: 35,
    request: async (path) => {
      await Promise.resolve();
      if (path.includes("actions/runs?")) {
        return { total_count: 1, workflow_runs: [run(1)] };
      }
      if (path.endsWith("/timing")) return null;
      return {
        total_count: 1,
        jobs: [{
          ...job(1, 1, 1),
          runner_id: 0,
          steps: [],
          started_at: null,
          completed_at: null,
        }],
      };
    },
  });
  assert.equal(result.complete, true);
  assert.equal(result.jobs[0].neverStarted, true);
  assert.equal(result.jobs[0].billedDurationMs, 0);
  assert.equal(result.jobs[0].estimate, undefined);
  assert.equal(ciJobMinutes(result.jobs[0]), 0);
});

Deno.test("CI retained timestamps establish period membership and conservative overruns, never provider usage", async () => {
  for (const crossBoundary of [false, true]) {
    const started = Date.UTC(2027, 11, 31, 23, 50);
    const completed = crossBoundary
      ? Date.UTC(2028, 0, 1, 0, 10)
      : started + 5 * 60_000;
    const result = await readCiMinuteWindow({
      ...base,
      estimateMinutes: 25,
      request: async (path) => {
        await Promise.resolve();
        if (path.includes("actions/runs?")) {
          return { total_count: 1, workflow_runs: [run(1)] };
        }
        if (path.endsWith("/timing")) {
          return timing([{ job_id: 1, duration_ms: 0 }]);
        }
        return {
          total_count: 1,
          jobs: [{
            ...job(1, 1, 1),
            started_at: new Date(started).toISOString(),
            completed_at: new Date(completed).toISOString(),
          }],
        };
      },
    });
    assert.equal(result.complete, true);
    assert.equal(result.jobs[0].billedDurationMs, 0);
    assert.equal(result.jobs[0].estimate?.minutes, 25);
    assert.equal(
      result.jobs[0].estimate?.executionMonth,
      crossBoundary ? null : "2027-12",
    );
  }
});

type ApiRun = ReturnType<typeof run> & {
  created_at: string;
  updated_at: string;
  path: string;
  head_branch: string;
  event: string;
};
function catalogRun(
  id: number,
  attempts = 1,
  created = NOW - 86_400_000,
): ApiRun {
  return {
    ...run(id, attempts),
    created_at: new Date(created).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    path: ".github/workflows/ci.yml",
    head_branch: "main",
    event: "push",
  };
}
function readerFixture(rows: ApiRun[]) {
  const policy: CiMinutePolicyV1 = {
    ...INACTIVE_CI_MINUTE_POLICY,
    activated: true,
    targets: [{
      owner: "fixture",
      name: "project",
      repositoryId: 101,
      ceilingMinutes: 25,
    }],
  };
  let now = NOW;
  const paths: string[] = [];
  let ledger: CiMinuteLedgerV1 = {
    version: 1,
    month: "2028-01",
    policyDigest: ciPolicyDigest(policy),
    updatedAt: now,
    sequence: 0,
    baselineMinutes: 1450,
    watermark: null,
    reservations: [],
    observed: [],
    bootstrap: {
      kind: "conservative_unknown_history",
      month: "2028-01",
      floorMinutes: 1450,
      createdAt: now,
      policyDigest: ciPolicyDigest(policy),
    },
  };
  let jobFor = (id: number, attempt: number) =>
    job(id * 100 + attempt, id, attempt, 497);
  const request = async (path: string) => {
    await Promise.resolve();
    paths.push(path);
    const url = new URL("https://fixture.invalid" + path);
    if (url.pathname === "/repos/fixture/project/actions/runs") {
      const [from, through] = url.searchParams.get("created")!.split("..").map(
        Date.parse,
      );
      const page = Number(url.searchParams.get("page"));
      const matching = rows.filter((r) =>
        Date.parse(r.created_at) >= from && Date.parse(r.created_at) <= through
      );
      return {
        total_count: matching.length,
        workflow_runs: matching.slice((page - 1) * 100, page * 100),
      };
    }
    const match = /\/actions\/runs\/(\d+)(?:\/(.*))?$/.exec(url.pathname);
    if (!match) return null;
    const id = Number(match[1]), value = rows.find((r) => r.id === id);
    if (!value) return null;
    if (!match[2]) return value;
    if (match[2] === "timing") {
      return timing(
        Array.from(
          { length: value.run_attempt },
          (_, i) => ({ job_id: id * 100 + i + 1, duration_ms: 0 }),
        ),
      );
    }
    const attempt = Number(/attempts\/(\d+)\/jobs/.exec(match[2])?.[1]);
    return { total_count: 1, jobs: [jobFor(id, attempt)] };
  };
  const observe = (
    extraRequest: (path: string) => Promise<unknown | null> = request,
  ) => {
    const factory: CiMinuteReconcilerFactoryV1 = createCiMinuteReconciler;
    return factory({
      policy,
      request: extraRequest,
      clock: { now: () => now },
    });
  };
  const adopt = (observation: CiMinuteObservationV1) => {
    const proofs = new Map(
      (ledger.proofs ?? []).map((proof) => [proof.digest, proof]),
    );
    for (const proof of observation.jobs) proofs.set(proof.digest, proof);
    ledger = parseCiMinuteLedger({
      ...ledger,
      updatedAt: now,
      sequence: ledger.sequence + 1,
      watermark: observation.complete
        ? observation.watermark
        : ledger.watermark,
      progress: observation.progress,
      catalog: observation.catalog,
      completedAttempts: [
        ...new Set([
          ...(ledger.completedAttempts ?? []),
          ...(observation.completedAttempts ?? []),
        ]),
      ],
      proofs: [...proofs.values()],
    });
  };
  return {
    policy,
    rows,
    paths,
    request,
    observe,
    adopt,
    ledger: () => ledger,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    now: () => now,
    jobs: (value: typeof jobFor) => {
      jobFor = value;
    },
  };
}
async function finishReader(
  f: ReturnType<typeof readerFixture>,
  maxTurns = 30,
) {
  let result: CiMinuteObservationV1 | null = null;
  for (let turn = 0; turn < maxTurns; turn++) {
    result = await f.observe()("2028-01", f.now() + 60_000, f.ledger());
    assert.ok(result);
    f.adopt(result);
    if (result.complete) return result;
  }
  assert.fail("bounded reader fixture did not complete");
}

Deno.test("CI reconciler authenticates older-created current-month reruns and binds their new reservation", async () => {
  const oldCreated = Date.UTC(2027, 9, 1),
    f = readerFixture([catalogRun(7, 2, oldCreated)]);
  f.jobs((id, attempt) => ({
    ...job(id * 100 + attempt, id, attempt, 497),
    ...(attempt === 1
      ? {
        started_at: new Date(Date.UTC(2027, 11, 20)).toISOString(),
        completed_at: new Date(Date.UTC(2027, 11, 20) + 497_000).toISOString(),
      }
      : {}),
  }));
  const effectDigest = "c".repeat(64);
  f.ledger().reservations.push({
    effectDigest,
    policyDigest: f.ledger().policyDigest,
    ceilingMinutes: 25,
    state: "submitted",
    createdAt: NOW - 10_000,
    settledAt: null,
    chargedMinutes: 25,
    proofDigest: null,
    binding: {
      repositoryId: 101,
      workflowBlob: HEAD,
      job: "validation",
      effect: {
        repository: { owner: "fixture", name: "project", installationId: 0 },
        kind: "rerun",
        head: HEAD,
        base: null,
        ref: "refs/heads/main",
        pr: null,
        runId: 7,
        attempt: 2,
      },
    },
  });
  const result = await finishReader(f);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].identity?.attempt, 2);
  assert.equal(result.jobs[0].effectDigest, effectDigest);
  assert.equal(result.jobs[0].estimate?.minutes, 25);
  assert.equal(result.catalog?.runs[0].checkedAttempt, 2);
  assert.equal(result.catalog?.runs[0].createdAt, oldCreated);
  assert.equal(f.ledger().baselineMinutes, 1450);
});

Deno.test("CI reconciler resumes durable catalog and attempts with shared four-page/eight-object bounds", async () => {
  const f = readerFixture(
    Array.from({ length: 9 }, (_, i) => catalogRun(i + 1)),
  );
  let complete = false, turns = 0;
  while (!complete && turns++ < 12) {
    const before = structuredClone(f.ledger()), offset = f.paths.length;
    Object.freeze(f.ledger());
    const result = await f.observe()("2028-01", f.now() + 60_000, f.ledger());
    assert.ok(result);
    assert.deepEqual(
      f.ledger(),
      before,
      "observer must not mutate its supplied ledger",
    );
    const paths = f.paths.slice(offset);
    assert.ok(paths.filter((p) => p.includes("actions/runs?")).length <= 4);
    assert.ok(paths.filter((p) => !p.includes("actions/runs?")).length <= 8);
    if (!result.complete) {
      assert.equal(result.watermark, 0);
      assert.equal(f.ledger().watermark, null);
      assert.equal(result.catalog?.complete, false);
      assert.ok(result.progress);
    }
    f.adopt(result);
    complete = result.complete;
  }
  assert.equal(complete, true);
  assert.ok(turns > 1);
  assert.equal(f.ledger().proofs?.length, 9);
  assert.equal(
    f.paths.filter((p) => p.includes("actions/runs?")).length,
    1,
    "history discovery is not restarted every turn",
  );
  assert.equal(f.ledger().catalog?.cursor, 9);
  assert.equal(f.ledger().catalog?.complete, true);
});

Deno.test("CI reconciler advances only completed new-run discovery and refreshes old catalog reruns", async () => {
  const f = readerFixture([catalogRun(1, 1, Date.UTC(2027, 9, 1))]);
  await finishReader(f);
  const watermark = f.ledger().catalog!.passThrough!, offset = f.paths.length;
  f.advance(60_000);
  f.rows[0].run_attempt = 2;
  f.rows[0].updated_at = new Date(f.now()).toISOString();
  f.rows.push({
    ...catalogRun(2),
    created_at: new Date(f.now() - 1000).toISOString(),
    updated_at: new Date(f.now()).toISOString(),
  });
  const result = await finishReader(f);
  assert.equal(result.catalog?.runs.length, 2);
  assert.equal(
    result.catalog?.runs.find((r) => r.runId === 1)?.checkedAttempt,
    2,
  );
  assert.equal(result.catalog?.passThrough, f.now());
  for (
    const path of f.paths.slice(offset).filter((p) =>
      p.includes("actions/runs?")
    )
  ) {
    const from = Date.parse(
      new URL("https://fixture.invalid" + path).searchParams.get("created")!
        .split("..")[0],
    );
    assert.equal(from, Math.floor(watermark / 1000) * 1000);
  }
  assert.ok(
    f.ledger().proofs?.some((proof) =>
      proof.identity?.runId === 1 && proof.identity.attempt === 2
    ),
  );
});

Deno.test("CI reconciler retains density-limited discovery progress and never claims complete coverage", async () => {
  const f = readerFixture(
    Array.from({ length: 1000 }, (_, i) => catalogRun(i + 1)),
  );
  const first = await f.observe()("2028-01", f.now() + 60_000, f.ledger());
  assert.ok(first);
  assert.equal(first.complete, false);
  assert.equal(first.catalog?.passThrough, null);
  f.adopt(first);
  const initialPath = f.paths[0], offset = f.paths.length;
  const second = await f.observe()("2028-01", f.now() + 60_000, f.ledger());
  assert.ok(second);
  assert.equal(second.complete, false);
  assert.equal(second.catalog?.passThrough, null);
  assert.equal(f.paths.slice(offset).includes(initialPath), false);
  assert.ok(f.paths.slice(offset).length <= 4);
  for (const path of f.paths) {
    const range = new URL("https://fixture.invalid" + path).searchParams.get(
      "created",
    )!.split("..").map(Date.parse);
    assert.equal(range[0] % 1000, 0);
    assert.equal(range[1] % 1000, 0);
  }
  f.adopt(second);
});

Deno.test("CI reconciler closes a stale discovery gap before completing a multi-turn pass", async () => {
  const f = readerFixture(
    Array.from({ length: 9 }, (_, i) => catalogRun(i + 1)),
  );
  const first = await f.observe()("2028-01", f.now() + 60_000, f.ledger());
  assert.ok(first);
  assert.equal(first.complete, false);
  f.adopt(first);
  f.advance(60_000);
  const final = await finishReader(f);
  assert.equal(final.watermark, f.now());
  assert.equal(final.catalog?.passThrough, f.now());
  const discovery = f.paths.filter((path) => path.includes("actions/runs?"));
  assert.equal(discovery.length, 2);
  const range = new URL("https://fixture.invalid" + discovery[1]).searchParams
    .get("created")!.split("..");
  assert.equal(Date.parse(range[0]), NOW);
  assert.equal(Date.parse(range[1]), f.now());
});

Deno.test("CI reconciler refuses duplicate discovery rows and missing listing coverage", async () => {
  for (const duplicate of [false, true]) {
    const f = readerFixture([catalogRun(1)]);
    const result = await f.observe(async (path) =>
      path.includes("actions/runs?")
        ? {
          total_count: 2,
          workflow_runs: duplicate ? [f.rows[0], f.rows[0]] : [f.rows[0]],
        }
        : await f.request(path)
    )("2028-01", f.now() + 60_000, f.ledger());
    assert.ok(result);
    assert.equal(result.complete, false);
    assert.equal(result.catalog?.passThrough, null);
    assert.equal(f.ledger().watermark, null);
  }
});

Deno.test("CI reconciler holds a single-timestamp search at the exact1000-result cap", async () => {
  const f = readerFixture(
    Array.from({ length: 1000 }, (_, i) => catalogRun(i + 1)),
  );
  const created = Date.parse(f.rows[0].created_at);
  f.ledger().progress = {
    month: "2028-01",
    through: NOW,
    windowFrom: created,
    windowThrough: created,
    targetIndex: 0,
    cursor: null,
    jobs: [],
    completedAttempts: [],
  };
  const result = await f.observe()("2028-01", f.now() + 60_000, f.ledger());
  assert.ok(result);
  assert.equal(result.complete, false);
  assert.equal(result.watermark, 0);
  assert.equal(result.catalog?.passThrough, null);
  assert.equal(result.catalog?.complete, false);
  assert.equal(result.progress?.windowFrom, created);
  assert.equal(result.progress?.windowThrough, created);
  assert.equal(f.paths.length, 1);
  f.adopt(result);
  assert.equal(f.ledger().watermark, null);
});

Deno.test("CI reconciler preserves pending catalog rows and refuses changed authenticated identity", async () => {
  const f = readerFixture([catalogRun(1)]);
  f.rows[0].status = "queued";
  const first = await f.observe()("2028-01", f.now() + 60_000, f.ledger());
  assert.ok(first);
  assert.equal(first.complete, false);
  assert.equal(first.catalog?.runs[0].refreshRequired, true);
  f.adopt(first);
  const rejected = await f.observe(async (path) => {
    const value = await f.request(path);
    return /\/runs\/1$/.test(path)
      ? { ...value, head_sha: "b".repeat(40) }
      : value;
  })("2028-01", f.now() + 60_000, f.ledger());
  assert.ok(rejected);
  assert.equal(rejected.complete, false);
  assert.equal(rejected.catalog?.runs[0].head, HEAD);
  assert.equal(rejected.catalog?.runs[0].checkedAttempt, 0);
  assert.equal(f.ledger().watermark, null);
});

Deno.test("CI reconciler uses the tighter actual deadline and keeps incomplete private progress", async () => {
  const f = readerFixture([catalogRun(1)]);
  const deadline = f.now() + 3;
  const result = await f.observe(async (path) => {
    assert.ok(f.now() < deadline);
    f.advance(1);
    return await f.request(path);
  })("2028-01", deadline, f.ledger());
  assert.ok(result);
  assert.equal(result.complete, false);
  assert.ok(f.paths.length <= 3);
  assert.ok(result.progress);
  f.adopt(result);
  assert.equal(f.ledger().baselineMinutes, 1450);
  assert.equal(f.ledger().watermark, null);
  assert.equal(JSON.stringify(result).includes("fixture/project"), false);
  assert.match(ciMinuteDigest(result.catalog), /^[a-f0-9]{64}$/);
});
