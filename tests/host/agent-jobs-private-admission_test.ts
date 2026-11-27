import assert from "node:assert/strict";
import {
  AGENT_JOB_BASE_REF,
  agentJobBaseBundlePath,
  pinAgentJobsPlan,
  requirePrivateAgentJobHost,
} from "../../ops/agent-jobs-admission.ts";
import { createAgentJobAppAuthorizer } from "../../ops/agent-jobs-app-access.ts";
import { stagePrivateAgentJobBase } from "../../ops/agent-jobs-base-stage.ts";
import { gitOk } from "../../ops/agent-jobs-git.ts";
import {
  readAgentJobDispatchRequest,
  requireAgentJobOperatorWrite,
} from "../../ops/agent-jobs-intake.ts";
import { planAgentJobs } from "../../ops/agent-jobs-plan.ts";
import {
  agentJobRepositoryVisibilityV1,
  deploymentRunsServiceV1,
  deploymentWorksAgentJobTargetV1,
  HOSTED_CONTROLLER_PROFILES,
} from "../../src/contracts/hosted-controller-deployment.ts";
import { createInjectedJwtSigner } from "../../src/github/auth.ts";
import { SENTINEL_APP_ID } from "../../src/host/hosted-app-grant.ts";

const [publicProfile, privateProfile] = HOSTED_CONTROLLER_PROFILES;
const publicRepo = "owner/example";
const privateRepo = "owner/secret";
const baseSha = "a".repeat(40);
const request = (repository: string, job: Record<string, unknown> = {}) => ({
  id: repository.split("/")[1],
  repository,
  prompt: "Check fixture",
  minutes: 2,
  ...job,
});

function metadata(repository: string, visibility: "public" | "private") {
  return {
    full_name: repository,
    visibility,
    private: visibility === "private",
    default_branch: "main",
  };
}

Deno.test("private on-demand authority binds both deployments and requires exact private metadata", () => {
  for (const { repository } of HOSTED_CONTROLLER_PROFILES) {
    assert.equal(deploymentRunsServiceV1(repository, "agentJobs"), true);
  }
  assert.equal(deploymentRunsServiceV1("fork/sentinel", "agentJobs"), false);
  for (
    const body of [
      { private: true, visibility: "public" },
      { private: true, visibility: "internal" },
      { private: false, visibility: "private" },
      { private: true },
      { visibility: "private" },
      null,
    ]
  ) {
    assert.equal(agentJobRepositoryVisibilityV1(body), "unknown");
  }
  assert.equal(
    deploymentWorksAgentJobTargetV1(
      privateProfile,
      privateProfile.repository,
      metadata(privateProfile.repository, "private"),
    ),
    false,
  );
  assert.equal(
    deploymentWorksAgentJobTargetV1(
      privateProfile,
      publicProfile.repository,
      metadata(publicProfile.repository, "private"),
    ),
    false,
  );
  assert.equal(
    deploymentWorksAgentJobTargetV1(
      privateProfile,
      privateRepo,
      metadata("different/secret", "private"),
    ),
    false,
  );
});

Deno.test("private on-demand host and human writer require authenticated exact metadata", async () => {
  const token = "native-fixture";
  let calls = 0;
  const read = async (url: string, init?: RequestInit) => {
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer " + token,
    );
    calls++;
    await Promise.resolve();
    return Response.json(
      url.endsWith("/permission")
        ? { permission: "write", user: { login: "human", type: "User" } }
        : metadata(privateProfile.repository, "private"),
    );
  };
  await requirePrivateAgentJobHost(privateProfile, token, read);
  await requireAgentJobOperatorWrite(
    privateProfile.repository,
    "human",
    token,
    read,
  );
  assert.equal(calls, 2);
  await assert.rejects(
    requirePrivateAgentJobHost(
      privateProfile,
      token,
      () =>
        Promise.resolve(
          Response.json(metadata(privateProfile.repository, "public")),
        ),
    ),
    /deployment repository is unavailable or not private/,
  );
  await assert.rejects(
    requireAgentJobOperatorWrite(
      privateProfile.repository,
      "human",
      token,
      () =>
        Promise.resolve(
          Response.json({
            permission: "read",
            user: { login: "human", type: "User" },
          }),
        ),
    ),
    /requires GitHub repository write access/,
  );
});

