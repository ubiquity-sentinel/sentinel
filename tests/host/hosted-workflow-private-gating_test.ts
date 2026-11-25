import assert from "node:assert/strict";
import { parse } from "@std/yaml";
import {
  HOSTED_CONTROLLER_DEPLOYMENTS,
  HOSTED_CONTROLLER_PROFILES,
  HOSTED_CONTROLLER_WORKFLOW_TABLE,
} from "../../src/contracts/hosted-controller-deployment.ts";

type Obj = Record<string, unknown>;
type RepositoryField = string | readonly string[];
const WORKFLOW_DIRECTORY = ".github/workflows";
const AUTOMATIC_TRIGGERS = new Set([
  "schedule",
  "push",
  "pull_request",
  "workflow_run",
]);

async function workflow(name: string): Promise<Obj> {
  return parse(
    await Deno.readTextFile(WORKFLOW_DIRECTORY + "/" + name),
  ) as Obj;
}

function jobs(doc: Obj): Record<string, Obj> {
  return doc.jobs as Record<string, Obj>;
}

function steps(job: Obj): Obj[] {
  return job.steps as Obj[];
}

function isAutomatic(value: unknown): boolean {
  const triggers = typeof value === "string"
    ? [value]
    : Array.isArray(value)
    ? value
    : Object.keys(value as Obj);
  return triggers.some((trigger) => AUTOMATIC_TRIGGERS.has(trigger));
}

const [publicProfile, privateProfile] = HOSTED_CONTROLLER_PROFILES;
const [publicEntry, privateEntry] = HOSTED_CONTROLLER_DEPLOYMENTS;
const workflowFacts = {
  public: {
    ...publicProfile,
    sourceRef: "refs/heads/" + publicEntry.deployment.sourceBranch,
    supervisorRef: "refs/heads/" + publicEntry.deployment.supervisorBranch,
  },
  private: {
    ...privateProfile,
    sourceRef: "refs/heads/" + privateEntry.deployment.sourceBranch,
  },
};
const templateFacts = Object.fromEntries(
  Object.entries(workflowFacts).flatMap(([role, facts]) =>
    Object.entries(facts).map(([name, value]) => [role + "." + name, value])
  ),
);

function resolveProfileFacts(value: string): string {
  return value.replace(/@([a-z]+\.[a-zA-Z]+)@/g, (_, name: string) => {
    const fact = templateFacts[name];
    assert.ok(typeof fact === "string" || typeof fact === "number", name);
    return String(fact);
  });
}

const GITHUB_CONTEXT_ACCESS = /\bgithub(?:\s*\.\s*[\w-]+|\s*\[[^\]\n]+\])+/gi;
const CONTROLLER_CONTEXT_PROPERTY =
  /\b(?:repository(?:_id|_owner|_owner_id|_visibility)?|head_repository|base_repository|workflow_ref)\b/i;
const REPOSITORY_ENVIRONMENT =
  /\b(?:GH_REPO|GITHUB_REPOSITORY(?:_ID|_OWNER(?:_ID)?)?|GITHUB_WORKFLOW_REF|(?:SENTINEL_)?(?:HOSTED_CONTROLLER|DEPLOYMENT|REPOSITORY|HOST)_(?:ROLE|VISIBILITY)|IS_(?:PUBLIC|PRIVATE))\b/i;
const VISIBILITY_VALUE =
  /['"](?:public|private)['"]|\b(?:repo|repository)\.(?:private|isPrivate|visibility)\b/i;
const CONTROLLER_OWNERS = HOSTED_CONTROLLER_PROFILES.map((profile) =>
  profile.selfTokenOwner.toLowerCase()
);

function mentionsController(value: string): boolean {
  return [...value.matchAll(GITHUB_CONTEXT_ACCESS)].some(([access]) =>
    CONTROLLER_CONTEXT_PROPERTY.test(access) || /\[\s*\w+\s*\]/.test(access)
  ) ||
    /\btoJSON\s*\(\s*github(?:\s*\.\s*event)?\s*\)/i.test(value) ||
    REPOSITORY_ENVIRONMENT.test(value) ||
    VISIBILITY_VALUE.test(value) ||
    /\bcontext\s*\.\s*repo\b/i.test(value) ||
    (value.toLowerCase().match(/[\w-]+/g) ?? []).some((word) =>
      CONTROLLER_OWNERS.includes(word)
    );
}

function scriptRepositoryReferences(script: string): string[] {
  // Expressions can span lines in a block scalar. Join them before scanning
  // script lines so a split property name still has its GitHub context.
  const joined = script.replace(
    /\$\{\{[\s\S]*?\}\}/g,
    (expression) => expression.replace(/\s*\n\s*/g, " "),
  );
  // A Deno permission grant passes through context without reading it here.
  return joined.split("\n").map((line) => line.trim()).filter((line) =>
    (!line.startsWith("#") || line.includes("${{")) &&
    mentionsController(line.replace(/--allow-env=[\w,]+/g, ""))
  );
}

function collectRepositoryFields(
  value: unknown,
  path: string,
  jobConditions: ReadonlySet<string>,
  fields: Record<string, RepositoryField>,
): void {
  if (typeof value === "string") {
    if (jobConditions.has(path)) return; // Job conditions are checked in full.
    const script = path.endsWith(".run") || path.endsWith(".with.script");
    const references = script
      ? scriptRepositoryReferences(value)
      : mentionsController(value) || REPOSITORY_ENVIRONMENT.test(path)
      ? value
      : undefined;
    if (references === undefined || references.length === 0) return;
    assert.ok(!Object.hasOwn(fields, path), "Duplicate workflow field " + path);
    fields[path] = references;
  } else if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const step = path.endsWith(".steps") ? item as Obj : undefined;
      const label = step?.id ?? step?.name ?? index;
      collectRepositoryFields(
        item,
        path + "[" + label + "]",
        jobConditions,
        fields,
      );
    }
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const child = path ? path + "." + key : key;
      collectRepositoryFields(entry, child, jobConditions, fields);
    }
  }
}

