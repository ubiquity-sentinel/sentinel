/**
 * The committed two-entry controller list: GitHub's own GITHUB_REPOSITORY
 * selects an entry in a real process, the public entry keeps the exact former
 * constants, and a private entry without both workflow ids refuses to start.
 */
import assert from "node:assert/strict";
import { cp } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  HOSTED_CONTROLLER_DEPLOYMENT,
  HOSTED_CONTROLLER_DEPLOYMENTS,
  HOSTED_CONTROLLER_REMOTE,
  HOSTED_CONTROLLER_REPOSITORY,
  HOSTED_CONTROLLER_ROLE,
  HOSTED_CONTROLLER_RUNTIME_ID,
  HOSTED_CONTROLLER_SELF_INSTALLATION_ID,
  HOSTED_CONTROLLER_WORKFLOW_REF,
  selectHostedControllerDeploymentV1,
} from "../../src/contracts/hosted-controller-deployment.ts";
import {
  RETIRED_HOSTED_RUNTIME_ID,
  RETIRED_HOSTED_SUPERVISOR_REPOSITORY,
} from "../../src/contracts/hosted-supervisor-types.ts";

const PUBLIC = "ubiquity-sentinel/sentinel";
const PRIVATE = "ubiquity-sentinel-private/sentinel";
const PRIVATE_SUPERVISOR_ID = 428313602;
const PRIVATE_CI_ID = 428313556;
const SOURCE = fileURLToPath(new URL("../../", import.meta.url));

const PUBLIC_CONSTANTS = {
  role: "public",
  repository: PUBLIC,
  remote: "https://github.com/ubiquity-sentinel/sentinel.git",
  runtimeRemote: "https://github.com/ubiquity-sentinel/sentinel.git",
  workflowRef:
    "ubiquity-sentinel/sentinel/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor",
  runtimeId: "ubiquity-sentinel/sentinel:0:production",
  supervisorWorkflowId: 357012162,
  ciWorkflowId: 353613034,
  followRepository: PUBLIC,
  dispatchRepository: PUBLIC,
  retiredRepository: "ubiquity/sentinel",
  retiredRuntimeId: "ubiquity/sentinel:0:production",
};

Deno.test("controller list: exactly the public and private entries, public first and unchanged", () => {
  assert.deepEqual(
    HOSTED_CONTROLLER_DEPLOYMENTS.map((entry) => [
      entry.role,
      `${entry.deployment.owner}/${entry.deployment.name}`,
    ]),
    [["public", PUBLIC], ["private", PRIVATE]],
  );
  assert.deepEqual({ ...HOSTED_CONTROLLER_DEPLOYMENTS[0].deployment }, {
    owner: "ubiquity-sentinel",
    name: "sentinel",
    sourceBranch: "development",
    supervisorBranch: "sentinel-supervisor",
    supervisorWorkflowPath: ".github/workflows/supervisor.yml",
    supervisorWorkflowId: 357012162,
    ciWorkflowPath: ".github/workflows/ci.yml",
    ciWorkflowId: 353613034,
  });
  assert.equal(
    HOSTED_CONTROLLER_DEPLOYMENTS[1].deployment.supervisorWorkflowId,
    PRIVATE_SUPERVISOR_ID,
  );
  assert.equal(
    HOSTED_CONTROLLER_DEPLOYMENTS[1].deployment.ciWorkflowId,
    PRIVATE_CI_ID,
  );
  assert(Object.isFrozen(HOSTED_CONTROLLER_DEPLOYMENTS));
  for (const entry of HOSTED_CONTROLLER_DEPLOYMENTS) {
    assert(Object.isFrozen(entry) && Object.isFrozen(entry.deployment));
  }
  // A process that cannot read GITHUB_REPOSITORY (this test) is the public one.
  assert.deepEqual({
    role: HOSTED_CONTROLLER_ROLE,
    repository: HOSTED_CONTROLLER_REPOSITORY,
    remote: HOSTED_CONTROLLER_REMOTE,
    workflowRef: HOSTED_CONTROLLER_WORKFLOW_REF,
    runtimeId: HOSTED_CONTROLLER_RUNTIME_ID,
    supervisorWorkflowId: HOSTED_CONTROLLER_DEPLOYMENT.supervisorWorkflowId,
    ciWorkflowId: HOSTED_CONTROLLER_DEPLOYMENT.ciWorkflowId,
    retiredRepository: RETIRED_HOSTED_SUPERVISOR_REPOSITORY,
    retiredRuntimeId: RETIRED_HOSTED_RUNTIME_ID,
  }, {
    role: PUBLIC_CONSTANTS.role,
    repository: PUBLIC_CONSTANTS.repository,
    remote: PUBLIC_CONSTANTS.remote,
    workflowRef: PUBLIC_CONSTANTS.workflowRef,
    runtimeId: PUBLIC_CONSTANTS.runtimeId,
    supervisorWorkflowId: PUBLIC_CONSTANTS.supervisorWorkflowId,
    ciWorkflowId: PUBLIC_CONSTANTS.ciWorkflowId,
    retiredRepository: PUBLIC_CONSTANTS.retiredRepository,
    retiredRuntimeId: PUBLIC_CONSTANTS.retiredRuntimeId,
  });
});