for (const profile of HOSTED_CONTROLLER_PROFILES) {
  Deno.test(`${profile.role} on-demand admission exercises matching, opposite and mixed requests`, async () => {
    const [matching, opposite] = profile.role === "private"
      ? [privateRepo, publicRepo]
      : [publicRepo, privateRepo];
    const plan = (repositories: string[]) =>
      planAgentJobs(repositories.map((repository) => request(repository)), {
        profile,
      });
    let reads = 0;
    let staged = 0;
    let minuteChecks = 0;
    const read = (url: string, init: RequestInit) => {
      const repository = url.includes(privateRepo) ? privateRepo : publicRepo;
      const authorization = new Headers(init.headers).get("authorization");
      assert.equal(
        authorization,
        profile.role === "private" ? "Bearer read-" + repository : null,
      );
      return Promise.resolve(Response.json(
        url.endsWith("/branches/main")
          ? { name: "main", commit: { sha: baseSha } }
          : metadata(
            repository,
            repository === privateRepo ? "private" : "public",
          ),
      ));
    };
    const options = {
      profile,
      read,
      authorizePrivateRepository: (repository: string) => {
        reads++;
        return Promise.resolve("read-" + repository);
      },
      checkPrivateMinutes: () => {
        minuteChecks++;
        return Promise.resolve();
      },
      stagePrivateBase: ({ repository, sha, readToken }: {
        repository: string;
        sha: string;
        readToken: string;
      }) => {
        assert.equal(repository, matching);
        assert.equal(sha, baseSha);
        assert.equal(readToken, "read-" + repository);
        assert.equal(minuteChecks, 1);
        staged++;
        return Promise.resolve();
      },
    };
    const pin = (repositories: string[]) =>
      pinAgentJobsPlan(plan(repositories), 100, options);
    const result = await pin([matching]);
    assert.equal(result.createdAtMs, 100);
    assert.equal(result.cells[0].jobs[0].baseSha, baseSha);
    assert.equal(
      result.cells[0].jobs[0].runner,
      profile.role === "private" ? "linux-arm64" : "linux-x64",
    );
    assert.equal(reads, profile.role === "private" ? 1 : 0);
    assert.equal(staged, profile.role === "private" ? 1 : 0);
    assert.equal(minuteChecks, profile.role === "private" ? 1 : 0);
    if (profile.role === "private") {
      await assert.rejects(
        pinAgentJobsPlan(plan([matching]), 100, {
          ...options,
          checkPrivateMinutes: undefined,
        }),
        /requires trusted Git access and a minutes check/,
      );
      await assert.rejects(
        pinAgentJobsPlan(plan([matching]), 100, {
          ...options,
          checkPrivateMinutes: () =>
            Promise.reject(new Error("fixture budget refused")),
        }),
        /fixture budget refused/,
      );
      assert.equal(staged, 1);
    }
    const originalStaged = staged;
    const refusal = profile.role === "private"
      ? /target is public; the private deployment requires a private target/
      : /target is unavailable or not public/;
    await assert.rejects(pin([opposite]), refusal);
    await assert.rejects(pin([matching, opposite]), refusal);
    assert.equal(staged, originalStaged);
    assert.equal(minuteChecks, profile.role === "private" ? 1 : 0);
  });
}

Deno.test("private on-demand plan defaults to ARM Linux", () => {
  const plan = planAgentJobs([request(privateRepo)], {
    profile: privateProfile,
  });
  assert.equal(plan.cells[0].jobs[0].runner, "linux-arm64");
});

Deno.test("private on-demand intake uses the native event and refuses request-owned authority fields", () => {
  const event = {
    inputs: {
      jobs: JSON.stringify({ jobs: [request(privateRepo)] }),
      agents_per_cell: "3",
      max_cells: "5",
    },
  };
  const { document, agentsPerCell, maxCells } = readAgentJobDispatchRequest(
    event,
  );
  assert.deepEqual(document, { jobs: [request(privateRepo)] });
  assert.equal(agentsPerCell, "3");
  assert.equal(maxCells, "5");
  assert.throws(
    () => planAgentJobs({ role: "private", jobs: [request(privateRepo)] }),
    /unknown request field/,
  );
  assert.throws(
    () => planAgentJobs([request(privateRepo, { installId: 1 })]),
    /unknown job field/,
  );
  assert.throws(
    () => readAgentJobDispatchRequest({ inputs: { jobs: "sensitive text" } }),
    /^Error: invalid agent jobs request JSON$/,
  );
});

