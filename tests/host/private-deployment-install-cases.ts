/**
 * Private-role launcher installation. Runs ONLY inside a bound copy run as
 * the private deployment (`private-deployment-install_test.ts`), over the
 * live-install rig: real Git release and repair state, the production
 * supervisor prepare/finalize and the production install API client over a
 * fake read-only GitHub.
 *
 * - A new launcher SHA whose private `test-local` check is green installs:
 *   generation+1 model-disabled bootstrap, then ordinary work on it; every
 *   read names the private repository only.
 * - With that check skipped, absent, still running or red, nothing starts:
 *   no ordinary, bootstrap or release execution on the mismatched launcher,
 *   and no state write (the run ends after prepare with the closed hold).
 */
import assert from "node:assert/strict";
import {
  HOSTED_CONTROLLER_CYCLE_CELLS,
  HOSTED_CONTROLLER_REPOSITORY,
  HOSTED_CONTROLLER_ROLE,
} from "../../src/contracts/hosted-controller-deployment.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { HostedSupervisorGitHubClient } from "../../src/host/actions-supervisor-install-api.ts";
import { PRIVATE_LAUNCHER_NOT_INSTALLED } from "../../src/host/actions-supervisor-controller.ts";
import { CONTROLLER } from "./controller-identity-fixture.ts";
import { requireRun, runProof } from "./actions-supervisor-fixture.ts";
import {
  LEGACY_RUNTIME,
  liveInstallRig,
  SUCCESSOR,
} from "./hosted-self-install-fixtures.ts";

const PRIVATE = "ubiquity-sentinel-private/sentinel";
// Built, never written whole, so no fixture rewrite can touch it.
const PUBLIC = ["ubiquity-sentinel", "sentinel"].join("/");

function privateRole(): void {
  assert.equal(HOSTED_CONTROLLER_ROLE, "private");
  assert.equal(HOSTED_CONTROLLER_REPOSITORY, PRIVATE);
  assert.equal(CONTROLLER.apiPath, `/repos/${PRIVATE}`);
}

const check = (overrides: Record<string, unknown> = {}) => ({
  id: 92,
  name: "test-local",
  head_sha: SUCCESSOR,
  status: "completed",
  conclusion: "success",
  app: { slug: "github-actions" },
  ...overrides,
});
const listing = (...checks: unknown[]) => ({
  total_count: checks.length,
  check_runs: checks,
});

Deno.test("private install: a green private test-local installs the launcher at generation+1, then ordinary", async () => {
  privateRole();
  assert.deepEqual({ ...HOSTED_CONTROLLER_CYCLE_CELLS }, {
    matrix: 1,
    repair: 2,
  });
  const rig = await liveInstallRig();
  try {
    let outcome = await rig.prepare(1);
    if (outcome.status === "pending") {
      // The requested journal settles first; the next prepare promotes.
      assert.equal(
        (await rig.snapshot()).hostedInstallations?.[0]?.phase,
        "requested",
      );
      rig.clock.advance(1_000);
      outcome = await rig.prepare(2);
    }
    const bootstrap = requireRun(outcome);
    assert.equal(bootstrap.purpose, "bootstrap");
    assert.equal(bootstrap.revision, SUCCESSOR);
    assert.equal(bootstrap.launcherSha, SUCCESSOR);
    assert.equal(bootstrap.generation, 83);
    rig.clock.advance(5_000);
    rig.evidence.settlements.set(bootstrap.id, runProof(bootstrap, "healthy"));
    const runId = bootstrap.runId;
    assert.equal((await rig.finalize(runId)).status, "idle");
    const ordinary = requireRun(await rig.prepare(runId + 1));
    assert.equal(ordinary.purpose, "ordinary");
    assert.equal(ordinary.revision, SUCCESSOR);
    assert.equal(ordinary.generation, 83);
    const installed = await rig.snapshot();
    assert.equal(installed.hostedInstallations?.[0]?.phase, "accepted");
    // Every install read is the private repository's own.
    assert.ok(rig.calls.length > 0);
    assert.deepEqual(
      rig.calls.filter((path) => !path.startsWith(`/repos/${PRIVATE}/`)),
      [],
    );
    assert.ok(!rig.calls.some((path) => path.includes(PUBLIC)));
  } finally {
    await rig.close();
  }
});

Deno.test("private install: without a green private test-local nothing starts on the mismatched launcher", async (t) => {
  privateRole();
  for (
    const [name, response] of [
      ["skipped (gated CI)", listing(check({ conclusion: "skipped" }))],
      ["absent", listing()],
      [
        "still running",
        listing(check({ status: "in_progress", conclusion: null })),
      ],
      ["red", listing(check({ conclusion: "failure" }))],
    ] as const
  ) {
    await t.step(name, async () => {
      const rig = await liveInstallRig();
      try {
        const reads: string[] = [];
        const client = new HostedSupervisorGitHubClient({
          repository: CONTROLLER.repository,
          apiBaseUrl: "https://api.github.com",
          clock: rig.clock,
          auth: {
            authorizationHeader: () =>
              Promise.resolve(portOk("Bearer synthetic")),
          },
          cooldownGate: {
            beforeRequest: () => Promise.resolve(portOk(undefined)),
            recordRateLimit: () => Promise.resolve(portOk(undefined)),
          },
          http: (request) => {
            const url = new URL(request.url);
            reads.push(url.pathname);
            assert.equal(
              url.pathname,
              `/repos/${PRIVATE}/commits/${SUCCESSOR}/check-runs`,
            );
            return Promise.resolve({
              status: 200,
              headers: new Headers(),
              bodyText: JSON.stringify(response),
            });
          },
        });
        rig.evidence.verifyLauncherCi = client.verifyLauncherCi.bind(client);
        const before = await rig.release.readRelease();
        const repairBefore = await rig.repair.readRepair();
        assert.deepEqual(await rig.prepare(1), {
          status: "pending",
          detail: PRIVATE_LAUNCHER_NOT_INSTALLED,
        });
        assert.equal(reads.length, 1);
        // No execution, no installation journal, no write of any kind.
        assert.deepEqual(await rig.release.readRelease(), before);
        assert.deepEqual(await rig.repair.readRepair(), repairBefore);
        const after = await rig.snapshot();
        assert.equal(after.hostedRuntimes[0].execution, null);
        assert.equal(after.hostedRuntimes[0].activeRevision, LEGACY_RUNTIME);
        assert.equal(after.hostedInstallations?.length ?? 0, 0);
        // The next day's run without new evidence holds the same way.
        rig.clock.advance(24 * 3_600_000);
        assert.equal((await rig.prepare(2)).status, "pending");
        assert.deepEqual(await rig.release.readRelease(), before);
      } finally {
        await rig.close();
      }
    });
  }
});
