/**
 * The v1 supported workflow shape (docs/backup-ci-spec.md §5): a synthetic
 * Passport-shaped workflow maps to exactly one unit; every refusal reason
 * has its own case; matrix names render the way GitHub renders them;
 * aliases, size and node bounds refuse; the expression allowlist, checkout
 * inputs, step conditions and `run:` references; root act configuration
 * files; and the tracked-source context scan, run with real `git grep`
 * against a temporary target repository.
 */
import assert from "node:assert/strict";
import {
  BACKUP_CI_CONTEXT_GREP,
  checkExpression,
  checkTemplate,
  runTextReference,
  stepCondition,
} from "../../ops/backup-ci-expressions.ts";
import {
  createBackupCiGit,
  fetchBackupCiBare,
} from "../../ops/backup-ci-materialize.ts";
import {
  backupCiExpected,
  parseBoundedYaml,
  planBackupCiJob,
  readBackupCiWorkflow,
  rootConfigFile,
} from "../../ops/backup-ci-workflow-map.ts";
import {
  PASSPORT_WORKFLOW,
  targetRepo,
  WORKFLOW_PATH,
} from "./backup-ci-test-repo.ts";

const enc = (text: string) => new TextEncoder().encode(text);
const read = (text: string, path = WORKFLOW_PATH, mode = "100644") =>
  readBackupCiWorkflow(path, mode, enc(text));
const plan = (text: string, name = "deno") => planBackupCiJob(read(text), name);
const reason = (text: string, name = "deno") => {
  const out = plan(text, name);
  return out.ok ? "supported" : out.reason;
};

/** A one-job workflow whose job body is `job` (indented under `deno:`). */
function job(body: string, top = ""): string {
  return `name: CI\non:\n  push:\n${top}jobs:\n  deno:\n${body}`;
}
const STEPS = `    steps:\n      - run: deno task check\n`;
const RUNS = `    runs-on: ubuntu-latest\n`;

Deno.test("a Passport-shaped workflow maps to exactly one unit", () => {
  const workflow = read(PASSPORT_WORKFLOW);
  assert(workflow.ok);
  assert.deepEqual(backupCiExpected(workflow), ["deno"]);
  assert.equal(workflow.name, "CI");
  const out = planBackupCiJob(workflow, "deno");
  assert(out.ok);
  assert.deepEqual(out.plan.job, {
    key: "deno",
    matrix: null,
    checkName: "deno",
    runsOn: "ubuntu-latest",
    capMinutes: 30,
    targetTimeoutMinutes: 30,
  });
  assert.deepEqual(out.plan.steps.map((s) => [s.index, s.actStepId, s.kind]), [
    [0, "0", "uses_remote"],
    [1, "1", "uses_remote"],
    [2, "2", "uses_remote"],
    [3, "3", "uses_remote"],
    [4, "4", "run"],
    [5, "5", "run"],
  ]);
  assert.deepEqual(out.plan.uses.remote, [
    "actions/checkout@v6.0.3",
    "actions/setup-node@v6",
    "denoland/setup-deno@v2",
    "oven-sh/setup-bun@v2",
  ]);
  assert(
    out.plan.steps.every((s) => s.condition === "none" && !s.continueOnError),
  );
});

Deno.test("an absent timeout caps the leg at 60 minutes", () => {
  const out = plan(job(RUNS + STEPS));
  assert(out.ok);
  assert.equal(out.plan.job.capMinutes, 60);
  assert.equal(out.plan.job.targetTimeoutMinutes, null);
});

