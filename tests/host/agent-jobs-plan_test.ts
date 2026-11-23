import assert from "node:assert/strict";
import { pinAgentJobsPlan } from "../../ops/agent-jobs-admission.ts";
import { runAgentJobsCell } from "../../ops/agent-jobs-cell.ts";
import { gitOk } from "../../ops/agent-jobs-git.ts";
import {
  freshAgentJobRequests,
  readAgentJobsPushRequests,
} from "../../ops/agent-jobs-intake.ts";
import {
  mergeAgentJobRequests,
  planAgentJobs,
} from "../../ops/agent-jobs-plan.ts";

const job = (extra = {}) => ({
  id: "one",
  repository: "owner/target",
  prompt: "Update README",
  ...extra,
});

Deno.test("agent job plan defaults to review and rejects caller-supplied trust fields", () => {
  assert.equal(planAgentJobs([job()]).cells[0].jobs[0].review, true);
  assert.equal(
    planAgentJobs([job({ review: false })]).cells[0].jobs[0].review,
    false,
  );
  assert.throws(
    () => planAgentJobs([job({ review: "false" })]),
    /review must be a boolean/,
  );
  assert.throws(
    () => planAgentJobs([job({ baseSha: "a".repeat(40) })]),
    /unknown job field/,
  );
  assert.throws(
    () => planAgentJobs({ jobs: [job()], createdAtMs: 1 }),
    /unknown request field/,
  );
  assert.throws(
    () => mergeAgentJobRequests([{ jobs: [job()], createdAtMs: 1 }]),
    /unknown request field/,
  );
  assert.throws(
    () => planAgentJobs([job({ prompt: "a".repeat(16_385) })]),
    /task receipt text bounds/,
  );
  assert.throws(
    () => planAgentJobs([job({ prompt: "a\r", review: false })]),
    /task receipt text bounds/,
  );
});

Deno.test("agent jobs admit an exact public repo and branch SHA before dispatch", async () => {
  const sha = "a".repeat(40);
  const plan = planAgentJobs([job(), job({ id: "two", base: "work/main" })]);
  const urls: string[] = [];
  const read = (url: string, init: RequestInit): Promise<Response> => {
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).has("authorization"), false);
    urls.push(url);
    return Promise.resolve(Response.json(
      url.endsWith("/branches/work%2Fmain")
        ? { name: "work/main", commit: { sha } }
        : {
          full_name: "Owner/Target",
          default_branch: "work/main",
          private: false,
          visibility: "public",
        },
    ));
  };
  const pinned = await pinAgentJobsPlan(plan, 100, read);
  assert.equal(pinned.createdAtMs, 100);
  assert.deepEqual(
    pinned.cells.flatMap((cell) =>
      cell.jobs.map(({ base, baseSha }) => ({
        base,
        baseSha,
      }))
    ),
    [
      { base: "work/main", baseSha: sha },
      { base: "work/main", baseSha: sha },
    ],
  );
  assert.deepEqual(urls, [
    "https://api.github.com/repos/owner/target",
    "https://api.github.com/repos/owner/target/branches/work%2Fmain",
  ]);
  for (
    const data of [
      { full_name: "owner/target", private: true },
      { full_name: "owner/target", visibility: "internal", private: false },
      { full_name: "different/target", private: false },
      { full_name: "owner/target" },
    ]
  ) {
    await assert.rejects(
      pinAgentJobsPlan(plan, 100, () =>
        Promise.resolve(Response.json({
          default_branch: "main",
          ...data,
        }))),
      /target is unavailable or not public/,
    );
  }
});

async function commit(cwd: string): Promise<string> {
  await gitOk(["add", "--all"], { cwd });
  await gitOk(["commit", "--quiet", "-m", "fixture"], { cwd });
  return await gitOk(["rev-parse", "HEAD"], { cwd });
}