Deno.test("workflow deployment policy matches every job and role-dependent field", async () => {
  const files = (await Array.fromAsync(Deno.readDir(WORKFLOW_DIRECTORY)))
    .map(({ name }) => name)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort();
  assert.deepEqual(files, Object.keys(HOSTED_CONTROLLER_WORKFLOW_TABLE).sort());
  assert.deepEqual(
    HOSTED_CONTROLLER_PROFILES.filter(({ chaining }) => chaining).map((
      { role },
    ) => role),
    ["public"],
    "Only the public profile chains a supervisor dispatch",
  );
  const switchByAdmission = {
    "public-only": [true, false],
    "private-only": [false, true],
    "both": [true, true],
    "role-dependent": [false, true], // Only private limits CI to development pushes.
  };
  for (const file of files) {
    const doc = await workflow(file);
    const automatic = isAutomatic(doc.on);
    const expectedJobs = HOSTED_CONTROLLER_WORKFLOW_TABLE[file];
    const actualJobs = jobs(doc);
    assert.deepEqual(
      Object.keys(actualJobs).sort(),
      Object.keys(expectedJobs).sort(),
      file + " job IDs",
    );

    const jobConditions = new Set<string>();
    const expectedFields: Record<string, RepositoryField> = {};
    for (const [name, expected] of Object.entries(expectedJobs)) {
      const job = actualJobs[name];
      const label = file + " " + name;
      assert.ok(
        !automatic || expected.admission !== "both",
        label + " automatic admission must be scoped by deployment",
      );
      assert.equal(
        job.if,
        expected.if && resolveProfileFacts(expected.if),
        label,
      );
      if (expected.inheritsGateFrom) {
        assert.equal(
          job.needs,
          expected.inheritsGateFrom,
          label + " dependency",
        );
        assert.equal(
          expected.admission,
          expectedJobs[expected.inheritsGateFrom].admission,
          label + " inherited deployment admission",
        );
      }
      if (expected.profileSwitch) {
        const policy = expected.profileSwitch;
        assert.deepEqual(
          [publicProfile[policy], privateProfile[policy]],
          switchByAdmission[expected.admission],
          label + " deployment profile",
        );
      }
      jobConditions.add("jobs." + name + ".if");
      for (
        const [path, value] of Object.entries(expected.repositoryFields ?? {})
      ) {
        expectedFields["jobs." + name + "." + path] = typeof value === "string"
          ? resolveProfileFacts(value)
          : value.map(resolveProfileFacts);
      }
    }

    const actualFields: Record<string, RepositoryField> = {};
    collectRepositoryFields(doc, "", jobConditions, actualFields);
    assert.deepEqual(actualFields, expectedFields, file + " deployment fields");
  }
});

Deno.test("private gating: the remaining supervisor timeouts and self token scopes stay fixed", async () => {
  const supervisor = jobs(await workflow("supervisor.yml"));
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(supervisor).filter(([name]) => name !== "matrix_cell")
        .map(([name, job]) => [name, job["timeout-minutes"]]),
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
  for (const job of Object.values(supervisor)) {
    const selfToken = steps(job).find((step) => step.id === "self-token");
    assert.ok(selfToken);
    assert.equal((selfToken.with as Obj).repositories, "sentinel");
  }
});

Deno.test("private gating: the paced cycle and the weekly sync run on the private repository only", async () => {
  const daily = await workflow("private-daily.yml");
  assert.equal(daily.name, "sentinel-private-daily");
  assert.deepEqual(Object.keys(daily.on as Obj).sort(), [
    "schedule",
    "workflow_dispatch",
  ]);
  assert.deepEqual((daily.on as Obj).schedule, [{
    cron: "41 3,9,15,21 * * *",
  }]);
  const day = jobs(daily).daily;
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
  // Check repository-wide overlap before CI and again before dispatch.
  const order = [
    /for status in queued in_progress; do/,
    /supervisor\.yml\/runs\?status=\$status&per_page=1/,
    /\nrequire_idle_supervisor\nlauncher=/,
    /check_name=test-local&filter=latest/,
    /if \[ "\$used" -ge "\$allowance" \]; then/,
    /\nrequire_idle_supervisor\necho "\$budget decision=dispatch"/,
    /gh workflow run supervisor\.yml --repo "\$GH_REPO" --ref sentinel-supervisor/,
  ].map((pattern) => run.search(pattern));
  assert.ok(order.every((at) => at >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  // Each failed read and guard refusal exits green with one line.
  assert.equal((run.match(/exit 0/g) ?? []).length, 1);
  assert.match(run, /none\(\) \{\n\s+echo "no cycle: \$1"\n\s+exit 0\n/);
  assert.doesNotMatch(run, /exit 1/);
  assert.doesNotMatch(run, /for \w+ in \$\(/);

  const sync = await workflow("private-sync.yml");
  assert.deepEqual((sync.on as Obj).schedule, [{ cron: "17 2 * * 0" }]);
  const job = jobs(sync).sync;
  // Repository secret, no environment (one instruction for the operator).
  assert.equal(job.environment, undefined);
  const [mint, move] = steps(job);
  assert.deepEqual(mint.with, {
    "client-id": "Iv23liHUJNXds9mU3j7Q",
    "private-key": "${{ secrets.SENTINEL_SUPERVISOR_APP_PRIVATE_KEY }}",
    owner: privateProfile.selfTokenOwner,
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
