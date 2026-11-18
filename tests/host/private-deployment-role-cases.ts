/**
 * Private-role cases. They run ONLY inside a tree copy whose committed private
 * entry is bound and wired, under GITHUB_REPOSITORY of the private repository
 * (`private-deployment-role_test.ts` builds that copy and runs this file);
 * every case first proves the copy selected the private entry.
 */
import assert from "node:assert/strict";
import {
  HOSTED_CONTROLLER_REMOTE,
  HOSTED_CONTROLLER_REPOSITORY,
  HOSTED_CONTROLLER_ROLE,
} from "../../src/contracts/hosted-controller-deployment.ts";
import { REMOTE_URL } from "../../src/host/hosted-runtime-identity.ts";
import {
  composeBackupCi,
  readBackupCiTargets,
} from "../../src/host/backup-ci-compose.ts";
import {
  HOSTED_SELF_INSTALLATION_REFUSED,
  readHostedAppCredentials,
} from "../../src/host/hosted-app-credentials.ts";
import { OWNER_DEVELOPMENT_INSTALL_REPOSITORY } from "../../src/host/owner-install-pins.ts";
import { ensureRepairStateSeed } from "../../src/host/actions-host-io.ts";
import { runActionsRepairHost } from "../../src/host/actions-repair-host.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import { PUBLIC_TARGET_REASON } from "../../src/repair/target-visibility.ts";
import { PRIVATE_TARGETS_KIND } from "../../src/repair/private-targets-line.ts";
import { scanStepLines } from "../../src/repair/step-line.ts";
import { rig } from "./matrix-actions-fixtures.ts";
import { hostedRepositoryKey } from "../../ops/hosted-autonomy.ts";
import {
  FOREIGN_REPO,
  foreignPullFacts,
  foreignReceipt,
  foreignRecord,
} from "./hosted-autonomy-fixtures.ts";
import { makeRig, repairSnapshot, run } from "./hosted-autonomy-rig.ts";
import {
  advanceWithLog,
  NO_MODEL,
  QUIET_LOG,
  quietly,
  reply,
  servingJobLogs,
} from "./targets-deferral-fixtures.ts";

const PRIVATE = "ubiquity-sentinel-private/sentinel";
// Built, never written whole, so no fixture rewrite can touch it.
const PUBLIC = ["ubiquity-sentinel", "sentinel"].join("/");
const SELF_INSTALLATION = 183425201;

function privateRole(): void {
  assert.equal(HOSTED_CONTROLLER_ROLE, "private");
  assert.equal(HOSTED_CONTROLLER_REPOSITORY, PRIVATE);
}

Deno.test("private role: identity, state remote and runtime remote are its own repository", () => {
  privateRole();
  const remote = `https://github.com/${PRIVATE}.git`;
  assert.equal(HOSTED_CONTROLLER_REMOTE, remote);
  assert.equal(REMOTE_URL, remote);
});

Deno.test("private role: the self installation must be the committed one", () => {
  privateRole();
  const env = (self: string | undefined) => (name: string) =>
    name === "SENTINEL_SELF_INSTALLATION_ID"
      ? self
      : name === "SENTINEL_TARGET_INSTALLATION_ID"
      ? "155687488"
      : undefined;
  assert.equal(
    readHostedAppCredentials(env(String(SELF_INSTALLATION)))
      .selfInstallationId,
    SELF_INSTALLATION,
  );
  // A self token minted for the public org, or none at all, never runs here.
  for (const self of ["155687488", "1", undefined]) {
    assert.throws(
      () => readHostedAppCredentials(env(self)),
      new RegExp(HOSTED_SELF_INSTALLATION_REFUSED),
    );
  }
});