Deno.test("agent jobs consume fresh files across a push and refuse old or unrelated intake", async () => {
  const cwd = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: ".agent-jobs-intake-",
  });
  try {
    await gitOk(["init", "--quiet", "-b", "development"], { cwd });
    for (const dir of ["inbox", "cleanup"]) {
      await Deno.mkdir(cwd + "/jobs/" + dir, { recursive: true });
    }
    const old = cwd + "/jobs/inbox/old.json";
    const restored = cwd + "/jobs/inbox/restored.json";
    await Deno.writeTextFile(old, "{}");
    await Deno.writeTextFile(restored, "{}");
    await commit(cwd);
    await Deno.remove(restored);
    const before = await commit(cwd);
    await Deno.writeTextFile(
      cwd + "/jobs/inbox/early.json",
      '{"event": "early"}',
    );
    await commit(cwd);
    await Deno.writeTextFile(old, "[]");
    await Deno.writeTextFile(restored, "{}");
    await Deno.writeTextFile(cwd + "/jobs/inbox/late.json", "{}");
    await Deno.writeTextFile(cwd + "/jobs/cleanup/cleanup.json", "{}");
    const after = await commit(cwd);
    await Deno.writeTextFile(
      cwd + "/jobs/inbox/early.json",
      "uncommitted contents",
    );
    assert.deepEqual(
      await readAgentJobsPushRequests(
        "inbox",
        { before, after, ref: "refs/heads/development" },
        after,
        cwd,
      ),
      [{ event: "early" }, {}],
    );
    assert.deepEqual(
      await freshAgentJobRequests("inbox", before, after, after, cwd),
      [
        "jobs/inbox/early.json",
        "jobs/inbox/late.json",
      ],
    );
    assert.deepEqual(
      await freshAgentJobRequests("cleanup", before, after, after, cwd),
      [
        "jobs/cleanup/cleanup.json",
      ],
    );
    await assert.rejects(
      freshAgentJobRequests("inbox", "0".repeat(40), after, after, cwd),
    );
    await assert.rejects(
      freshAgentJobRequests("inbox", before, after, before, cwd),
    );
    assert.deepEqual(
      await freshAgentJobRequests("inbox", after, after, after, cwd),
      [],
    );
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("agent job cell starts at the admitted base after the branch advances", async () => {
  const cwd = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: ".agent-jobs-base-",
  });
  try {
    await gitOk(["init", "--quiet", "-b", "main"], { cwd });
    await Deno.writeTextFile(cwd + "/README.md", "pinned");
    const pinned = await commit(cwd);
    await Deno.writeTextFile(cwd + "/README.md", "advanced");
    const advanced = await commit(cwd);
    assert.notEqual(pinned, advanced);
    const plan = planAgentJobs([job({ base: "main" })]);
    plan.cells[0].jobs[0].baseSha = pinned;
    const result = await runAgentJobsCell({
      plan,
      cellId: plan.cells[0].cellId,
      workRoot: cwd + "/working",
      outDir: cwd + "/out",
      readToken: null,
      defaultModel: "fixture",
      deadlineAtMs: Date.now() + 30_000,
      ports: {
        remoteUrl: () => cwd,
        agentCommand: () => [
          "bash",
          "-c",
          'cat >/dev/null; test "$(cat README.md)" = pinned',
        ],
        agentEnv: () => ({ PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" }),
        prepareClient: () => Promise.resolve(),
        sleep: () => Promise.resolve(),
        log: () => {},
      },
    });
    assert.equal(
      result.results[0].status,
      "no_changes",
      JSON.stringify(result.results[0]),
    );
    assert.equal(result.results[0].baseSha, pinned);
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("admitted agent job charges setup, stagger and retry time to one deadline", async () => {
  const cwd = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: ".agent-jobs-deadline-",
  });
  try {
    await gitOk(["init", "--quiet", "-b", "main"], { cwd });
    await Deno.writeTextFile(cwd + "/README.md", "fixture");
    const baseSha = await commit(cwd);
    for (const stage of ["checkout", "setup", "stagger", "retry"] as const) {
      const plan = planAgentJobs([
        job({ id: "first", base: "main" }),
        job({
          id: "second",
          base: "main",
          minutes: 2,
          setup: ["touch setup-ran"],
        }),
      ]);
      plan.createdAtMs = 100_000;
      const cell = plan.cells[1];
      cell.jobs[0].baseSha = baseSha;
      const root = cwd + "/" + stage;
      let now = stage === "checkout" ? 187_000 : 140_000;
      let clones = 0;
      let preparations = 0;
      let attempts = 0;
      const delays: number[] = [];
      const result = await runAgentJobsCell({
        plan,
        cellId: cell.cellId,
        workRoot: root,
        outDir: root + "/out",
        readToken: null,
        defaultModel: "fixture",
        deadlineAtMs: 400_000,
        ports: {
          now: () => now,
          remoteUrl: () => {
            clones++;
            return cwd;
          },
          agentEnv: () => {
            if (stage === "setup") now = 221_000;
            return { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" };
          },
          prepareClient: () => {
            preparations++;
            return Promise.resolve();
          },
          sleep: (seconds) => {
            delays.push(seconds);
            now += seconds * 1000;
            if (stage === "stagger" || seconds === 15) now = 221_000;
            return Promise.resolve();
          },
          agentCommand: () => {
            attempts++;
            return [
              "bash",
              "-c",
              'cat >/dev/null; echo "stream disconnected before completion" >&2; exit 1',
            ];
          },
          log: () => {},
        },
      });
      assert.equal(result.results[0].status, "timed_out", stage);
      assert.equal(clones, stage === "checkout" ? 0 : 1, stage);
      assert.equal(preparations, stage === "retry" ? 1 : 0, stage);
      assert.equal(attempts, stage === "retry" ? 1 : 0, stage);
      assert.deepEqual(
        delays,
        stage === "retry" ? [3, 15] : stage === "stagger" ? [3] : [],
        stage,
      );
      if (stage === "setup") {
        await assert.rejects(
          Deno.stat(root + "/second/checkout/setup-ran"),
          Deno.errors.NotFound,
        );
      }
    }
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});
