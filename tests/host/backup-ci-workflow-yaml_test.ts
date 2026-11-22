/**
 * Structural checks of the backup CI workflows (docs/backup-ci-spec.md §8,
 * §13): the leg has no environment and no secret and exactly
 * `{contents: read, actions: read}`; `backup_ci` and the leg are guarded by
 * ref and attempt; every action is pinned by full SHA; nothing restores a
 * cache at sentinel-supervisor or in the legs; no `run:` interpolates
 * inputs or step outputs; the leg's steps carry the ingest's names in
 * order; the dispatcher step exists; the four supervisor steps bind and
 * allow `SENTINEL_BACKUP_CI`; and the targets file is a subset of the
 * committed targets with ids, the self target excluded.
 */
import assert from "node:assert/strict";
import { parse } from "@std/yaml";
import {
  BACKUP_CI_LEG_STEPS,
  parseBackupCiTargets,
} from "../../src/contracts/backup-ci.ts";
import {
  backupCiRunnerId,
  parseBackupCiPins,
} from "../../ops/backup-ci-act.ts";
import { parseTargetSlugsV1 } from "../../src/host/targets.ts";

type Obj = Record<string, unknown>;

async function workflow(name: string): Promise<Obj> {
  return parse(await Deno.readTextFile(`.github/workflows/${name}`), {
    schema: "core",
  }) as Obj;
}
const jobs = (w: Obj) => w.jobs as Record<string, Obj>;
const steps = (job: Obj) => job.steps as Obj[];
const allSteps = (w: Obj) =>
  Object.values(jobs(w)).flatMap((j) => steps(j) ?? []);
const PINNED =
  /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._/-]+)?@[0-9a-f]{40}$/;

Deno.test("the leg holds no environment, no secret and read-only permissions", async () => {
  const text = await Deno.readTextFile(".github/workflows/backup-ci-leg.yml");
  const leg = await workflow("backup-ci-leg.yml");
  assert.deepEqual(leg.permissions, {});
  assert.deepEqual(Object.keys(leg.on as Obj), ["workflow_dispatch"]);
  const job = jobs(leg).leg;
  assert.equal(Object.keys(jobs(leg)).length, 1);
  assert.equal("environment" in job, false);
  assert.deepEqual(job.permissions, { contents: "read", actions: "read" });
  assert(!/secrets\./.test(text), "no secrets.* in the leg");
  assert.equal(leg["run-name"], "sentinel-backup-ci-leg ${{ inputs.unit }}");
  const names = steps(job).map((s) => s.name).filter((n) =>
    typeof n === "string"
  );
  let at = 0;
  for (const name of BACKUP_CI_LEG_STEPS) {
    const index = names.indexOf(name, at);
    assert(index >= at, name);
    at = index + 1;
  }
});

Deno.test("backup_ci and the leg are guarded by ref and attempt", async () => {
  const trusted = jobs(await workflow("backup-ci.yml")).backup_ci;
  const guard = String(trusted.if);
  assert(guard.includes("github.ref == 'refs/heads/sentinel-supervisor'"));
  assert(guard.includes("github.run_attempt == 1"));
  assert(
    guard.includes(
      "contains(fromJSON('[\"shadow\",\"on\"]'), vars.SENTINEL_BACKUP_CI || 'on')",
    ),
  );
  assert.deepEqual(trusted.environment, { name: "sentinel-supervisor" });
  assert.deepEqual(trusted.permissions, {
    contents: "write",
    actions: "write",
  });
  const leg = String(jobs(await workflow("backup-ci-leg.yml")).leg.if);
  assert(leg.includes("github.ref == 'refs/heads/sentinel-backup-legs'"));
  assert(leg.includes("github.run_attempt == 1"));
  const w = await workflow("backup-ci.yml");
  assert.deepEqual(w.permissions, {});
  assert.deepEqual(w.concurrency, {
    group: "sentinel-backup-ci",
    "cancel-in-progress": false,
  });
});

Deno.test("every action of the backup workflows is pinned by full SHA", async () => {
  for (
    const name of [
      "backup-ci.yml",
      "backup-ci-leg.yml",
      "supervisor-dispatch.yml",
    ]
  ) {
    for (const step of allSteps(await workflow(name))) {
      const uses = step.uses;
      if (typeof uses !== "string" || uses.startsWith("./")) continue;
      assert.match(uses, PINNED, `${name}: ${uses}`);
    }
  }
});