const CASES: [string, string, string?][] = [
  ["workflow_unreadable", "name: [unterminated\n"],
  ["workflow_unreadable", job(RUNS + STEPS, "  weird: 1\nrun-on: x\n")],
  [
    "needs_or_job_if",
    job(RUNS + STEPS) + "  other:\n    needs: deno\n" + RUNS + STEPS,
  ],
  [
    "needs_or_job_if",
    job(RUNS + "    if: github.event_name == 'push'\n" + STEPS),
  ],
  [
    "reusable",
    job(RUNS + STEPS) +
    "  other:\n    uses: owner/repo/.github/workflows/x.yml@v1\n",
  ],
  ["runs_on", job("    runs-on: macos-latest\n" + STEPS)],
  ["runs_on", job("    runs-on: [ubuntu-latest]\n" + STEPS)],
  [
    "services",
    job(RUNS + "    services:\n      db:\n        image: postgres\n" + STEPS),
  ],
  ["container", job(RUNS + "    container: node:24\n" + STEPS)],
  ["environment", job(RUNS + "    environment: production\n" + STEPS)],
  [
    "matrix_shape",
    job(
      RUNS +
        "    strategy:\n      matrix:\n        os: [a]\n        include:\n          - os: b\n" +
        STEPS,
    ),
  ],
  [
    "matrix_shape",
    job(RUNS + "    strategy:\n      matrix: ${{ fromJSON(x) }}\n" + STEPS),
  ],
  [
    "matrix_shape",
    job(
      RUNS +
        "    strategy:\n      matrix:\n        a: [1, 2, 3, 4, 5]\n        b: [1, 2, 3, 4]\n" +
        STEPS,
    ),
  ],
  ["job_name", job("    name: deno ${{ github.ref }}\n" + RUNS + STEPS)],
  ["name_unmapped", job(RUNS + STEPS), "lint"],
  [
    "name_unmapped",
    job("    name: same\n" + RUNS + STEPS) + "  other:\n    name: same\n" +
    RUNS + STEPS,
    "same",
  ],
  ["timeout", job(RUNS + "    timeout-minutes: 400\n" + STEPS)],
  ["timeout", job(RUNS + "    timeout-minutes: ${{ 5 }}\n" + STEPS)],
  [
    "step_shape",
    job(RUNS + "    steps:\n      - run: a\n        uses: b/c@v1\n"),
  ],
  [
    "step_shape",
    job(RUNS + "    steps:\n      - run: a\n        surprise: 1\n"),
  ],
  ["step_shape", job(RUNS + "    continue-on-error: true\n" + STEPS)],
  [
    "step_condition",
    job(
      RUNS +
        "    steps:\n      - run: a\n        if: github.event_name == 'push'\n",
    ),
  ],
  [
    "expression_context",
    job(
      RUNS +
        "    steps:\n      - run: echo ${{ github.event.pull_request.title }}\n",
    ),
  ],
  [
    "expression_context",
    job(RUNS + "    steps:\n      - run: echo ${{ github.sha }}\n"),
  ],
  [
    "expression_context",
    job(RUNS + "    steps:\n      - run: echo ${{ github.head_ref }}\n"),
  ],
  [
    "expression_context",
    job(RUNS + "    steps:\n      - run: echo ${{ needs.x.outputs.y }}\n"),
  ],
  [
    "expression_context",
    job(RUNS + "    steps:\n      - run: echo ${{ env.ACT }}\n"),
  ],
  [
    "secrets_or_vars",
    job(RUNS + "    env:\n      KEY: ${{ secrets.KEY }}\n" + STEPS),
  ],
  [
    "secrets_or_vars",
    job(RUNS + "    steps:\n      - run: echo ${{ vars.X }}\n"),
  ],
  [
    "token",
    job(
      RUNS +
        "    steps:\n      - uses: some/action@v1\n        with:\n          token: ${{ github.token }}\n",
    ),
  ],
  [
    "checkout_inputs",
    job(
      RUNS +
        "    steps:\n      - uses: actions/checkout@v6\n        with:\n          ref: main\n",
    ),
  ],
  [
    "checkout_inputs",
    job(
      RUNS +
        "    steps:\n      - uses: actions/checkout@v6\n        with:\n          fetch-depth: 0\n",
    ),
  ],
  [
    "checkout_inputs",
    job(
      RUNS +
        "    steps:\n      - uses: actions/checkout@v6\n        with:\n          submodules: true\n",
    ),
  ],
  [
    "docker_action",
    job(RUNS + "    steps:\n      - uses: docker://alpine:3\n"),
  ],
  [
    "context_reference",
    job(RUNS + "    steps:\n      - run: echo $GITHUB_REF\n"),
  ],
  [
    "context_reference",
    job(RUNS + '    steps:\n      - run: test "$GITHUB_EVENT_NAME" = push\n'),
  ],
  [
    "context_reference",
    job(RUNS + "    steps:\n      - run: echo ${ACT:-no}\n"),
  ],
];

Deno.test("each unsupported reason refuses its own case", () => {
  for (const [expected, text, name] of CASES) {
    assert.equal(reason(text, name), expected, text);
  }
});

Deno.test("a workflow outside .github/workflows or not 100644 refuses", () => {
  assert.equal(
    reason(PASSPORT_WORKFLOW),
    "supported",
  );
  const sub = read(PASSPORT_WORKFLOW, ".github/workflows/sub/ci.yml");
  assert(!sub.ok && sub.reason === "workflow_path");
  const exec = read(PASSPORT_WORKFLOW, WORKFLOW_PATH, "100755");
  assert(!exec.ok && exec.reason === "workflow_unreadable");
  const link = read(PASSPORT_WORKFLOW, WORKFLOW_PATH, "120000");
  assert(!link.ok && link.reason === "workflow_unreadable");
});

