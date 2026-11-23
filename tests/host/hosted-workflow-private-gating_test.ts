/**
 * Free-tier gating of the private deployment (docs/DECISIONS.md, 2026-11-22).
 * Every automatically triggered job is gated to the public repository by
 * prefixing `github.repository == 'ubiquity-sentinel/sentinel' &&` to its
 * former condition (or adding only that condition where there was none). On
 * the public repository the prefix is `true`, so `true && (X)` is exactly X:
 * the same jobs run on the same triggers. The private repository runs only
 * the daily cycle and the weekly sync, which the public one skips.
 */
import assert from "node:assert/strict";
import { parse } from "@std/yaml";

type Obj = Record<string, unknown>;
const PUBLIC = "github.repository == 'ubiquity-sentinel/sentinel'";
const PRIVATE = "github.repository == 'ubiquity-sentinel-private/sentinel'";

async function workflow(name: string): Promise<Obj> {
  return parse(await Deno.readTextFile(`.github/workflows/${name}`)) as Obj;
}
function jobs(doc: Obj): Record<string, Obj> {
  return doc.jobs as Record<string, Obj>;
}
function steps(job: Obj): Obj[] {
  return job.steps as Obj[];
}
const flat = (text: unknown) => String(text).replace(/\s+/g, " ").trim();
const PRIVATE_CI =
  "(github.event_name == 'push' && github.ref == 'refs/heads/development')";

// Today's (pre-gating) condition of every automatically triggered job;
// `null` where the job had none.
const FORMER: readonly (readonly [string, string, string | null])[] = [
  ["release.yml", "release", null],
  ["sentinel-scheduler.yml", "tick", null],
  ["gateway-source-verify.yml", "verify", null],
  ["repair.yml", "dispatch", null],
  [
    "supervisor-dispatch.yml",
    "backup_completion",
    "github.event_name == 'workflow_run' && " +
    "(github.event.workflow_run.path == '.github/workflows/backup-ci-leg.yml' || " +
    "github.event.workflow_run.path == '.github/workflows/ci.yml') && " +
    "github.event.workflow_run.head_repository.full_name == github.repository",
  ],
  [
    "supervisor-dispatch.yml",
    "dispatch",
    "(github.event_name != 'workflow_run' || " +
    "(github.event.workflow_run.path == '.github/workflows/supervisor.yml' && " +
    "github.event.workflow_run.head_branch == 'sentinel-supervisor' && " +
    "github.event.workflow_run.head_repository.full_name == github.repository))",
  ],
  [
    "backup-ci.yml",
    "backup_ci",
    "github.ref == 'refs/heads/sentinel-supervisor' && github.run_attempt == 1 && " +
    "(contains(fromJSON('[\"shadow\",\"on\"]'), vars.SENTINEL_BACKUP_CI || 'on'))",
  ],
  [
    "backup-ci-leg.yml",
    "leg",
    "github.ref == 'refs/heads/sentinel-backup-legs' && github.run_attempt == 1 && " +
    'contains(fromJSON(\'["ubuntu-latest","ubuntu-24.04","ubuntu-22.04"]\'), inputs.runs_on)',
  ],
];

Deno.test("private gating: every automatic job is today's condition behind the public-repository prefix", async () => {
  for (const [file, job, former] of FORMER) {
    const condition = flat(jobs(await workflow(file))[job].if);
    assert.equal(
      condition,
      former === null ? PUBLIC : `${PUBLIC} && ${former}`,
      `${file} ${job}`,
    );
  }
  // ci.yml: on public `true || ...` (unchanged: no condition before, and
  // the aggregate keeps always()); on private only a push to development.
  const ci = jobs(await workflow("ci.yml"));
  for (const job of ["quality", "test-shards"]) {
    assert.equal(flat(ci[job].if), `${PUBLIC} || ${PRIVATE_CI}`, job);
  }
  assert.equal(
    flat(ci["test-local"].if),
    `\${{ always() && (${PUBLIC} || ${PRIVATE_CI}) }}`,
  );
  // Already public-only before this change.
  assert.ok(
    flat(jobs(await workflow("queue-canary.yml")).canary.if).startsWith(
      PUBLIC + " &&",
    ),
  );
});

Deno.test("private gating: every scheduled, push and workflow_run workflow is gated or private-only", async () => {
  const automatic = new Set([
    "schedule",
    "push",
    "pull_request",
    "workflow_run",
  ]);
  for await (const entry of Deno.readDir(".github/workflows")) {
    if (!entry.name.endsWith(".yml")) continue;
    const doc = await workflow(entry.name);
    const on = (doc.on ?? doc[true as unknown as string]) as Obj;
    if (!Object.keys(on).some((trigger) => automatic.has(trigger))) continue;
    for (const [name, job] of Object.entries(jobs(doc))) {
      const condition = flat(job.if);
      assert.ok(
        condition.startsWith(PUBLIC) || condition === PRIVATE ||
          condition === `\${{ always() && (${PUBLIC} || ${PRIVATE_CI}) }}`,
        `${entry.name} ${name}: ${condition}`,
      );
    }
  }
});

Deno.test("private gating: the chain continues on the public deployment only", async () => {
  const finalize = jobs(await workflow("supervisor.yml")).finalize;
  const chain = steps(finalize).find((step) =>
    step.name === "Chain the next dispatcher run"
  )!;
  assert.equal(
    flat(chain.if),
    `always() && github.ref == 'refs/heads/sentinel-supervisor' && ${PUBLIC}`,
  );
  assert.equal(
    flat(finalize.if),
    "always() && github.ref == 'refs/heads/sentinel-supervisor'",
  );
});

