/**
 * Launcher self-install ancestry through the real supervisor and the native
 * compare parser. Live 2026-11-14 the launcher was advanced to ab84c0d while
 * the runtime stayed on 6e74557, and GitHub compares those with ahead_by 12
 * and total_commits 18: the listing also counts commits the base already
 * reaches when commit dates are skewed. The former counter equality made the
 * ancestry evidence unavailable, so every pass skipped the install and ran the
 * old runtime without writing a record. A true descendant must be requested
 * and bootstrapped; any other compare must still leave no installation.
 */
import assert from "node:assert/strict";
import { CONTROLLER } from "./controller-identity-fixture.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { HostedSupervisorGitHubClient } from "../../src/host/actions-supervisor-install-api.ts";
import { isTerminalPhase } from "../../src/host/actions-supervisor-state.ts";
import { requireRun } from "./actions-supervisor-fixture.ts";
import {
  LEGACY_RUNTIME,
  liveInstallRig,
  SUCCESSOR,
} from "./hosted-self-install-fixtures.ts";

type Rig = Awaited<ReturnType<typeof liveInstallRig>>;
type Compare = Record<string, unknown>;

const OTHER = "d".repeat(40);
/** The live runtime → launcher compare shape: 12 ahead, 18 listed. */
const SKEWED: Compare = {
  status: "ahead",
  base_commit: { sha: LEGACY_RUNTIME },
  merge_base_commit: { sha: LEGACY_RUNTIME },
  ahead_by: 12,
  behind_by: 0,
  total_commits: 18,
};

/** The real client answers the runtime → launcher compare with `body`. */
function useCompare(rig: Rig, body: Compare): () => number {
  let compares = 0;
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
      const url = new URL(request.url);
      assert.equal(request.method, "GET");
      let value: unknown = { sha: SUCCESSOR };
      if (url.pathname !== `${CONTROLLER.apiPath}/commits/${SUCCESSOR}`) {
        assert.equal(
          url.pathname,
          `${CONTROLLER.apiPath}/compare/${LEGACY_RUNTIME}...${SUCCESSOR}`,
        );
        compares++;
        value = body;
      }
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        bodyText: JSON.stringify(value),
      });
    },
  });
  rig.evidence.verifyAncestor = client.verifyAncestor.bind(client);
  return () => compares;
}

Deno.test("self-install: a launcher whose compare lists more commits than are ahead installs (2026-11-14)", async () => {
  const rig = await liveInstallRig();
  try {
    const compares = useCompare(rig, SKEWED);
    // The public seed keeps one open release at the runtime revision; the
    // install proves it included in the successor through the same compare.
    const open = (await rig.snapshot()).hostedReleases.filter((r) =>
      !isTerminalPhase(r.phase)
    );
    const bootstrap = requireRun(await rig.prepare(1));
    assert.equal(bootstrap.purpose, "bootstrap", "the install was skipped");
    assert.equal(bootstrap.revision, SUCCESSOR);
    assert.equal(bootstrap.launcherSha, SUCCESSOR);
    assert.equal(bootstrap.generation, 83);
    const installed = await rig.snapshot();
    const journal = installed.hostedInstallations![0];
    assert.equal(journal.phase, "bootstrapping");
    assert.equal(journal.candidateRevision, SUCCESSOR);
    assert.equal(journal.previousRevision, LEGACY_RUNTIME);
    assert.equal(installed.hostedRuntimes[0].activeRevision, SUCCESSOR);
    assert.deepEqual(installed.hostedRuntimes[0].execution, bootstrap);
    for (const release of open) {
      assert.equal(release.request.revision, LEGACY_RUNTIME);
      const after = installed.hostedReleases.find((r) => r.id === release.id);
      assert.equal(after?.phase, "abandoned");
      assert.equal(after?.abandonment?.reason, "included_in_successor");
    }
    // The request, its move to bootstrapping and each open release.
    assert.equal(compares(), 2 + open.length);
  } finally {
    await rig.close();
  }
});

Deno.test("self-install: a compare that does not prove ancestry installs nothing", async (t) => {
  const cases: Array<[string, Compare]> = [
    ["diverged", {
      ...SKEWED,
      status: "diverged",
      merge_base_commit: { sha: OTHER },
      behind_by: 1,
      total_commits: 12,
    }],
    ["behind", {
      ...SKEWED,
      status: "behind",
      merge_base_commit: { sha: SUCCESSOR },
      ahead_by: 0,
      behind_by: 1,
      total_commits: 0,
    }],
    ["ahead with behind_by", { ...SKEWED, behind_by: 1 }],
    ["merge base is not the runtime", {
      ...SKEWED,
      merge_base_commit: { sha: OTHER },
    }],
    ["compare base is not the runtime", {
      ...SKEWED,
      base_commit: { sha: OTHER },
    }],
    ["ahead with an empty listing", { ...SKEWED, total_commits: 0 }],
    ["ahead with nothing ahead", { ...SKEWED, ahead_by: 0 }],
    ["identical with commits", {
      ...SKEWED,
      status: "identical",
      ahead_by: 0,
    }],
    ["negative counter", { ...SKEWED, total_commits: -1 }],
    ["fractional counter", { ...SKEWED, ahead_by: 12.5 }],
    ["missing counter", { ...SKEWED, behind_by: undefined }],
  ];
  for (const [name, body] of cases) {
    await t.step(name, async () => {
      const rig = await liveInstallRig();
      try {
        const compares = useCompare(rig, body);
        const ordinary = requireRun(await rig.prepare(1));
        assert.equal(ordinary.purpose, "ordinary");
        assert.equal(ordinary.revision, LEGACY_RUNTIME);
        const snapshot = await rig.snapshot();
        assert.equal(snapshot.hostedInstallations, undefined);
        assert.equal(snapshot.hostedRuntimes[0].activeRevision, LEGACY_RUNTIME);
        assert.equal(snapshot.hostedRuntimes[0].generation, 82);
        assert.ok(compares() >= 1);
      } finally {
        await rig.close();
      }
    });
  }
});
