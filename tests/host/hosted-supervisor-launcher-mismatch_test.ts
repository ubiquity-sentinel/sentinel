/**
 * The private role's mismatched-launcher hold
 * (`PRIVATE_LAUNCHER_NOT_INSTALLED`, 2026-11-22) leaves the public role
 * exactly as before: with no green `test-local` for a new launcher SHA, the
 * public supervisor still starts ordinary work on the installed revision
 * (`private-deployment-install_test.ts` proves the private hold).
 */
import assert from "node:assert/strict";
import { HOSTED_CONTROLLER_ROLE } from "../../src/contracts/hosted-controller-deployment.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { HostedSupervisorGitHubClient } from "../../src/host/actions-supervisor-install-api.ts";
import { CONTROLLER } from "./controller-identity-fixture.ts";
import { requireRun } from "./actions-supervisor-fixture.ts";
import {
  LEGACY_RUNTIME,
  liveInstallRig,
  SUCCESSOR,
} from "./hosted-self-install-fixtures.ts";

Deno.test("public role: a launcher without green CI keeps ordinary work on the installed revision", async () => {
  assert.equal(HOSTED_CONTROLLER_ROLE, "public");
  const rig = await liveInstallRig();
  try {
    const client = new HostedSupervisorGitHubClient({
      repository: CONTROLLER.repository,
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
        assert.equal(
          new URL(request.url).pathname,
          `${CONTROLLER.apiPath}/commits/${SUCCESSOR}/check-runs`,
        );
        return Promise.resolve({
          status: 200,
          headers: new Headers(),
          bodyText: JSON.stringify({ total_count: 0, check_runs: [] }),
        });
      },
    });
    rig.evidence.verifyLauncherCi = client.verifyLauncherCi.bind(client);
    const ordinary = requireRun(await rig.prepare(1));
    assert.equal(ordinary.purpose, "ordinary");
    assert.equal(ordinary.revision, LEGACY_RUNTIME);
    assert.equal(ordinary.launcherSha, SUCCESSOR);
    assert.equal((await rig.snapshot()).hostedInstallations?.length ?? 0, 0);
  } finally {
    await rig.close();
  }
});
