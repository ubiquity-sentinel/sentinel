import assert from "node:assert/strict";
import { portOk } from "../../src/contracts/ports.ts";
import { HostedSupervisorGitHubClient } from "../../src/host/actions-supervisor-install-api.ts";
import { requireRun, runProof } from "./actions-supervisor-fixture.ts";
import {
  LEGACY_RUNTIME,
  liveInstallRig,
  SUCCESSOR,
} from "./hosted-self-install-fixtures.ts";

type Rig = Awaited<ReturnType<typeof liveInstallRig>>;
const greenCheck = (id = 92) => ({
  id,
  name: "test-local",
  head_sha: SUCCESSOR,
  status: "completed",
  conclusion: "success",
  app: { slug: "github-actions" },
});
const listing = (...checks: unknown[]) => ({
  total_count: checks.length,
  check_runs: checks,
});
const pendingCheck = { ...greenCheck(), status: "queued", conclusion: null };

function useLatestCi(rig: Rig, response: (read: number) => unknown) {
  let reads = 0;
  const client = new HostedSupervisorGitHubClient({
    repository: { owner: "ubiquity", name: "sentinel", installationId: 0 },
    apiBaseUrl: "https://api.github.com",
    clock: rig.clock,
    auth: {
      authorizationHeader: () => Promise.resolve(portOk("Bearer synthetic")),
    },
    cooldownGate: {
      beforeRequest: () => Promise.resolve(portOk(undefined)),
      recordRateLimit: () => Promise.resolve(portOk(undefined)),
    },
    http: (request) => {
      const url = new URL(request.url);
      assert.equal(request.method, "GET");
      assert.equal(
        url.pathname,
        `/repos/ubiquity/sentinel/commits/${SUCCESSOR}/check-runs`,
      );
      assert.equal(url.searchParams.get("filter"), "latest");
      assert.equal(url.searchParams.get("page"), "1");
      assert.equal(url.searchParams.get("per_page"), "100");
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        bodyText: JSON.stringify(response(++reads)),
      });
    },
  });
  rig.evidence.verifyLauncherCi = client.verifyLauncherCi.bind(client);
  return () => reads;
}

Deno.test("requested installation: successful same-SHA CI rerun resumes with immutable request evidence", async () => {
  const rig = await liveInstallRig();
  try {
    const reads = useLatestCi(
      rig,
      (read) =>
        listing(
          read === 1
            ? greenCheck(91)
            : read === 2
            ? pendingCheck
            : greenCheck(),
        ),
    );
    const repairBefore = await rig.repair.readRepair();
    assert.equal((await rig.prepare(1)).status, "pending");
    const requested = await rig.snapshot();
    const journal = requested.hostedInstallations![0];
    assert.equal(journal.phase, "requested");
    assert.deepEqual(journal.ci, { revision: SUCCESSOR, checkRunId: 91 });
    assert.equal(requested.hostedRuntimes[0].activeRevision, LEGACY_RUNTIME);
    assert.equal(requested.hostedRuntimes[0].generation, 82);
    assert.equal(requested.hostedRuntimes[0].execution, null);
    assert.equal(reads(), 2);

    rig.clock.advance(1_000);
    const bootstrap = requireRun(await rig.prepare(2));
    assert.equal(bootstrap.purpose, "bootstrap");
    assert.equal(bootstrap.revision, SUCCESSOR);
    assert.equal(bootstrap.launcherSha, SUCCESSOR);
    assert.equal(bootstrap.generation, 83);
    const installed = await rig.snapshot();
    assert.deepEqual(installed.hostedInstallations![0], {
      ...journal,
      phase: "bootstrapping",
      pointerIntent: null,
      bootstrapExecutionId: bootstrap.id,
      updatedAt: rig.clock.now(),
    });
    assert.equal(installed.hostedRuntimes[0].activeRevision, SUCCESSOR);
    assert.equal(installed.hostedRuntimes[0].generation, 83);
    assert.deepEqual(installed.hostedRuntimes[0].execution, bootstrap);
    assert.equal(reads(), 3);
    const beforeReplay = await rig.release.readRelease();
    assert.deepEqual(requireRun(await rig.prepare(2)), bootstrap);
    assert.deepEqual(await rig.release.readRelease(), beforeReplay);
    assert.equal(reads(), 3);

    rig.clock.advance(5_000);
    rig.evidence.settlements.set(bootstrap.id, runProof(bootstrap, "healthy"));
    assert.equal((await rig.finalize(2)).status, "idle");
    const ordinary = requireRun(await rig.prepare(3));
    assert.equal(ordinary.purpose, "ordinary");
    assert.equal(ordinary.revision, SUCCESSOR);
    const accepted = (await rig.snapshot()).hostedInstallations![0];
    assert.equal(accepted.phase, "accepted");
    assert.deepEqual(accepted.ci, journal.ci);
    assert.deepEqual(await rig.repair.readRepair(), repairBefore);
  } finally {
    await rig.close();
  }
});

Deno.test("requested installation: refreshed CI must remain complete, successful and exact", async (t) => {
  for (
    const [name, response] of [
      ["pending", listing(pendingCheck)],
      ["failed", listing({ ...greenCheck(), conclusion: "failure" })],
      ["wrong SHA", listing({ ...greenCheck(), head_sha: LEGACY_RUNTIME })],
      ["foreign app", listing({ ...greenCheck(), app: { slug: "other" } })],
      ["missing", listing()],
      ["invalid ID", listing(greenCheck(0))],
      ["incomplete", { total_count: 2, check_runs: [greenCheck()] }],
      [
        "mixed latest",
        listing(greenCheck(), {
          ...greenCheck(93),
          conclusion: "failure",
        }),
      ],
    ] as const
  ) {
    await t.step(name, async () => {
      const rig = await liveInstallRig();
      try {
        const reads = useLatestCi(
          rig,
          (read) => read === 1 ? listing(greenCheck(91)) : response,
        );
        assert.equal((await rig.prepare(1)).status, "pending");
        const before = await rig.release.readRelease();
        const requested = await rig.snapshot();
        assert.equal(requested.hostedInstallations![0].phase, "requested");
        assert.deepEqual(requested.hostedInstallations![0].ci, {
          revision: SUCCESSOR,
          checkRunId: 91,
        });
        assert.equal(
          requested.hostedRuntimes[0].activeRevision,
          LEGACY_RUNTIME,
        );
        assert.equal(requested.hostedRuntimes[0].generation, 82);
        assert.equal(requested.hostedRuntimes[0].execution, null);
        assert.equal((await rig.prepare(2)).status, "pending");
        assert.deepEqual(await rig.release.readRelease(), before);
        assert.equal(reads(), 3);
      } finally {
        await rig.close();
      }
    });
  }
});