Deno.test("controller selection: only the exact committed repository selects the private entry", () => {
  for (
    const repository of [
      PUBLIC,
      undefined,
      "",
      "fork/sentinel",
      "ubiquity/sentinel",
      "UBIQUITY-SENTINEL-PRIVATE/sentinel",
      `${PRIVATE} `,
    ]
  ) {
    const selected = selectHostedControllerDeploymentV1(repository);
    assert(selected.ok);
    assert.equal(selected.binding.role, "public");
    assert.equal(selected.binding.selfInstallationId, null);
    assert.deepEqual(
      selected.binding.deployment,
      { ...HOSTED_CONTROLLER_DEPLOYMENTS[0].deployment },
    );
  }
  const privateSelected = selectHostedControllerDeploymentV1(PRIVATE);
  assert(privateSelected.ok);
  assert.equal(HOSTED_CONTROLLER_SELF_INSTALLATION_ID, null);
  assert.deepEqual(privateSelected.binding, {
    role: "private",
    retiredRepository: null,
    retiredRuntimeId: null,
    selfInstallationId: 183425201,
    deployment: {
      owner: "ubiquity-sentinel-private",
      name: "sentinel",
      sourceBranch: "development",
      supervisorBranch: "sentinel-supervisor",
      supervisorWorkflowPath: ".github/workflows/supervisor.yml",
      supervisorWorkflowId: PRIVATE_SUPERVISOR_ID,
      ciWorkflowPath: ".github/workflows/ci.yml",
      ciWorkflowId: PRIVATE_CI_ID,
    },
  });
});

Deno.test("controller selection: either missing private workflow id refuses selection", () => {
  const [publicEntry, privateEntry] = HOSTED_CONTROLLER_DEPLOYMENTS;
  for (
    const [supervisorWorkflowId, ciWorkflowId] of [
      [null, null],
      [PRIVATE_SUPERVISOR_ID, null],
      [null, PRIVATE_CI_ID],
    ] as const
  ) {
    const entries = [publicEntry, {
      ...privateEntry,
      deployment: {
        ...privateEntry.deployment,
        supervisorWorkflowId,
        ciWorkflowId,
      },
    }];
    assert.deepEqual(selectHostedControllerDeploymentV1(PRIVATE, entries), {
      ok: false,
      reason: "workflow_ids_unfilled",
      repository: PRIVATE,
    });
  }
});

const PROBE = `
const root = Deno.args[0];
const load = (path) => import(new URL(path, root).href);
const binding = await load("src/contracts/hosted-controller-deployment.ts");
const types = await load("src/contracts/hosted-supervisor-types.ts");
const identity = await load("src/host/hosted-runtime-identity.ts");
const follow = await load("src/host/hosted-runtime-follow-api.ts");
const followCi = await load("src/host/hosted-runtime-follow-ci.ts");
const dispatch = await load("src/host/supervisor-dispatch.ts");
const bootstrap = await load("src/host/actions-supervisor-bootstrap.ts");
const env = (repository) => ({
  GITHUB_REPOSITORY: repository,
  GITHUB_REF: "refs/heads/sentinel-supervisor",
  GITHUB_WORKFLOW_REF: repository + "/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_WORKFLOW_SHA: "a".repeat(40),
  GITHUB_RUN_ID: "1",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_JOB: "prepare",
});
const accepts = (repository) => {
  try {
    identity.parseHostedEnvironment(env(repository), "prepare");
    return true;
  } catch {
    return false;
  }
};
console.log(JSON.stringify({
  role: binding.HOSTED_CONTROLLER_ROLE,
  repository: binding.HOSTED_CONTROLLER_REPOSITORY,
  remote: binding.HOSTED_CONTROLLER_REMOTE,
  runtimeRemote: identity.REMOTE_URL,
  bootstrapRemote: bootstrap.REMOTE_URL,
  workflowRef: identity.HOSTED_RUNTIME_WORKFLOW_REF,
  runtimeId: types.HOSTED_RUNTIME_ID,
  supervisorWorkflowId: types.HOSTED_SUPERVISOR_WORKFLOW_ID,
  ciWorkflowId: followCi.FOLLOW_CI_WORKFLOW_ID,
  followRepository: follow.FOLLOW_REPOSITORY,
  dispatchRepository: dispatch.SUPERVISOR_REPOSITORY,
  retiredRepository: types.RETIRED_HOSTED_SUPERVISOR_REPOSITORY,
  retiredRuntimeId: types.RETIRED_HOSTED_RUNTIME_ID,
  acceptsPublic: accepts(${JSON.stringify(PUBLIC)}),
  acceptsPrivate: accepts(${JSON.stringify(PRIVATE)}),
}));
`;

