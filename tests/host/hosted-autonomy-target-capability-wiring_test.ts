/**
 * Issue #332 wiring: the hosted maintenance glue over the launcher's own
 * surfaces. The runtime pointer generation comes from release state, the
 * targets from live work, the tip and the exact-tip tree facts from the
 * target's surface, and the owner issue goes through the real
 * `createHostedCapabilityIssues` adapter over a fake GitHub. A failed
 * recording write is recovered by the marker lookup; an unavailable
 * generation, a passed deadline or a throwing surface only append actions.
 */
import assert from "node:assert/strict";
import { HOSTED_RUNTIME_ID } from "../../src/contracts/hosted-supervisor.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { TargetTreeFactsV1 } from "../../src/host/target-policy-generic.ts";
import { cachedTargetCapabilityV1 } from "../../src/repair/target-capability.ts";
import { createHostedCapabilityIssues } from "../../ops/hosted-autonomy-github-issues.ts";
import type { createHostedAutonomyRequest } from "../../ops/hosted-autonomy-github-listing.ts";
import { HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR } from "../../ops/hosted-autonomy-policy.ts";
import { runHostedTargetCapabilityPass } from "../../ops/hosted-autonomy-target-capability.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyGitHubV1,
} from "../../ops/hosted-autonomy-types.ts";
import { FakeClock, MemoryState } from "../repair/helpers.ts";
import { SHA2, T0, workRecord } from "../state/helpers.ts";

const PROSPECTOR = {
  owner: "ubiquity",
  name: "prospector-chrome-extension",
  installationId: 7,
};
const URL_BASE =
  "https://api.github.com/repos/ubiquity/prospector-chrome-extension";
const NO_CI: TargetTreeFactsV1 = {
  files: ["package.json", "package-lock.json"],
  hasCiWorkflow: false,
  manifestScripts: { package: ["build"] },
};

/** A fake GitHub issues API for one repository. */
class FakeIssuesApi {
  issues: { number: number; title: string; body: string }[] = [];
  creates = 0;
  patches = 0;
  listings = 0;
  item(issue: { number: number; title: string; body: string }) {
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: "open",
      user: { login: HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR },
      created_at: "2026-11-05T00:00:00Z",
      repository_url: URL_BASE,
    };
  }
  request = ((
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> => {
    const scope = "/repos/ubiquity/prospector-chrome-extension/issues";
    if (method === "GET" && path.startsWith(`${scope}?creator=`)) {
      this.listings++;
      assert.match(path, /state=open/);
      return Promise.resolve(
        path.includes("page=1") ? this.issues.map((i) => this.item(i)) : [],
      );
    }
    if (method === "POST" && path === scope) {
      this.creates++;
      const issue = {
        number: 100 + this.issues.length,
        title: String(body!.title),
        body: String(body!.body),
      };
      this.issues.push(issue);
      return Promise.resolve(this.item(issue));
    }
    const patch = path.match(/\/issues\/(\d+)$/);
    if (method === "PATCH" && patch !== null) {
      this.patches++;
      const issue = this.issues.find((i) => i.number === Number(patch[1]));
      if (issue === undefined) return Promise.resolve(null);
      issue.title = String(body!.title);
      issue.body = String(body!.body);
      return Promise.resolve(this.item(issue));
    }
    return Promise.resolve(null);
  }) as unknown as ReturnType<typeof createHostedAutonomyRequest>;
}

async function rig(work: WorkRecordV1[], generation: number | null = 9) {
  const state = new MemoryState();
  const seeded = await state.writeRepair(
    parseRepairStateSnapshotV1({
      version: "v1",
      kind: "repair_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0,
      incidents: [],
      evidence: [],
      work,
      reservations: [],
      reviews: [],
      replays: [],
      releaseRequests: [],
      githubCooldowns: [],
      attemptMemory: [],
      lessons: [],
    }),
    null,
  );
  assert.ok(seeded.ok && seeded.value.status === "applied");
  if (generation !== null) {
    state.setRelease({
      hostedRuntimes: [{ id: HOSTED_RUNTIME_ID, generation }],
    });
  }
  const api = new FakeIssuesApi();
  const reads = { facts: [] as string[] };
  const surface = {
    readDefaultBranch: () => Promise.resolve("main"),
    readBaseTip: (branch: string) => {
      assert.equal(branch, "main");
      return Promise.resolve(SHA2);
    },
    readTreeFacts: (commit: string) => {
      reads.facts.push(commit);
      return Promise.resolve(NO_CI);
    },
    capabilityIssues: createHostedCapabilityIssues(api.request, PROSPECTOR),
  } as unknown as HostedAutonomyGitHubV1;
  const deps = {
    state,
    clock: new FakeClock(T0 + 5_000),
    githubFor: () => surface,
    backupCiTargets: ["ubiquity/prospector-chrome-extension"],
  } as unknown as HostedAutonomyDepsV1;
  return { state, api, reads, deps };
}