Deno.test("private role: no backup CI — no targets, no reader, no git operation", async () => {
  privateRole();
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${root}/sentinel.backup-ci-targets.json`,
      await Deno.readTextFile("sentinel.backup-ci-targets.json"),
    );
    assert.deepEqual(await readBackupCiTargets(root), []);
    let gitCalls = 0;
    const consumer = await composeBackupCi({
      mode: "on",
      root,
      scratch: `${root}/scratch`,
      clock: { now: () => 0 },
      git: {
        run: () => {
          gitCalls++;
          throw new Error("no git operation on the private role");
        },
      } as unknown as Parameters<typeof composeBackupCi>[0]["git"],
    });
    assert.equal(consumer, undefined);
    assert.equal(gitCalls, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("private role: the owner development install chain stays public history", () => {
  privateRole();
  assert.equal(OWNER_DEVELOPMENT_INSTALL_REPOSITORY, PUBLIC);
  assert.notEqual(
    OWNER_DEVELOPMENT_INSTALL_REPOSITORY,
    HOSTED_CONTROLLER_REPOSITORY,
  );
});

const BODY = {
  private: '{"default_branch":"main","private":true,"visibility":"private"}',
  public: '{"default_branch":"main","private":false,"visibility":"public"}',
};

class CyclesReached extends Error {}

Deno.test("private role: the runtime configures its private target and sends no request naming the public repository", async () => {
  privateRole();
  const r = await rig();
  try {
    await ensureRepairStateSeed(r.store, r.clock);
    await advanceWithLog(r, 72, QUIET_LOG, 101);
    const deps = await r.job("private-role-runtime", "repair");
    assert.equal(deps.env.GITHUB_REPOSITORY, PRIVATE);
    await Deno.writeTextFile(
      `${deps.workDir}/sentinel.targets.json`,
      JSON.stringify([PUBLIC, "ubiquity/prospector", "ubiquity/ai.ubq.fi"]),
    );
    const urls: string[] = [];
    const reads: string[] = [];
    const bodies: Record<string, string> = {
      [`/repos/${PRIVATE}`]: BODY.private,
      "/repos/ubiquity/prospector": BODY.private,
      "/repos/ubiquity/ai.ubq.fi": BODY.public,
      [`/repos/${PUBLIC}`]: BODY.public,
    };
    const served = servingJobLogs(deps.http, new Map([[101, QUIET_LOG]]));
    const http: HttpTransportV1 = (request) => {
      urls.push(`${request.method} ${request.url}`);
      const path = new URL(request.url).pathname;
      const body = request.method === "GET" ? bodies[path] : undefined;
      if (body === undefined) return served(request);
      reads.push(path);
      return reply(200, {}, body)();
    };
    const configured: string[][] = [];
    const { value: outcome, lines } = await quietly(async () => {
      try {
        await runActionsRepairHost({
          ...deps,
          // The self token is minted on the private org's installation.
          env: {
            ...deps.env,
            SENTINEL_SELF_INSTALLATION_ID: String(SELF_INSTALLATION),
          },
          resolveRepository: undefined,
          state: r.store,
          http,
          model: NO_MODEL,
          preflight: () => Promise.resolve(),
          runTargetCycles: (input) => {
            configured.push(
              input.configs.map((config) =>
                `${config.repository.owner}/${config.repository.name}`
              ),
            );
            throw new CyclesReached();
          },
        });
        return "returned";
      } catch (error) {
        return error instanceof CyclesReached ? "cycles" : String(error);
      }
    });
    assert.equal(outcome, "cycles");
    // Only the private target is worked; public Sentinel and the public
    // target are left to the public deployment without any read of them.
    assert.deepEqual(configured, [["ubiquity/prospector"]]);
    assert.ok(reads.includes(`/repos/${PRIVATE}`), reads.join("\n"));
    assert.ok(urls.length > 0);
    const leaked = urls.filter((url) =>
      url.includes(`/${PUBLIC}/`) || url.endsWith(`/${PUBLIC}`)
    );
    assert.deepEqual(leaked, [], urls.join("\n"));
    assert.deepEqual(
      scanStepLines(lines.join("\n")).filter((entry) =>
        entry.kind === PRIVATE_TARGETS_KIND
      ).map((entry) => (entry as { reason?: string }).reason),
      [PUBLIC_TARGET_REASON],
    );
  } finally {
    await r.cleanup();
  }
});

Deno.test("private role: the launcher merges a reviewed target pull request through its own surface only", async () => {
  privateRole();
  const resolved: string[] = [];
  const { rig: launcher, github } = await makeRig("private-role-merge", {
    repair: repairSnapshot([foreignRecord()], [foreignReceipt()]),
    pull: foreignPullFacts({
      state: "open",
      merged: false,
      mergeCommitSha: null,
    }),
    afterMerge: foreignPullFacts(),
    resolver: (repository) => {
      resolved.push(hostedRepositoryKey(repository));
      return github;
    },
  });
  try {
    const result = await run(launcher);
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.equal(launcher.merges, 1);
    assert.deepEqual([...new Set(resolved)], [
      hostedRepositoryKey(FOREIGN_REPO),
    ]);
  } finally {
    await Deno.remove(launcher.tmp, { recursive: true });
  }
});

Deno.test("private role: a launcher pass that wrote nothing reports the closed reason and never resolves Sentinel", async () => {
  privateRole();
  const resolved: string[] = [];
  const { rig: launcher, github } = await makeRig("private-role-quiet", {
    repair: repairSnapshot([], []),
    resolver: (repository) => {
      resolved.push(hostedRepositoryKey(repository));
      return github;
    },
  });
  try {
    const result = await run(launcher);
    assert.equal(result.status, "skipped", JSON.stringify(result));
    assert.ok(
      result.actions.includes("self-observation:skipped:private_deployment"),
      JSON.stringify(result.actions),
    );
    assert.ok(
      !result.actions.some((action) =>
        action.startsWith("ci-outage:") ||
        (action.startsWith("self-observation:") &&
          action !== "self-observation:skipped:private_deployment")
      ),
      JSON.stringify(result.actions),
    );
    assert.deepEqual(resolved, []);
  } finally {
    await Deno.remove(launcher.tmp, { recursive: true });
  }
});