Deno.test("nothing restores a cache at sentinel-supervisor or in the legs", async () => {
  for (const name of ["backup-ci.yml", "backup-ci-leg.yml", "supervisor.yml"]) {
    for (const step of allSteps(await workflow(name))) {
      const uses = String(step.uses ?? "");
      assert(!/^actions\/cache(\/|@)/.test(uses), `${name}: ${uses}`);
      const inputs = (step.with ?? {}) as Obj;
      for (const key of Object.keys(inputs)) {
        assert(
          !/cache/.test(key) || key === "no-cache",
          `${name}: ${uses} ${key}`,
        );
      }
      if (uses.startsWith("oven-sh/setup-bun@")) {
        assert.equal(inputs["no-cache"], true, `${name}: setup-bun no-cache`);
      }
    }
  }
});

Deno.test("no run: script interpolates inputs or step outputs", async () => {
  for (const name of ["backup-ci.yml", "backup-ci-leg.yml"]) {
    for (const step of allSteps(await workflow(name))) {
      if (typeof step.run !== "string") continue;
      assert(
        !/\$\{\{[^}]*(inputs\.|steps\.|github\.event)/.test(step.run),
        `${name}: ${step.run}`,
      );
    }
  }
  const dispatch = allSteps(await workflow("supervisor-dispatch.yml")).find((
    s,
  ) => s.name === "Dispatch the backup CI pass")!;
  assert(!String(dispatch.run).includes("${{"));
});

Deno.test("the dispatcher dispatches the pass only in shadow or on (unset is on)", async () => {
  const step = allSteps(await workflow("supervisor-dispatch.yml")).find((s) =>
    s.name === "Dispatch the backup CI pass"
  );
  assert(step !== undefined);
  assert.equal(
    step.if,
    "contains(fromJSON('[\"shadow\",\"on\"]'), vars.SENTINEL_BACKUP_CI || 'on')",
  );
  assert.equal(step["continue-on-error"], true);
  assert.equal(
    step.run,
    "gh workflow run backup-ci.yml --ref sentinel-supervisor",
  );
  assert.deepEqual(step.env, {
    GH_TOKEN: "${{ github.token }}",
    GH_REPO: "${{ github.repository }}",
  });
});

Deno.test("the four supervisor steps bind and allow SENTINEL_BACKUP_CI", async () => {
  const supervisor = await workflow("supervisor.yml");
  const wanted: [string, string][] = [
    [
      "maintenance",
      "Run hosted autonomy (retry transient failures, deliver reviewed heads)",
    ],
    ["matrix_plan", "Plan isolated issue matrix"],
    ["matrix_cell", "Run isolated issue cell"],
    ["repair", "Run selected Sentinel runtime"],
  ];
  for (const [job, name] of wanted) {
    const step = steps(jobs(supervisor)[job]).find((s) => s.name === name);
    assert(step !== undefined, name);
    assert.equal(
      (step.env as Obj).SENTINEL_BACKUP_CI,
      "${{ vars.SENTINEL_BACKUP_CI || 'on' }}",
      name,
    );
    const allow = /--allow-env=(\S+)/.exec(String(step.run))?.[1] ?? "";
    assert(allow.split(",").includes("SENTINEL_BACKUP_CI"), name);
  }
});

Deno.test("the backup targets enrol every ubiquity committed target, never the self target", async () => {
  const targets = parseBackupCiTargets(
    JSON.parse(await Deno.readTextFile("sentinel.backup-ci-targets.json")),
  );
  // Parse through the committed-setting validator: the 2026-11-01 expanded
  // set (29 targets since 2026-11-22) must still be a valid bounded slug array.
  const committed = parseTargetSlugsV1(
    JSON.parse(await Deno.readTextFile("sentinel.targets.json")),
  ).map((entry) => entry.slug);
  for (const target of targets) {
    assert(committed.includes(target.repository), target.repository);
    assert.notEqual(target.repository, "ubiquity-sentinel/sentinel");
    assert(
      target.repository.startsWith("ubiquity/"),
      "the read token is minted for ubiquity only",
    );
  }
  // Automatic enrolment (2026-11-17): the workflow mints the target read
  // token for exactly these rows, so every ubiquity target is listed and an
  // unknown id is `null` (resolved by the pass, pinned by calibration).
  assert.deepEqual(
    targets.map((target) => target.repository).sort(),
    committed.filter((slug) => slug.startsWith("ubiquity/")).sort(),
  );
  // `ubiquity/passport.ubq.fi` no longer exists under that name (2026-11-22,
  // docs/DECISIONS.md): it left both files together, because one name the
  // installation cannot resolve fails this whole read-token mint. It is no
  // committed target either, so no gate reads its runs; its store receipts
  // stay on the branch, inert.
  assert.equal(
    targets.some((t) => t.repository === "ubiquity/passport.ubq.fi"),
    false,
  );
  // A row must still name its `id` key, even as null.
  assert.throws(() =>
    parseBackupCiTargets([{ repository: "ubiquity/passport.ubq.fi" }])
  );
  assert.throws(() =>
    parseBackupCiTargets([{ repository: "ubiquity/prospector", id: "1" }])
  );
});

Deno.test("the target read token can read commit statuses, checks, runs and pulls", async () => {
  const mint = steps(jobs(await workflow("backup-ci.yml")).backup_ci).find((
    s,
  ) => s.name === "Mint the target read token");
  assert(mint !== undefined);
  const grant = Object.fromEntries(
    Object.entries(mint.with as Obj).filter(([key]) =>
      key.startsWith("permission-")
    ),
  );
  // The planner's combined status read needs `statuses`; without it every
  // commit's observations read null and nothing is planned (live,
  // 2026-10-25).
  assert.deepEqual(grant, {
    "permission-contents": "read",
    "permission-pull-requests": "read",
    "permission-checks": "read",
    "permission-statuses": "read",
    "permission-actions": "read",
  });
});

Deno.test("the official self App dispatch token is scoped to the trusted commit only", async () => {
  const trusted = jobs(await workflow("backup-ci.yml")).backup_ci;
  const list = steps(trusted);
  const mint = list.find((s) => s.id === "self-token");
  const pass = list.find((s) => s.id === "pass");
  const commit = list.find((s) =>
    s.name === "Record results and dispatch legs"
  );
  assert(mint && pass && commit);
  assert.equal(
    mint.uses,
    "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
  );
  assert.deepEqual(mint.with, {
    "client-id": "Iv23liHUJNXds9mU3j7Q",
    "private-key": "${{ secrets.SENTINEL_SUPERVISOR_APP_PRIVATE_KEY }}",
    owner: "ubiquity-sentinel",
    repositories: "sentinel",
    "permission-actions": "write",
  });
  assert(list.indexOf(mint) < list.indexOf(pass));
  assert(String(pass.if).includes("steps.self-token.outputs.token != ''"));
  assert.equal((pass.env as Obj).GITHUB_TOKEN, "${{ github.token }}");
  assert.equal("SENTINEL_SELF_TOKEN" in (pass.env as Obj), false);
  assert.equal((commit.env as Obj).GITHUB_TOKEN, "${{ github.token }}");
  assert.equal(
    (commit.env as Obj).SENTINEL_SELF_TOKEN,
    "${{ steps.self-token.outputs.token }}",
  );
  for (const step of list.filter((s) => s !== commit)) {
    assert.equal("SENTINEL_SELF_TOKEN" in ((step.env ?? {}) as Obj), false);
    assert(
      !JSON.stringify(step.with ?? {}).includes(
        "steps.self-token.outputs.token",
      ),
    );
  }
  const leg = await Deno.readTextFile(".github/workflows/backup-ci-leg.yml");
  assert(!leg.includes("SENTINEL_SELF_TOKEN"));
  assert(!leg.includes("permission-actions: write"));
  const pins = parseBackupCiPins(
    JSON.parse(await Deno.readTextFile("ops/backup-ci-pins.json")),
  );
  assert(pins !== null);
  assert.equal(backupCiRunnerId(pins), "ea2aacfd1f033045");
});
