import { SHA1 as ATTEMPT_RUNTIME } from "../state/helpers.ts";
import assert from "node:assert/strict";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy-github.ts";
import { readHostedPullStatus } from "../../ops/hosted-autonomy-scopes.ts";
import {
  applyHostedRetirements,
  HOSTED_AUTONOMY_RETIRED,
  planHostedRetirements,
  planHostedRetries,
} from "../../ops/hosted-autonomy.ts";
import { reservation, SHA1, T0 } from "../state/helpers.ts";
import {
  authorizingReceipt,
  BASE,
  blockedRecord,
  blockedZombie,
  deliveryRecord,
  HEAD,
  pullFacts,
  SELF_REPO,
  selfClosed,
  TARGET,
  ZOMBIE,
  zombieCharges,
  zombieIntent,
  zombieRecord,
} from "./hosted-autonomy-fixtures.ts";
import { makeRig, repairSnapshot, run } from "./hosted-autonomy-rig.ts";

Deno.test("hosted autonomy: retirement status preserves real state and accounting outcomes", async (t) => {
  const cases = [
    {
      name: "closed unmerged",
      body: { number: 63, state: "closed", merged: false },
      retires: true,
    },
    { name: "open", body: { number: 63, state: "open", merged: false } },
    { name: "merged", body: { number: 63, state: "closed", merged: true } },
    {
      name: "wrong number",
      body: { number: 64, state: "closed", merged: false },
    },
    { name: "missing merged", body: { number: 63, state: "closed" } },
    {
      name: "malformed",
      body: { number: 63, state: "unknown", merged: false },
    },
    { name: "unavailable", body: null },
  ];
  for (const entry of cases) {
    await t.step(entry.name, async () => {
      const originalRecord = zombieRecord({ intent: zombieIntent() });
      const charges = zombieCharges();
      const { rig, github } = await makeRig("retirement-status", {
        repair: repairSnapshot([originalRecord], [], [], charges),
        issueOpen: false,
      });
      const original = globalThis.fetch;
      const requests: string[] = [];
      const status = createHostedAutonomyGitHub("fixture-token", SELF_REPO);
      assert.ok(status.readPullStatus);
      github.readPullStatus = status.readPullStatus;
      github.readPull = () => {
        throw new Error("retirement must not request delivery ancestry");
      };
      globalThis.fetch = ((input: string | URL | Request) => {
        requests.push(String(input));
        return Promise.resolve(
          new Response(JSON.stringify(entry.body), {
            status: entry.body === null ? 503 : 200,
          }),
        );
      }) as typeof fetch;
      try {
        const result = await run(rig, github);
        const after = await rig.state.readRepair();
        if (!after.ok || after.value.status !== "found") {
          throw new Error("unreadable repair state");
        }
        assert.equal(rig.writes, entry.retires ? 1 : 0);
        assert.equal(rig.merges, 0);
        assert.deepEqual(rig.closed, []);
        assert.deepEqual(after.value.snapshot.reservations, charges);
        assert.deepEqual(
          after.value.snapshot.work[0].counters,
          originalRecord.counters,
        );
        if (entry.retires) {
          assert.equal(result.reason, "retired_records");
          assert.equal(
            after.value.snapshot.work[0].blocker?.message,
            HOSTED_AUTONOMY_RETIRED,
          );
          assert.equal(after.value.snapshot.work[0].intent, null);
        } else {
          assert.deepEqual(after.value.snapshot.work[0], originalRecord);
        }
        assert.deepEqual(requests, [
          "https://api.github.com/repos/ubiquity-sentinel/sentinel/pulls/63",
        ]);
      } finally {
        globalThis.fetch = original;
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
});

Deno.test("hosted autonomy: legacy status projection retains the observed pull identity", async () => {
  const { rig, github } = await makeRig("retirement-status-legacy", {
    pull: pullFacts({ number: 63, state: "closed", merged: false }),
  });
  const scope = {
    repository: SELF_REPO,
    key: "self",
    surface: github,
    baseBranch: "development",
  };
  try {
    assert.equal(github.readPullStatus, undefined, "exercise the legacy port");
    assert.deepEqual(await readHostedPullStatus(scope, 63), {
      number: 63,
      state: "closed",
      merged: false,
    });
    assert.equal(await readHostedPullStatus(scope, 64), null);
    github.readPull = () => Promise.resolve(null);
    assert.equal(await readHostedPullStatus(scope, 63), null);
    let fullReads = 0;
    github.readPull = () => {
      fullReads++;
      return Promise.resolve(pullFacts({ number: 63 }));
    };
    github.readPullStatus = () => Promise.resolve(null);
    assert.equal(await readHostedPullStatus(scope, 63), null);
    assert.equal(
      fullReads,
      0,
      "a refused status never falls back to another read",
    );
    github.readPullStatus = () => Promise.reject(new Error("unavailable"));
    assert.equal(await readHostedPullStatus(scope, 63), null);
    assert.equal(
      fullReads,
      0,
      "a failed status never falls back to another read",
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test(
  "hosted autonomy: a working record whose source issue closed is parked, never retried",
  () => {
    const record = deliveryRecord({
      nextStep: "work",
      target: {
        base: BASE,
        branch: "sentinel/repair/issue-ubiquity-sentinel-48",
        checkpoint: null,
        head: null,
        pr: null,
      },
    });
    const snapshot = repairSnapshot([record], [authorizingReceipt()]);
    assert.deepEqual(
      planHostedRetirements(snapshot, selfClosed(48)),
      [{ id: TARGET, issueNumber: 48, repository: SELF_REPO }],
    );
    // A record with an open pull request still has a delivery path.
    assert.deepEqual(planHostedRetirements(snapshot, new Set()), []);
    const next = applyHostedRetirements(
      snapshot,
      SHA1,
      [{ id: TARGET, issueNumber: 48 }],
      T0 + 5000,
    );
    const parked = next.work[0];
    assert.equal(parked.nextStep, "blocked");
    assert.equal(parked.blocker?.message, HOSTED_AUTONOMY_RETIRED);
    // The retirement reason matches no retryable prefix.
    assert.equal(
      planHostedRetries(next, T0 + 900000, ATTEMPT_RUNTIME).length,
      0,
    );
  },
);

Deno.test(
  "hosted autonomy: only a definitively closed-unmerged pull parks a record that has one",
  () => {
    const snapshot = repairSnapshot([zombieRecord()]);
    // The pull's own state is the new evidence: a closed issue alone is not.
    assert.deepEqual(planHostedRetirements(snapshot, selfClosed(61)), []);
    assert.deepEqual(
      planHostedRetirements(snapshot, selfClosed(61), new Set([ZOMBIE])),
      [{ id: ZOMBIE, issueNumber: 61, repository: SELF_REPO }],
    );
    // A record that produced nothing keeps the existing skip while it is
    // already parked, whatever the closed-unmerged set says.
    const parked = repairSnapshot([
      zombieRecord({
        nextStep: "blocked",
        blocker: {
          kind: "other",
          message: "model run ended without a trusted receipt",
          since: T0 + 3000,
        },
        target: {
          base: BASE,
          branch: "sentinel/repair/issue-ubiquity-sentinel-61",
          checkpoint: null,
          head: null,
          pr: null,
        },
      }),
    ]);
    assert.deepEqual(
      planHostedRetirements(
        parked,
        selfClosed(61),
        new Set([ZOMBIE]),
      ),
      [],
    );
  },
);

Deno.test(
  "hosted autonomy: a closed-unmerged pull parks an already blocked record",
  () => {
    // The record carries a settled implementation intent: retirement may
    // clear it because the runtime already resolved that charge.
    const snapshot = repairSnapshot(
      [blockedZombie()],
      [authorizingReceipt()],
      [],
      zombieCharges(),
    );
    assert.deepEqual(
      planHostedRetirements(snapshot, selfClosed(61), new Set([ZOMBIE])),
      [{ id: ZOMBIE, issueNumber: 61, repository: SELF_REPO }],
    );
  },
);

Deno.test(
  "hosted autonomy: an unsettled implementation intent is never retired",
  () => {
    // The companion baseline: the same closed-unmerged record with a SETTLED
    // implementation reservation is retired (retirement clears that intent).
    const settled = repairSnapshot(
      [zombieRecord({ intent: zombieIntent() })],
      [authorizingReceipt()],
      [],
      zombieCharges(),
    );
    assert.deepEqual(
      planHostedRetirements(settled, selfClosed(61), new Set([ZOMBIE])),
      [{ id: ZOMBIE, issueNumber: 61, repository: SELF_REPO }],
    );

    // A matching reservation that is still `reserved` is not settled.
    const reserved = repairSnapshot(
      [zombieRecord({ intent: zombieIntent() })],
      [authorizingReceipt()],
      [],
      [
        reservation("z-2", {
          taskId: ZOMBIE,
          head: BASE,
          attempt: 2,
          purpose: "implementation",
          outcome: "reserved",
        }),
      ],
    );
    assert.deepEqual(
      planHostedRetirements(reserved, selfClosed(61), new Set([ZOMBIE])),
      [],
    );

    // No matching reservation at all is not settled either.
    const missing = repairSnapshot([zombieRecord({ intent: zombieIntent() })]);
    assert.deepEqual(
      planHostedRetirements(missing, selfClosed(61), new Set([ZOMBIE])),
      [],
    );

    // A non-implementation intent stays retirable: the runtime clears an
    // unprepared base_refresh itself.
    const refreshing = repairSnapshot([
      zombieRecord({
        intent: {
          kind: "base_refresh",
          key: "base-refresh:z-2",
          startedAt: T0 + 1000,
          branch: "sentinel/repair/issue-ubiquity-sentinel-61",
          expectedHead: HEAD,
          observedBase: SHA1,
          pr: 63,
          requestId: null,
          resultId: null,
        },
      }),
    ]);
    assert.deepEqual(
      planHostedRetirements(refreshing, selfClosed(61), new Set([ZOMBIE])),
      [{ id: ZOMBIE, issueNumber: 61, repository: SELF_REPO }],
    );
  },
);

Deno.test(
  "hosted autonomy: a parked deterministic check on the reviewed head is approved",
  async () => {
    const { rig, github } = await makeRig("autonomy-approve", {
      repair: repairSnapshot([deliveryRecord()], [authorizingReceipt()]),
      pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
      checkGreen: false,
    });
    const calls: number[] = [];
    github.listParkedRuns = (head: string) => {
      assert.equal(head, HEAD);
      return Promise.resolve([4242]);
    };
    github.approveRun = (id: number) => {
      calls.push(id);
      return Promise.resolve(true);
    };
    const result = await run(rig, github);
    assert.deepEqual(calls, [4242]);
    assert.ok(result.actions.includes(`approve:${TARGET}:run=4242:approved`));
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: an unsettled implementation intent is never cleared",
  () => {
    const unsettled = repairSnapshot(
      [
        blockedRecord({
          intent: {
            kind: "implementation",
            key: "implementation:r-9",
            startedAt: T0 + 1000,
            branch: "sentinel/repair/issue-ubiquity-sentinel-48",
            expectedHead: null,
            observedBase: BASE,
            pr: null,
            requestId: "r-9",
            resultId: null,
          },
          counters: { attempts: 1, retries: 0, reviewRounds: 1 },
        }),
      ],
      [authorizingReceipt()],
      [],
      [
        reservation("r-9", {
          taskId: TARGET,
          head: BASE,
          attempt: 1,
          purpose: "implementation",
          outcome: "reserved",
        }),
      ],
    );
    assert.equal(
      planHostedRetries(unsettled, T0 + 5000, ATTEMPT_RUNTIME).length,
      0,
    );

    const settled = repairSnapshot(
      [
        blockedRecord({
          intent: {
            kind: "implementation",
            key: "implementation:r-9",
            startedAt: T0 + 1000,
            branch: "sentinel/repair/issue-ubiquity-sentinel-48",
            expectedHead: null,
            observedBase: BASE,
            pr: null,
            requestId: "r-9",
            resultId: null,
          },
          counters: { attempts: 1, retries: 0, reviewRounds: 1 },
        }),
      ],
      [authorizingReceipt()],
      [],
      [
        reservation("r-9", {
          taskId: TARGET,
          head: BASE,
          attempt: 1,
          purpose: "implementation",
          outcome: "submitted",
          settledAt: T0 + 2000,
        }),
      ],
    );
    assert.equal(
      planHostedRetries(
        settled,
        T0 + 5000,
        ATTEMPT_RUNTIME,
      ).length,
      1,
    );
  },
);