Deno.test("more than 64 rendered names is a coverage refusal", () => {
  const jobs = Array.from(
    { length: 5 },
    (_, i) =>
      `  j${i}:\n${RUNS}    strategy:\n      matrix:\n        a: [1, 2, 3, 4]\n        b: [1, 2, 3, 4]\n${STEPS}`,
  ).join("");
  const workflow = read(`name: CI\non: push\njobs:\n${jobs}`);
  assert(!workflow.ok && workflow.reason === "coverage");
});

Deno.test("matrix names render as GitHub renders them, uniquely", () => {
  const text = `name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 24]
        flag: [true]
${STEPS}  lint:
    name: lint on \${{ matrix.os }}
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [linux, mac]
${STEPS}`;
  const workflow = read(text);
  assert(workflow.ok);
  assert.deepEqual(backupCiExpected(workflow), [
    "test (20, true)",
    "test (24, true)",
    "lint on linux",
    "lint on mac",
  ]);
  const out = planBackupCiJob(workflow, "test (24, true)");
  assert(out.ok);
  assert.deepEqual(out.plan.job.matrix, { node: 24, flag: true });
  const lint = planBackupCiJob(workflow, "lint on mac");
  assert(lint.ok && lint.plan.job.matrix?.os === "mac");
});

Deno.test("aliases, oversize and node bounds refuse the workflow", () => {
  assert.equal(parseBoundedYaml(enc("a: &x [1, 2]\nb: *x\n")), null);
  assert.equal(parseBoundedYaml(enc("a: 1\na: 2\n")), null);
  assert.equal(parseBoundedYaml(enc("a: !!binary aGk=\n")), null);
  assert.equal(parseBoundedYaml(enc(`a: "${"x".repeat(300 * 1024)}"\n`)), null);
  const wide = `a: [${Array.from({ length: 25_000 }, () => "1").join(", ")}]\n`;
  assert.equal(parseBoundedYaml(enc(wide)), null);
  assert.deepEqual(parseBoundedYaml(enc("on: push\n")), { on: "push" });
  const aliased = job(RUNS + "    steps: &s\n      - run: a\n") +
    "  other:\n" + RUNS + "    steps: *s\n";
  const workflow = read(aliased);
  assert(!workflow.ok && workflow.reason === "workflow_unreadable");
});

Deno.test("the expression allowlist", () => {
  const ok = [
    "matrix.os",
    "steps.build.outputs.path",
    "steps.build.outcome",
    "env.HOME_DIR",
    "runner.temp",
    "github.workspace",
    "github.run_attempt",
    "strategy.job-index",
    "job.status",
    "format('{0}-{1}', matrix.os, 'x')",
    "hashFiles('**/bun.lock')",
    "fromJSON('[1]')[0] == 1 && contains('ab', 'a')",
    "'}}' == 'x'",
  ];
  for (const body of ok) assert.equal(checkExpression(body), null, body);
  const refused: [string, string][] = [
    ["secrets.X", "secrets_or_vars"],
    ["vars.X", "secrets_or_vars"],
    ["github.token", "token"],
    ["GitHub.Token", "token"],
    ["github.event_name", "expression_context"],
    ["github.event.after", "expression_context"],
    ["github.ref", "expression_context"],
    ["github.ref_name", "expression_context"],
    ["github.actor", "expression_context"],
    ["github.triggering_actor", "expression_context"],
    ["github.base_ref", "expression_context"],
    ["inputs.x", "expression_context"],
    ["env.GITHUB_REF", "expression_context"],
    ["steps.*.outcome", "expression_context"],
    ["matrix[github.ref]", "expression_context"],
    ["always()", "expression_context"],
    ["toJSON(github)", "expression_context"],
    ["unknown('x')", "expression_context"],
  ];
  for (const [body, expected] of refused) {
    assert.equal(checkExpression(body), expected, body);
  }
  assert.equal(checkTemplate("a ${{ matrix.os }} b ${{ runner.os }}"), null);
  assert.equal(checkTemplate("${{ format('}}', matrix.a) }}"), null);
  assert.equal(checkTemplate("${{ matrix.os"), "expression_context");
  assert.equal(
    checkTemplate("${{ github.ref }} ${{ secrets.K }}"),
    "secrets_or_vars",
  );
});