Deno.test("private on-demand App preflight proves write access and mints only an exact read token", async () => {
  const now = 1_795_800_000;
  const signer = createInjectedJwtSigner((claims) => {
    assert.equal(claims.iss, String(SENTINEL_APP_ID));
    return Promise.resolve("signed-app-fixture");
  });
  const validInstallation = {
    id: 123,
    app_id: SENTINEL_APP_ID,
    account: { login: "Owner" },
    permissions: { contents: "write", pull_requests: "write" },
    suspended_at: null,
  };
  const validMint = {
    token: "opaque/synthetic+token",
    expires_at: new Date((now + 600) * 1000).toISOString(),
    permissions: { contents: "read", metadata: "read" },
    repositories: [{ full_name: "OWNER/secret" }],
  };
  const requests: string[] = [];
  const app = (
    installation: unknown = validInstallation,
    mint: unknown = validMint,
  ) =>
    createAgentJobAppAuthorizer(signer, now, (url, init) => {
      assert.equal(init.redirect, "error");
      assert.equal(
        new Headers(init.headers).get("authorization"),
        "Bearer signed-app-fixture",
      );
      requests.push(url);
      if (url.endsWith("/installation")) {
        return Promise.resolve(Response.json(installation));
      }
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(String(init.body)), {
        repositories: ["secret"],
        permissions: { contents: "read" },
      });
      return Promise.resolve(Response.json(mint));
    });
  assert.equal(await (await app())(privateRepo, true), validMint.token);
  assert.deepEqual(requests, [
    "https://api.github.com/repos/owner/secret/installation",
    "https://api.github.com/app/installations/123/access_tokens",
  ]);
  requests.length = 0;
  for (
    const installation of [
      { ...validInstallation, permissions: { contents: "read" } },
      { ...validInstallation, permissions: { contents: "write" } },
      { ...validInstallation, account: { login: "different" } },
      { ...validInstallation, app_id: 124 },
      { ...validInstallation, suspended_at: "2026-11-01T00:00:00Z" },
    ]
  ) {
    await assert.rejects(
      (await app(installation))(privateRepo, true),
      /not writable by the deployment App/,
    );
  }
  assert.equal(requests.every((url) => url.endsWith("/installation")), true);
  assert.equal(
    await (await app({
      ...validInstallation,
      permissions: { contents: "write" },
    }))(privateRepo, false),
    validMint.token,
  );
  for (
    const mint of [
      { ...validMint, permissions: { contents: "write" } },
      {
        ...validMint,
        permissions: { contents: "read", pull_requests: "write" },
      },
      { ...validMint, repositories: [{ full_name: "other/secret" }] },
      { ...validMint, expires_at: "2020-01-01T00:00:00Z" },
    ]
  ) {
    await assert.rejects(
      (await app(validInstallation, mint))(privateRepo, true),
      /could not grant exact target read access/,
    );
  }
});

Deno.test("private on-demand stages only the pinned base from the trusted Git remote", async () => {
  const root = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: ".agent-job-base-stage-",
  });
  const upstream = root + "/upstream";
  const artifacts = root + "/artifacts";
  const consumer = root + "/consumer";
  try {
    for (const directory of [upstream, artifacts, consumer]) {
      await Deno.mkdir(directory);
    }
    await gitOk(["init", "--quiet", "-b", "main"], { cwd: upstream });
    await Deno.writeTextFile(upstream + "/README.md", "pinned fixture");
    await gitOk(["add", "."], { cwd: upstream });
    await gitOk(["commit", "--quiet", "-m", "pinned"], { cwd: upstream });
    const sha = await gitOk(["rev-parse", "HEAD"], { cwd: upstream });
    await Deno.writeTextFile(upstream + "/README.md", "later fixture");
    await gitOk(["commit", "--quiet", "-am", "later"], { cwd: upstream });

    await stagePrivateAgentJobBase(artifacts, {
      repository: privateRepo,
      sha,
      readToken: "synthetic-token",
    }, (repository) => {
      assert.equal(repository, privateRepo);
      return upstream;
    });
    const bundle = artifacts + "/" + agentJobBaseBundlePath(privateRepo, sha);
    assert.equal(
      await gitOk(["bundle", "list-heads", bundle], { cwd: upstream }),
      sha + " " + AGENT_JOB_BASE_REF,
    );
    await gitOk(["init", "--quiet"], { cwd: consumer });
    await gitOk(["fetch", "--quiet", bundle, AGENT_JOB_BASE_REF], {
      cwd: consumer,
    });
    assert.equal(
      await gitOk(["rev-parse", "FETCH_HEAD"], { cwd: consumer }),
      sha,
    );
    assert.equal(
      await gitOk(["show", "FETCH_HEAD:README.md"], { cwd: consumer }),
      "pinned fixture",
    );
    assert.deepEqual(
      (await Array.fromAsync(Deno.readDir(artifacts))).map(({ name }) => name),
      ["bases"],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