async function probe(
  root: string,
  repository: string | null,
  readable: boolean,
) {
  const dir = await Deno.makeTempDir({
    dir: await scratch(),
    prefix: "controller-probe-",
  });
  try {
    const path = dir + "/probe.mjs";
    await Deno.writeTextFile(path, PROBE);
    const env: Record<string, string> = repository === null
      ? {}
      : { GITHUB_REPOSITORY: repository };
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--frozen",
        `--config=${root}deno.json`,
        `--allow-read=${root},${dir}`,
        ...(readable ? ["--allow-env=GITHUB_REPOSITORY"] : []),
        path,
        pathToFileURL(root).href,
      ],
      clearEnv: true,
      env,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout).trim(),
      stderr: new TextDecoder().decode(output.stderr),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function scratch(): Promise<string> {
  const dir = SOURCE + ".sentinel-artifacts";
  await Deno.mkdir(dir, { recursive: true });
  return dir;
}

Deno.test("controller selection: a real process uses the committed identity, refs, remotes and ids", async () => {
  const publicRun = await probe(SOURCE, PUBLIC, true);
  assert.equal(publicRun.code, 0, publicRun.stderr);
  assert.deepEqual(JSON.parse(publicRun.stdout), {
    ...PUBLIC_CONSTANTS,
    bootstrapRemote: PUBLIC_CONSTANTS.remote,
    acceptsPublic: true,
    acceptsPrivate: false,
  });
  // Unreadable or foreign names select the public entry, refused as before.
  for (
    const [repository, readable] of [
      [PRIVATE, false],
      [null, true],
      ["fork/sentinel", true],
    ] as const
  ) {
    const run = await probe(SOURCE, repository, readable);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {
      ...PUBLIC_CONSTANTS,
      bootstrapRemote: PUBLIC_CONSTANTS.remote,
      acceptsPublic: true,
      acceptsPrivate: false,
    });
  }
  const privateRun = await probe(SOURCE, PRIVATE, true);
  assert.equal(privateRun.code, 0, privateRun.stderr);
  const remote = "https://github.com/ubiquity-sentinel-private/sentinel.git";
  assert.deepEqual(JSON.parse(privateRun.stdout), {
    role: "private",
    repository: PRIVATE,
    remote,
    runtimeRemote: remote,
    bootstrapRemote: remote,
    workflowRef:
      `${PRIVATE}/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor`,
    runtimeId: `${PRIVATE}:0:production`,
    supervisorWorkflowId: PRIVATE_SUPERVISOR_ID,
    ciWorkflowId: PRIVATE_CI_ID,
    followRepository: PRIVATE,
    dispatchRepository: PRIVATE,
    retiredRepository: null,
    retiredRuntimeId: null,
    acceptsPublic: false,
    acceptsPrivate: true,
  });
});

Deno.test("controller selection: a real process refuses an unbound private entry", async () => {
  const root = await Deno.makeTempDir({
    dir: await scratch(),
    prefix: "controller-unbound-",
  });
  try {
    const copy = root + "/";
    for (const name of ["src", "ops"]) {
      await cp(SOURCE + name, copy + name, { recursive: true });
    }
    for (const name of ["deno.json", "deno.lock"]) {
      await Deno.copyFile(SOURCE + name, copy + name);
    }
    const file = copy + "src/contracts/hosted-controller-deployment.ts";
    const original = await Deno.readTextFile(file);
    const supervisorField = `supervisorWorkflowId: ${PRIVATE_SUPERVISOR_ID},`;
    const ciField = `ciWorkflowId: ${PRIVATE_CI_ID},`;
    assert(original.includes(supervisorField));
    assert(original.includes(ciField));
    await Deno.writeTextFile(
      file,
      original
        .replace(supervisorField, "supervisorWorkflowId: null,")
        .replace(ciField, "ciWorkflowId: null,"),
    );
    const unbound = await probe(copy, PRIVATE, true);
    assert.notEqual(unbound.code, 0);
    assert.equal(unbound.stdout, "");
    assert.match(
      unbound.stderr,
      /hosted controller binding refused: workflow_ids_unfilled ubiquity-sentinel-private\/sentinel/,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