Deno.test("private gating: only the matrix cell's timeout differs by repository, and it is 300 on public", async () => {
  const supervisor = jobs(await workflow("supervisor.yml"));
  assert.equal(
    supervisor.matrix_cell["timeout-minutes"],
    `\${{ ${PRIVATE} && 120 || 300 }}`,
  );
  // On public `false && 120 || 300` is 300 (today's value); every other
  // runtime job already stops at 120, past the runtime's 110-minute window.
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(supervisor).map(([name, job]) => [
        name,
        job["timeout-minutes"],
      ]).filter(([name]) => name !== "matrix_cell"),
    ),
    {
      maintenance: 15,
      prepare: 10,
      matrix_plan: 120,
      repair_cell: 120,
      repair: 120,
      finalize: 10,
    },
  );
});

Deno.test("private gating: each self mint names its own organization and only the repository sentinel", async () => {
  const owner =
    "${{ github.repository == 'ubiquity-sentinel-private/sentinel'" +
    " && 'ubiquity-sentinel-private' || 'ubiquity-sentinel' }}";
  let selfMints = 0;
  for (const job of Object.values(jobs(await workflow("supervisor.yml")))) {
    for (const step of steps(job)) {
      const given = step.with as Obj | undefined;
      if (step.name !== "Mint the scoped self installation token") continue;
      selfMints++;
      // The expression is a closed choice of two non-empty literals, and the
      // repository list stays the literal name: no mint can ever name every
      // repository of an installation.
      assert.equal(given?.owner, owner);
      assert.equal(given?.repositories, "sentinel");
    }
  }
  assert.equal(selfMints, 7);
});

Deno.test("private gating: the daily cycle and the weekly sync run on the private repository only", async () => {
  const daily = await workflow("private-daily.yml");
  assert.deepEqual(Object.keys(daily.on as Obj).sort(), [
    "schedule",
    "workflow_dispatch",
  ]);
  assert.deepEqual((daily.on as Obj).schedule, [{ cron: "41 3 * * *" }]);
  const day = jobs(daily).daily;
  assert.equal(day.if, PRIVATE);
  assert.equal(day["timeout-minutes"], 3);
  const [, , binding, start] = steps(day);
  // Unfilled ids end the day green with no follow-on step; any other
  // refusal stays red.
  assert.equal(binding.id, "binding");
  const bind = String(binding.run);
  assert.match(bind, /src\/contracts\/hosted-controller-deployment\.ts/);
  assert.match(
    bind,
    /grep -q "hosted controller binding refused: workflow_ids_unfilled"/,
  );
  assert.match(bind, /echo "ready=false" >> "\$GITHUB_OUTPUT"\n/);
  assert.match(bind, /exit 1\n/);
  assert.equal(start.if, "steps.binding.outputs.ready == 'true'");
  const run = String(start.run);
  // Once a UTC day, only a launcher with its own green test-local, and only
  // below 1,800 billed minutes this month; each guard exits 0.
  const order = [
    /created=%3E%3D\$today/,
    /check_name=test-local&filter=latest/,
    /if \[ "\$used" -ge 1800 \]; then/,
    /gh workflow run supervisor\.yml --repo "\$GH_REPO" --ref sentinel-supervisor/,
  ].map((pattern) => run.search(pattern));
  assert.ok(order.every((at) => at >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  // One exit, green, for every stop; a listing is captured before any loop
  // or sum uses it (a failed read stops the day: private-daily-guard_test).
  assert.equal((run.match(/exit 0/g) ?? []).length, 1);
  assert.match(run, /none\(\) \{\n\s+echo "no cycle today: \$1"\n\s+exit 0\n/);
  assert.doesNotMatch(run, /exit 1/);
  assert.doesNotMatch(run, /for \w+ in \$\(/);
  assert.equal((run.match(/\) \|\| none "/g) ?? []).length, 5);

  const sync = await workflow("private-sync.yml");
  assert.deepEqual((sync.on as Obj).schedule, [{ cron: "17 2 * * 0" }]);
  const job = jobs(sync).sync;
  assert.equal(job.if, PRIVATE);
  // Repository secret, no environment (one instruction for the operator).
  assert.equal(job.environment, undefined);
  const [mint, move] = steps(job);
  assert.deepEqual(mint.with, {
    "client-id": "Iv23liHUJNXds9mU3j7Q",
    "private-key": "${{ secrets.SENTINEL_SUPERVISOR_APP_PRIVATE_KEY }}",
    owner: "ubiquity-sentinel-private",
    repositories: "sentinel",
    "permission-contents": "write",
    "permission-workflows": "write",
  });
  const script = String(move.run);
  assert.match(
    script,
    /fetch -q --no-tags https:\/\/github\.com\/ubiquity-sentinel\/sentinel\.git refs\/heads\/sentinel-supervisor/,
  );
  assert.match(script, /merge-base --is-ancestor "\$current" "\$target"/);
  assert.match(script, /push --atomic -q "\$private" "\$\{moves\[@\]\}"/);
  // Never forced, never another repository.
  assert.doesNotMatch(script, /--force|\+refs|"\+/);
  assert.match(
    script,
    /private="https:\/\/github\.com\/\$\{GITHUB_REPOSITORY\}\.git"/,
  );
});
