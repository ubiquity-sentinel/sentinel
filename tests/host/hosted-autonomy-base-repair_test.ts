/**
 * The launcher's base-repair pass (2026-10-24 throughput redesign, stage 1):
 * a foreign target whose base tip has a completed failing check gets exactly
 * one open, P0, marked base-repair issue naming the failing checks; an open
 * marked issue, a green, pending or unreadable tip, and a target with no
 * record held in a timed backoff at `work` file nothing. The pass writes no
 * state.
 */
import assert from "node:assert/strict";
import { baseRepairMarker } from "../../src/repair/base-repair.ts";
import {
  baseRepairIssue,
  runHostedBaseRepairPass,
} from "../../ops/hosted-autonomy-base-repair.ts";
import type { HostedAutonomyGitHubV1 } from "../../ops/hosted-autonomy-types.ts";
import {
  liveRecord,
  liveRig,
  liveSnapshot,
  liveSurface,
  NOW,
  TIP,
} from "./hosted-autonomy-spent-fixtures.ts";

interface Filed {
  title: string;
  body: string;
  labels?: string[];
}

/** The CI-first gate's red-base hold, as a live poll re-arms it. */
const HELD = { reason: "backoff", since: NOW - 60_000, until: NOW + 1_740_000 };

async function pass(options: {
  failed: string[] | null;
  openBodies?: string[] | null;
  nextStep?: string;
  wait?: unknown;
}) {
  // The live record is parked; a held one is the same row at `work`.
  const record = options.nextStep === "blocked"
    ? liveRecord(618)
    : liveRecord(618, {
      nextStep: "work",
      blocker: null,
      wait: options.wait === undefined ? HELD : options.wait,
    });
  assert.equal(record.nextStep, options.nextStep ?? "work");
  const { surface: base } = liveSurface({ tip: TIP });
  const filed: Filed[] = [];
  const surface: HostedAutonomyGitHubV1 = {
    ...base,
    failedChecks: () => Promise.resolve(options.failed),
    selfObservation: {
      listRuns: () => Promise.resolve([]),
      listJobs: () => Promise.resolve([]),
      readJobLog: () => Promise.resolve(null),
      listOpenIssueBodies: () =>
        Promise.resolve(
          options.openBodies === undefined ? [] : options.openBodies,
        ),
      fileIssue: (input) => {
        filed.push(input);
        return Promise.resolve(4242);
      },
    },
  };
  const rig = await liveRig("base-repair", liveSnapshot([record], []), surface);
  try {
    const actions = await runHostedBaseRepairPass(
      {
        state: rig.state,
        githubFor: rig.githubFor,
        clock: { now: () => NOW },
      },
      undefined,
      { filing: true },
    );
    return { actions, filed, writes: rig.writes };
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
}

Deno.test("base repair pass: a red tip files one P0 issue with the marker and the failing checks", async () => {
  const { actions, filed, writes } = await pass({
    failed: ["validate", "docs"],
  });
  assert.deepEqual(actions, ["base-repair:ubiquity/ai.ubq.fi:filed=#4242"]);
  assert.equal(filed.length, 1);
  assert.deepEqual(filed[0].labels, ["P0"]);
  assert.equal(filed[0].title, "CI is failing on development");
  assert.equal(filed[0].body.split("\n")[0], baseRepairMarker("development"));
  assert.ok(filed[0].body.includes(TIP));
  assert.ok(filed[0].body.includes("- `docs`\n- `validate`"));
  assert.equal(writes, 0, "the pass writes no state");
});

Deno.test("base repair pass: an open marked issue, a green or unreadable tip and no live work file nothing", async () => {
  const marked = baseRepairIssue("development", TIP, ["validate"]).body;
  const cases: [Parameters<typeof pass>[0], string[]][] = [
    [{ failed: ["validate"], openBodies: [marked] }, [
      "base-repair:ubiquity/ai.ubq.fi:open",
    ]],
    [{ failed: [] }, []],
    [{ failed: null }, ["base-repair:ubiquity/ai.ubq.fi:checks_unreadable"]],
    [{ failed: ["validate"], openBodies: null }, [
      "base-repair:ubiquity/ai.ubq.fi:issues_unreadable",
    ]],
    [{ failed: ["validate"], nextStep: "blocked" }, []],
    // Live work that no red-base hold waits on pays for no tip read.
    [{ failed: ["validate"], wait: null }, []],
  ];
  for (const [options, expected] of cases) {
    const { actions, filed } = await pass(options);
    assert.deepEqual(actions, expected, JSON.stringify(options));
    assert.equal(filed.length, 0, JSON.stringify(options));
  }
});

Deno.test("base repair pass: a marker elsewhere than the first line is not this branch's issue", async () => {
  const { actions, filed } = await pass({
    failed: ["validate"],
    openBodies: [`quoted:\n${baseRepairMarker("development")}`],
  });
  assert.deepEqual(actions, ["base-repair:ubiquity/ai.ubq.fi:filed=#4242"]);
  assert.equal(filed.length, 1);
});

Deno.test("base repair pass: filing ships off and then reads nothing", async () => {
  const record = liveRecord(618, {
    nextStep: "work",
    blocker: null,
    wait: HELD,
  });
  let reads = 0;
  const rig = await liveRig("base-repair-off", liveSnapshot([record], []), {
    ...liveSurface({ tip: TIP }).surface,
    failedChecks: () => {
      reads++;
      return Promise.resolve(["validate"]);
    },
  });
  try {
    const actions = await runHostedBaseRepairPass({
      state: rig.state,
      githubFor: rig.githubFor,
      clock: { now: () => NOW },
    });
    assert.deepEqual(actions, []);
    assert.equal(reads, 0);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("base repair pass: check names are printable and bounded in the issue", () => {
  const { body } = baseRepairIssue("main", TIP, [
    "a`b\u0007c",
    "x".repeat(300),
  ]);
  assert.ok(body.includes("- `a'b?c`"));
  assert.ok(!body.includes("x".repeat(121)));
});
