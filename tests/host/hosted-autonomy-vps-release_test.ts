import assert from "node:assert/strict";
import {
  DORMANT_HOSTED_SUPERVISOR_POLICY,
  withHostedProductionPolicy,
} from "./hosted-supervisor-policy-fixture.ts";
import { withDarkQueueAuthority } from "./hosted-autonomy-preservation-fixtures.ts";

import {
  authorizingReceipt,
  BASE,
  deliveryRecord,
  FOREIGN_PR,
  FOREIGN_REPO as UNRELATED_REPO,
  FOREIGN_TASK,
  foreignPullFacts,
  foreignReceipt as unrelatedForeignReceipt,
  foreignRecord as unrelatedForeignRecord,
  HEAD,
  MERGE,
  pullFacts,
  repositoryTask as unrelatedRepositoryTask,
} from "./hosted-autonomy-fixtures.ts";
import {
  makeRig,
  repairSnapshot,
  type RigV1,
  run,
} from "./hosted-autonomy-rig.ts";
import { persistVpsDelivery } from "../repair/vps-delivery-fixtures.ts";
import { createReleaseStateStore } from "../../src/state/mod.ts";
import { buildHostedReleaseRequest } from "../../ops/hosted-autonomy-delivery.ts";
import { reservation, T0 } from "../state/helpers.ts";
import {
  reviewTaskStatementDigest,
  type ReviewTaskStatementV1,
} from "../../src/contracts/review-receipt.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy-github.ts";

/** Historical direct-delivery semantics use one explicit dormant graph per scenario. */
type HistoricalRun = typeof import("./hosted-autonomy-rig.ts").run;
function historicalTest(
  name: string,
  check: (run: HistoricalRun) => Promise<void>,
) {
  Deno.test(
    name,
    () =>
      withHostedProductionPolicy(
        DORMANT_HOSTED_SUPERVISOR_POLICY,
        async (graph) => {
          const { runHostedAutonomy } = await graph.runner();
          await check(async (rig, github) =>
            runHostedAutonomy(
              await withDarkQueueAuthority({
                state: rig.state,
                githubFor: github === undefined ? rig.githubFor : () => github,
                clock: { now: () => T0 + 5_000_000 },
              }),
            )
          );
        },
      ),
  );
}

const FOREIGN_REPO = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 7,
} as const;
const foreignRecord = () => ({
  ...unrelatedForeignRecord(),
  repository: FOREIGN_REPO,
});
const foreignReceipt = () => ({
  ...unrelatedForeignReceipt(),
  repository: FOREIGN_REPO,
});
const repositoryTask = (_repository: typeof FOREIGN_REPO, number: number) =>
  unrelatedRepositoryTask(UNRELATED_REPO, number);

async function snapshot(rig: RigV1) {
  const read = await rig.state.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  return read.value;
}

async function acceptedMaintenance(
  phase: "accepted" | "rolled_back" | "monitoring" | "failed" = "accepted",
) {
  const record = foreignRecord();
  const review = foreignReceipt();
  const request = await buildHostedReleaseRequest(
    FOREIGN_REPO,
    MERGE,
    HEAD,
    BASE,
    FOREIGN_PR,
    review,
    T0,
  );
  assert.ok(request);
  const charge = reservation("gateway-maintenance-original", {
    repository: record.repository,
    taskId: record.id,
    head: HEAD,
    outcome: "submitted",
    settledAt: T0 + 1000,
  });
  const { rig, github } = await makeRig(`vps-maintenance-${phase}`, {
    repair: repairSnapshot([record], [review], [request], [charge]),
    pull: foreignPullFacts(),
    issueOpen: false,
    issueTask: (number) =>
      Promise.resolve(repositoryTask(FOREIGN_REPO, number)),
  });
  const surface = {
    ...github,
    readIssueOptedOut: () => Promise.resolve(false as boolean | null),
  };
  rig.githubFor = () => surface;
  const release = createReleaseStateStore({
    remoteUrl: `${rig.tmp}/remote.git`,
    scratchDir: `${rig.tmp}/vps-release`,
  });
  let now = T0 + 1000;
  const reached = await persistVpsDelivery(
    rig.state,
    release,
    {
      now: () => now,
      advance: (ms) => {
        now += ms;
      },
    },
    request,
    phase,
  );
  return { rig, github, surface, release, reached, record, request, charge };
}

