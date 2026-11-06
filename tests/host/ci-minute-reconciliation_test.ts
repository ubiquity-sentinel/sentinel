import assert from "node:assert/strict";
import { readCiMinuteWindow } from "../../ops/hosted-autonomy-github-jobs.ts";
import { ciJobMinutes } from "../../src/contracts/ci-minute-budget.ts";

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

Deno.test("CI observed started-zero shape: positive runner and497s cannot credit timing zero", async () => {
  const result = await readCiMinuteWindow({
    ...base,
    request: async (path) => {
      await Promise.resolve();
      if (path.includes("actions/runs?")) {
        return { total_count: 1, workflow_runs: [run(7)] };
      }
      if (path.endsWith("/timing")) {
        return timing([{ job_id: 71, duration_ms: 0 }]);
      }
      return { total_count: 1, jobs: [job(71, 7, 1, 497)] };
    },
  });
  assert.equal(result.complete, false);
  assert.equal(result.reason, "billing_job_binding");
  assert.equal(result.jobs.length, 0);
});