Deno.test("step conditions are absent or status functions only", () => {
  assert.equal(stepCondition(undefined), "none");
  for (
    const ok of [
      "always()",
      "${{ !cancelled() }}",
      "success() || failure()",
      "!(failure() && cancelled())",
    ]
  ) {
    assert.equal(stepCondition(ok), "status_only", ok);
  }
  for (
    const bad of [
      true,
      "",
      "github.ref == 'x'",
      "always() && github.actor",
      "always(",
      "${{ always() }} && x",
    ]
  ) {
    assert.equal(stepCondition(bad), null, String(bad));
  }
});

Deno.test("run text references of events, refs, actors and ACT", () => {
  for (
    const bad of [
      "echo $GITHUB_EVENT_PATH",
      "x=${GITHUB_HEAD_REF}",
      "printenv ACT",
      '[ -n "$ACT" ]',
      "echo $GITHUB_TOKEN",
    ]
  ) {
    assert.equal(runTextReference(bad), true, bad);
  }
  for (
    const ok of [
      "echo $ACTION",
      "ACTUALLY=1",
      "echo $GITHUB_WORKSPACE",
      "echo $MY_GITHUB_REF_X",
    ]
  ) {
    assert.equal(runTextReference(ok), false, ok);
  }
});

Deno.test("checkout keeps only default inputs", () => {
  const checkout = (w: string) =>
    reason(
      job(
        RUNS +
          `    steps:\n      - uses: actions/checkout@v6\n        with:\n${w}`,
      ),
    );
  assert.equal(
    checkout(
      "          persist-credentials: false\n          fetch-depth: 1\n          lfs: false\n",
    ),
    "supported",
  );
  assert.equal(checkout("          token: abc\n"), "checkout_inputs");
  assert.equal(checkout("          path: sub\n"), "checkout_inputs");
});

Deno.test("status-only step conditions and continue-on-error are planned", () => {
  const out = plan(
    job(
      RUNS +
        "    steps:\n      - id: a\n        run: x\n        continue-on-error: true\n      - run: y\n        if: always()\n",
    ),
  );
  assert(out.ok);
  assert.deepEqual(
    out.plan.steps.map((s) => [s.actStepId, s.condition, s.continueOnError]),
    [["a", "none", true], ["1", "status_only", false]],
  );
  assert.equal(
    reason(
      job(
        RUNS + "    steps:\n      - id: '1'\n        run: x\n      - run: y\n",
      ),
    ),
    "step_shape",
  );
});

Deno.test("act configuration files at the root are refused", () => {
  for (const name of [".actrc", ".env", ".secrets", ".vars", ".input"]) {
    assert.equal(rootConfigFile(["src", name]), true, name);
  }
  assert.equal(rootConfigFile(["src", ".env.example", "package.json"]), false);
});

Deno.test("the tracked-source context scan runs git grep at the commit", async () => {
  const repo = await targetRepo("backup-ci-grep-");
  try {
    const clean = await repo.commit({
      [WORKFLOW_PATH]: PASSPORT_WORKFLOW + "      - run: echo $GITHUB_REF\n",
      "src/a.ts":
        "const action = process.env.ACTION;\nconst ws = Deno.env.get('GITHUB_WORKSPACE');\n",
      "scripts/build.sh": "echo $GITHUB_REF_X\n",
    });
    const cases: [string, string][] = [
      ["src/b.ts", "if (process.env.ACT) skip();\n"],
      ["src/c.ts", 'const r = Deno.env.get("GITHUB_REF");\n'],
      ["scripts/x.sh", "echo ${GITHUB_HEAD_REF}\n"],
      ["tools/y.py", "os.getenv('GITHUB_EVENT_NAME')\n"],
      ["src/d.js", "const n = process.env['GITHUB_REF_NAME'];\n"],
    ];
    const dirty: string[] = [];
    for (const [path, text] of cases) {
      dirty.push(
        await repo.commit({ [path]: text }, { parent: clean as never }),
      );
    }
    const git = createBackupCiGit(`${repo.root}/home`);
    for (const [i, commit] of [clean, ...dirty].entries()) {
      const bare = await fetchBackupCiBare({
        git,
        dir: `${repo.root}/bare-${i}/bare`,
        remoteUrl: repo.url,
        token: null,
        commits: [commit as never],
        protocols: ["file"],
      });
      assert(bare !== null);
      const files = (await bare.listFiles(commit as never))!.filter((f) =>
        !f.startsWith(".github/workflows/")
      );
      const hit = await bare.grep(
        commit as never,
        BACKUP_CI_CONTEXT_GREP,
        files,
      );
      assert.equal(hit, i > 0, `commit ${i}`);
    }
  } finally {
    await repo.close();
  }
});