const record = () => workRecord("prospector-1", { repository: PROSPECTOR });

Deno.test("capability wiring: the hosted pass files one marked issue at the exact tip and records it", async () => {
  const { state, api, reads, deps } = await rig([record()]);
  const actions = await runHostedTargetCapabilityPass(deps, T0 + 60_000);
  assert.deepEqual(reads.facts, [SHA2], "facts are read at exactly the tip");
  assert.equal(api.creates, 1);
  assert.equal(api.listings, 1, "the marker is looked up before creating");
  const body = api.issues[0]!.body.split("\n");
  assert.equal(body[0], "<!-- sentinel:skip -->");
  assert.equal(body[1], "<!-- sentinel:target-capability -->");
  const row = cachedTargetCapabilityV1(state.repair!, PROSPECTOR)!;
  assert.equal(row.generation, 9);
  assert.equal(row.ownerIssue, 100);
  assert.equal(row.backupCovered, true);
  assert.equal(state.repair!.reservations.length, 0);
  assert.ok(actions.includes(
    "capability:ubiquity/prospector-chrome-extension:issue_created:100",
  ));

  const again = await runHostedTargetCapabilityPass(deps, T0 + 60_000);
  assert.equal(api.creates, 1);
  assert.equal(api.patches, 0);
  assert.equal(reads.facts.length, 1, "unchanged tip and generation reuse");
  assert.ok(again.includes(
    "capability:ubiquity/prospector-chrome-extension:incapable",
  ));
});

Deno.test("capability wiring: a failed recording write is adopted from the marker, not duplicated", async () => {
  const { state, api, deps } = await rig([record()]);
  state.conflictRepairNext = true;
  const first = await runHostedTargetCapabilityPass(deps, T0 + 60_000);
  assert.ok(first.includes("capability:write_conflict"));
  assert.equal(state.repair!.targetCapabilities, undefined);
  await runHostedTargetCapabilityPass(deps, T0 + 60_000);
  assert.equal(api.creates, 1, "exactly one issue exists");
  assert.equal(api.patches, 1);
  assert.equal(
    cachedTargetCapabilityV1(state.repair!, PROSPECTOR)!.ownerIssue,
    100,
  );
});

Deno.test("capability wiring: no generation, a passed deadline or a throwing surface defer without a write", async () => {
  const missing = await rig([record()], null);
  assert.deepEqual(
    await runHostedTargetCapabilityPass(missing.deps, T0 + 60_000),
    ["capability:generation_unavailable"],
  );
  assert.equal(missing.api.creates, 0);

  const late = await rig([record()]);
  assert.deepEqual(
    await runHostedTargetCapabilityPass(late.deps, T0 + 5_000),
    ["capability:deadline"],
  );

  const throwing = await rig([record()]);
  const writes = throwing.state.repairWrites;
  assert.deepEqual(
    await runHostedTargetCapabilityPass(
      {
        ...throwing.deps,
        githubFor: () => {
          throw new Error("surface unavailable");
        },
      },
      T0 + 60_000,
    ),
    [],
  );
  const surface = throwing.deps.githubFor(PROSPECTOR)!;
  const actions = await runHostedTargetCapabilityPass(
    {
      ...throwing.deps,
      githubFor: () => ({
        ...surface,
        readBaseTip: () => Promise.reject(new Error("tip unavailable")),
      }),
    },
    T0 + 60_000,
  );
  assert.ok(actions.includes(
    "capability:ubiquity/prospector-chrome-extension:tip_unreadable",
  ));
  assert.equal(throwing.state.repairWrites, writes);
});

Deno.test("capability wiring: a surface without the capability costs nothing", async () => {
  const { api, deps } = await rig([record()]);
  const surface = deps.githubFor(PROSPECTOR)!;
  const bare = { ...surface, readTreeFacts: undefined };
  const actions = await runHostedTargetCapabilityPass(
    { ...deps, githubFor: () => bare },
    T0 + 60_000,
  );
  assert.deepEqual(actions, []);
  assert.equal(api.listings + api.creates, 0);
});

Deno.test("capability wiring: self, named and done work is never checked", async () => {
  const gateway = workRecord("gateway-1");
  const done = workRecord("prospector-done", {
    repository: PROSPECTOR,
    nextStep: "done",
  });
  const { api, deps } = await rig([gateway, done]);
  const actions = await runHostedTargetCapabilityPass(deps, T0 + 60_000);
  assert.deepEqual(actions, []);
  assert.equal(api.listings + api.creates, 0);
});