historicalTest(
  "gateway VPS maintenance: platform closure and source merge cannot accept delivery",
  async (run) => {
    const { rig } = await makeRig("vps-no-receipt", {
      repair: repairSnapshot([foreignRecord()], [foreignReceipt()]),
      pull: foreignPullFacts(),
      issueOpen: false,
      issueTask: (number) =>
        Promise.resolve(repositoryTask(FOREIGN_REPO, number)),
    });
    try {
      await run(rig);
      assert.deepEqual(
        rig.closed,
        [],
        "no explicit close before VPS acceptance",
      );
      const read = await rig.state.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      assert.equal(read.value.snapshot.work[0].nextStep, "delivery");
      assert.equal(read.value.snapshot.work[0].intent, null);
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
    }
  },
);

historicalTest(
  "gateway VPS maintenance: exact accepted Git receipt and current source reconcile platform closure once",
  async (run) => {
    const context = await acceptedMaintenance();
    const { rig, surface, record, request, charge } = context;
    try {
      const originalTask = surface.readIssueTask!;
      const originalOpen = surface.readIssueOpen;
      for (
        const task of [null, {
          ...FOREIGN_TASK,
          issueNumber: FOREIGN_TASK.issueNumber + 1,
        }, {
          ...FOREIGN_TASK,
          body: "changed source",
          digest: await reviewTaskStatementDigest({
            ...FOREIGN_TASK,
            body: "changed source",
          }),
        }] as (ReviewTaskStatementV1 | null)[]
      ) {
        surface.readIssueTask = () => Promise.resolve(task);
        await run(rig);
        assert.equal((await snapshot(rig)).snapshot.work[0].intent, null);
        assert.deepEqual(rig.closed, []);
      }
      surface.readIssueTask = originalTask;
      for (const optedOut of [true, null]) {
        surface.readIssueOptedOut = () => Promise.resolve(optedOut);
        await run(rig);
        assert.equal(
          (await snapshot(rig)).snapshot.work[0].nextStep,
          "delivery",
        );
        assert.equal((await snapshot(rig)).snapshot.work[0].intent, null);
      }
      surface.readIssueOptedOut = () => Promise.resolve(false);
      const first = await run(rig);
      assert.equal(first.status, "applied", JSON.stringify(first));
      assert.equal(
        (await snapshot(rig)).snapshot.work[0].intent?.requestId,
        request.id,
      );
      assert.deepEqual(rig.closed, [], "persist intent before explicit close");
      surface.readIssueOpen = () => Promise.resolve(null);
      await run(rig);
      assert.equal((await snapshot(rig)).snapshot.work[0].nextStep, "delivery");
      assert.deepEqual(rig.closed, []);
      surface.readIssueOpen = originalOpen;
      const result = await run(rig);
      assert.equal(result.reason, "closed_issues", JSON.stringify(result));
      assert.ok(
        result.actions.includes(`reconcile:${record.id}:already_closed`),
      );
      const done = (await snapshot(rig)).snapshot;
      assert.equal(done.work[0].nextStep, "done");
      assert.deepEqual(done.releaseRequests, [request]);
      assert.deepEqual(done.reservations, [charge]);
      assert.deepEqual(
        rig.closed,
        [],
        "platform close needs no duplicate mutation",
      );
      const before = done.sequence;
      await run(rig);
      assert.equal((await snapshot(rig)).snapshot.sequence, before);
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
    }
  },
);

historicalTest(
  "gateway VPS maintenance: nonaccepted and rolled-back receipts preserve delivery provenance",
  async (run) => {
    for (const phase of ["monitoring", "rolled_back", "failed"] as const) {
      const { rig, record, request, charge } = await acceptedMaintenance(phase);
      try {
        await run(rig);
        const after = (await snapshot(rig)).snapshot;
        assert.equal(
          after.work[0].nextStep,
          phase === "monitoring" ? "delivery" : "blocked",
        );
        assert.deepEqual(after.work[0].target, record.target);
        assert.deepEqual(after.reservations, [charge]);
        assert.deepEqual(after.releaseRequests, [request]);
        assert.deepEqual(rig.closed, []);
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    }
  },
);

historicalTest(
  "gateway VPS maintenance: changed terminal readback and wrong binding cannot close",
  async (run) => {
    const { rig, reached } = await acceptedMaintenance();
    try {
      const readRelease = rig.state.readRelease;
      const valid = reached.release.snapshot;
      const record = valid.vpsReleases![0];
      const wrong: ReleaseStateSnapshotV1 = {
        ...valid,
        vpsReleases: [{
          ...record,
          driver: {
            ...record.driver,
            binding: { ...record.driver.binding, requestId: "another-request" },
          },
        }],
      };
      for (const view of [wrong, { ...valid, vpsReleases: [] }]) {
        rig.state.readRelease = () =>
          Promise.resolve(portOk({ ...reached.release, snapshot: view }));
        await run(rig);
        assert.equal(
          (await snapshot(rig)).snapshot.work[0].nextStep,
          "delivery",
        );
        assert.deepEqual(rig.closed, []);
      }
      let reads = 0;
      rig.state.readRelease = async () => {
        const current = await readRelease();
        if (
          current.ok && current.value.status === "found" && ++reads % 2 === 0
        ) {
          return portOk({ ...current.value, head: "f".repeat(40) as GitSha });
        }
        return current;
      };
      await run(rig);
      assert.equal((await snapshot(rig)).snapshot.work[0].intent, null);
      assert.deepEqual(rig.closed, []);
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
    }
  },
);

historicalTest(
  "gateway VPS maintenance: real request CAS and lost reply retain one original request",
  async (run) => {
    for (const lost of [false, true]) {
      const { rig, github } = await makeRig("vps-request-cas", {
        repair: repairSnapshot([foreignRecord()], [foreignReceipt()]),
        pull: foreignPullFacts(),
        issueTask: (number) =>
          Promise.resolve(repositoryTask(FOREIGN_REPO, number)),
      });
      rig.githubFor = () => ({
        ...github,
        readIssueOptedOut: () => Promise.resolve(false),
      });
      try {
        const writeRepair = rig.state.writeRepair;
        rig.state.writeRepair = async (next, head) => {
          if (!lost) return portOk({ status: "conflict", currentHead: head });
          const write = await writeRepair(next, head);
          assert.ok(write.ok && write.value.status === "applied");
          return portOk({ status: "ambiguous", currentHead: null });
        };
        const first = await run(rig);
        assert.equal(first.reason, lost ? "write_ambiguous" : "write_conflict");
        assert.deepEqual(rig.closed, []);
        rig.state.writeRepair = writeRepair;
        await run(rig);
        const requests = (await snapshot(rig)).snapshot.releaseRequests;
        assert.equal(requests.length, 1);
        await run(rig);
        assert.deepEqual(
          (await snapshot(rig)).snapshot.releaseRequests,
          requests,
        );
        assert.deepEqual(rig.closed, []);
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    }
  },
);

Deno.test("gateway VPS maintenance: unrelated foreign and self delivery authorities remain unchanged", async () => {
  const unrelated = { ...FOREIGN_REPO, name: "other-target" };
  const foreign = await makeRig("vps-unrelated", {
    repair: repairSnapshot([{ ...foreignRecord(), repository: unrelated }], [{
      ...foreignReceipt(),
      repository: unrelated,
    }]),
    pull: foreignPullFacts(),
    issueTask: () => Promise.resolve(FOREIGN_TASK),
  });
  try {
    await run(foreign.rig);
    assert.equal(
      (await snapshot(foreign.rig)).snapshot.work[0].nextStep,
      "done",
    );
    assert.deepEqual(foreign.rig.closed, [FOREIGN_TASK.issueNumber]);
  } finally {
    await Deno.remove(foreign.rig.tmp, { recursive: true });
  }
  const review = authorizingReceipt();
  const record = deliveryRecord();
  const request = await buildHostedReleaseRequest(
    record.repository,
    MERGE,
    HEAD,
    BASE,
    record.target.pr!,
    review,
    T0,
  );
  assert.ok(request);
  const self = await makeRig("vps-self", {
    repair: repairSnapshot([record], [review], [request]),
    hostedReceipt: { request, priorRevision: BASE },
    pull: pullFacts(),
  });
  try {
    await run(self.rig);
    assert.equal((await snapshot(self.rig)).snapshot.work[0].nextStep, "done");
  } finally {
    await Deno.remove(self.rig.tmp, { recursive: true });
  }
});

Deno.test("gateway VPS maintenance: concrete authenticated source projection rejects missing and opted-out identities", async () => {
  const originalFetch = globalThis.fetch;
  let body: unknown = {
    number: 120,
    state: "closed",
    body: "original",
    labels: [],
  };
  const calls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(new URL(url).pathname);
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as typeof fetch;
  try {
    const github = createHostedAutonomyGitHub("offline-fixture", FOREIGN_REPO);
    const read = github.readIssueOptedOut!;
    assert.equal(await read(120), false);
    body = {
      number: 120,
      state: "closed",
      body: "original",
      labels: [{ name: "sentinel:skip" }],
    };
    assert.equal(await read(120), true);
    body = {
      number: 120,
      state: "closed",
      body: "<!-- sentinel:skip -->\noriginal",
      labels: [],
    };
    assert.equal(await read(120), true);
    for (
      const invalid of [
        null,
        { number: 121, state: "closed", body: "original", labels: [] },
        { number: 120, state: "closed", body: "original", labels: null },
        {
          number: 120,
          state: "closed",
          body: "original",
          labels: [{ name: 123 }],
        },
        { number: 120, state: "missing", body: "original", labels: [] },
      ]
    ) {
      body = invalid;
      assert.equal(await read(120), null);
    }
    assert.ok(
      calls.every((path) => path === "/repos/ubiquity/ai.ubq.fi/issues/120"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

historicalTest(
  "gateway VPS maintenance: cancelled or failed request blocks without changing charge or publication",
  async (run) => {
    for (const status of ["cancelled", "failed"] as const) {
      const record = foreignRecord();
      const review = foreignReceipt();
      const request = await buildHostedReleaseRequest(
        FOREIGN_REPO,
        MERGE,
        HEAD,
        BASE,
        FOREIGN_PR,
        review,
        T0,
      );
      assert.ok(request);
      const terminal = {
        ...request,
        status,
        failureReason: `trusted ${status}`,
      };
      const { rig, github } = await makeRig(`vps-request-${status}`, {
        repair: repairSnapshot([record], [review], [terminal]),
        pull: foreignPullFacts(),
        issueOpen: false,
        issueTask: (number) =>
          Promise.resolve(repositoryTask(FOREIGN_REPO, number)),
      });
      rig.githubFor = () => ({
        ...github,
        readIssueOptedOut: () => Promise.resolve(false),
      });
      try {
        await run(rig);
        const after = (await snapshot(rig)).snapshot;
        assert.equal(after.work[0].nextStep, "blocked");
        assert.equal(after.work[0].blocker?.message, terminal.failureReason);
        assert.deepEqual(after.work[0].target, record.target);
        assert.deepEqual(after.releaseRequests, [terminal]);
        assert.deepEqual(rig.closed, []);
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    }
  },
);
