/**
 * Base-repair filing through the real maintenance pass (`runHostedAutonomy`),
 * owner decision 2026-11-15: enabled for `ubiquity/ai.ubq.fi` only.
 * ai.ubq.fi, uusd.ubq.fi and permit2-rpc-manager each hold records on a red
 * tip, the live shape of that day. ai.ubq.fi gets exactly one issue, once,
 * whose text is the fixed template over its branch, its tip and the trusted
 * names of the checks red on both; the other two targets are never read. A
 * green tip files nothing, an open base-repair issue holds every new one,
 * and a create that fails or throws is tried at most once per pass without
 * stopping the phases after it.
 */
import { INACTIVE_CI_MINUTES } from "../../src/budget/ci-minutes.ts";
import assert from "node:assert/strict";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type {
  RepairStateWriter,
  StateReadView,
} from "../../src/contracts/ports.ts";
import { RED_BASE_RECHECK_MS } from "../../src/repair/ci-first-policy.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { runHostedAutonomy } from "../../ops/hosted-autonomy-runner.ts";
import type {
  HostedAppIssueV1,
  HostedAutonomyGitHubV1,
} from "../../ops/hosted-autonomy-types.ts";
import { SHA1, T0, workRecord } from "../state/helpers.ts";
import {
  snapshotOf,
  TransitionState,
  withDarkQueueAuthority,
} from "./hosted-autonomy-preservation-fixtures.ts";

const NOW = T0 + 6 * 60 * 60_000;
const AI = "ai.ubq.fi";
const UUSD = "uusd.ubq.fi";
const PERMIT2 = "permit2-rpc-manager";
/** Each target's red `development` tip. */
const TIPS: Readonly<Record<string, string>> = {
  [AI]: "a1".repeat(20),
  [UUSD]: "b2".repeat(20),
  [PERMIT2]: "c3".repeat(20),
};
const OLD_TIP = "d4".repeat(20);
const H1 = "11".repeat(20);
const H2 = "12".repeat(20);
const U1 = "21".repeat(20);
const P1 = "31".repeat(20);
const TAG = "base-repair:ubiquity/ai.ubq.fi";
const MARKER = `<!-- sentinel:base-repair:development@${TIPS[AI]} -->`;

/** The CI-first gate's red-base hold, as a live poll re-arms it. */
const HELD = {
  reason: "backoff",
  since: NOW - 60_000,
  until: NOW - 60_000 + RED_BASE_RECHECK_MS,
};

/** A record of `name` issue `issue` held on its target's red tip. */
function held(name: string, issue: number, head: string): WorkRecordV1 {
  const id = `issue-ubiquity-${name}-${issue}`;
  return workRecord(id, {
    repository: { owner: "ubiquity", name, installationId: 7 },
    source: { kind: "issue", id: String(issue), revision: SHA1 },
    related: { incidentId: null, issueNumber: issue },
    nextStep: "work",
    wait: HELD,
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
    target: {
      base: TIPS[name],
      branch: candidateBranch(id as never),
      checkpoint: null,
      head,
      pr: 5000 + issue,
    },
  });
}

type CreateMode = "ok" | "lost" | "refused" | "throws";

interface FakeTarget {
  readonly surface: HostedAutonomyGitHubV1;
  /** The App-created issues GitHub holds, as the listing answers them. */
  readonly issues: HostedAppIssueV1[];
  readonly created: { title: string; body: string }[];
  /** Every failed-check read and issue listing this target answered. */
  readonly reads: string[];
}

/**
 * One target's fake GitHub: its tip, the failed checks per commit, and the
 * App's issues. A create of mode `ok` or `lost` adds the issue on GitHub;
 * `lost` answers without proof (null), `refused` adds nothing and answers
 * null, `throws` adds nothing and rejects.
 */
function fakeTarget(
  name: string,
  options: {
    failed: Readonly<Record<string, readonly string[]>>;
    create?: CreateMode;
    issues?: readonly HostedAppIssueV1[];
    branch?: string;
  },
): FakeTarget {
  const issues = [...(options.issues ?? [])];
  const created: { title: string; body: string }[] = [];
  const reads: string[] = [];
  let next = 9000;
  const surface = {
    readDefaultBranch: () => Promise.resolve(options.branch ?? "development"),
    readBaseTip: () => Promise.resolve(TIPS[name]),
    hasSuccessfulCheck: () => Promise.resolve(false),
    hasAllChecksGreen: () => Promise.resolve(false),
    readPull: () => Promise.resolve(null),
    readIssueOpen: () => Promise.resolve(true),
    readIssueTask: () => Promise.resolve(null),
    readIssueOptedOut: () => Promise.resolve(false),
    merge: () => Promise.reject(new Error("nothing merges in these passes")),
    closeIssue: () => Promise.resolve(false),
    listParkedRuns: () => Promise.resolve([]),
    approveRun: () => Promise.resolve(false),
    failedChecks: (commit: string) => {
      reads.push(`checks:${commit}`);
      return Promise.resolve([...(options.failed[commit] ?? [])]);
    },
    baseRepairIssues: {
      listAppAuthored: () => {
        reads.push("issues");
        return Promise.resolve(issues.map((issue) => ({ ...issue })));
      },
      create: (input: { title: string; body: string }) => {
        created.push(input);
        const mode = options.create ?? "ok";
        if (mode === "throws") {
          return Promise.reject(new Error("connection reset"));
        }
        if (mode === "refused") return Promise.resolve(null);
        const number = next++;
        issues.push({
          number,
          state: "open",
          pullRequest: false,
          firstLine: input.body.split("\n")[0],
        });
        return Promise.resolve(mode === "lost" ? null : number);
      },
    },
  } as unknown as HostedAutonomyGitHubV1;
  return { surface, issues, created, reads };
}

/** The live shape: every target red on its tip and on its held heads. */
function redTargets(
  ai: Partial<Parameters<typeof fakeTarget>[1]> = {},
): Record<string, FakeTarget> {
  return {
    [AI]: fakeTarget(AI, {
      failed: {
        [TIPS[AI]]: ["validate"],
        [H1]: ["validate"],
        [H2]: ["validate"],
      },
      ...ai,
    }),
    [UUSD]: fakeTarget(UUSD, {
      failed: { [TIPS[UUSD]]: ["build"], [U1]: ["build"] },
    }),
    [PERMIT2]: fakeTarget(PERMIT2, {
      failed: { [TIPS[PERMIT2]]: ["test"], [P1]: ["test"] },
    }),
  };
}

const LIVE =
  () => [held(AI, 1176, H1), held(UUSD, 40, U1), held(PERMIT2, 31, P1)];

/**
 * One whole maintenance pass at `NOW` over `records`, each target routed to
 * its own fake. Returns the pass's base-repair actions and the phase
 * progress lines it logged.
 */
async function maintain(
  records: WorkRecordV1[],
  targets: Readonly<Record<string, FakeTarget>>,
) {
  const state = new TransitionState(snapshotOf(records, []));
  const deps = await withDarkQueueAuthority({
    ciMinutes: INACTIVE_CI_MINUTES,
    state: state as unknown as StateReadView & RepairStateWriter,
    githubFor: (repository) => targets[repository.name]?.surface ?? null,
    clock: { now: () => NOW },
  });
  const progress: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => {
    try {
      const line = JSON.parse(String(args[0]));
      if (line?.kind === "sentinel_maintenance_progress") {
        progress.push(`${line.phase}:${line.event}`);
      }
    } catch {
      // Not a JSON line.
    }
  };
  try {
    const result = await runHostedAutonomy(deps);
    return {
      result,
      baseRepair: result.actions.filter((action) =>
        action.startsWith("base-repair:")
      ),
      progress,
      writes: state.writes,
    };
  } finally {
    console.log = log;
  }
}

Deno.test("base repair maintenance: ai.ubq.fi held on a red tip gets exactly one issue, once; uusd.ubq.fi and permit2-rpc-manager get nothing", async () => {
  const targets = redTargets();
  const ai = targets[AI];
  const first = await maintain(LIVE(), targets);
  assert.deepEqual(first.baseRepair, [`${TAG}:filed=#9000`]);
  assert.equal(first.writes, 0, "filing writes no repair state");
  assert.equal(ai.created.length, 1);
  assert.equal(ai.created[0].title, "CI is failing on development");
  assert.equal(ai.created[0].body.split("\n")[0], MARKER);
  // The next pass, and a pass with a second ai.ubq.fi record held on the
  // same tip, file nothing more.
  const second = await maintain(LIVE(), targets);
  assert.deepEqual(second.baseRepair, [`${TAG}:filed_before=#9000`]);
  const third = await maintain([...LIVE(), held(AI, 1210, H2)], targets);
  assert.deepEqual(third.baseRepair, [`${TAG}:filed_before=#9000`]);
  assert.equal(ai.created.length, 1);
  assert.equal(ai.issues.length, 1);
  // The same state on the two targets outside the decision: never read.
  for (const name of [UUSD, PERMIT2]) {
    assert.deepEqual(targets[name].reads, [], name);
    assert.deepEqual(targets[name].created, [], name);
  }
});

Deno.test("base repair maintenance: a green ai.ubq.fi tip is read and files nothing", async () => {
  const targets = redTargets({
    failed: { [TIPS[AI]]: [], [H1]: ["validate"] },
  });
  const { baseRepair } = await maintain(LIVE(), targets);
  assert.deepEqual(baseRepair, []);
  assert.deepEqual(targets[AI].reads, [`checks:${TIPS[AI]}`], "no head read");
  assert.equal(targets[AI].created.length, 0);
});

Deno.test("base repair maintenance: an open base-repair issue holds every new one, whatever its records", async () => {
  const older = `<!-- sentinel:base-repair:development@${OLD_TIP} -->`;
  const cases: [string, HostedAppIssueV1, WorkRecordV1[]][] = [
    // Its repair is parked (the fix failed) or done (merged, issue left open).
    ["parked", openIssue(77, older), [blockedOn(77)]],
    ["done", openIssue(77, older), [doneOn(77)]],
    // The first, tip-less marker, and another branch, are base repairs too.
    ["legacy", openIssue(77, "<!-- sentinel:base-repair:development -->"), []],
    ["branch", openIssue(77, older.replace("development", "main")), []],
  ];
  for (const [label, issue, records] of cases) {
    const targets = redTargets({
      failed: { [TIPS[AI]]: ["validate"], [H1]: ["validate"] },
      issues: [issue],
    });
    const { baseRepair } = await maintain([...LIVE(), ...records], targets);
    assert.deepEqual(baseRepair, [`${TAG}:open=#77`], label);
    assert.equal(targets[AI].created.length, 0, label);
  }
  // A closed one for an older tip does not hold the new tip's issue.
  const targets = redTargets({
    failed: { [TIPS[AI]]: ["validate"], [H1]: ["validate"] },
    issues: [{ ...openIssue(77, older), state: "closed" }],
  });
  const { baseRepair } = await maintain(LIVE(), targets);
  assert.deepEqual(baseRepair, [`${TAG}:filed=#9000`]);
});

Deno.test("base repair maintenance: a failed or throwing create is tried once per pass and never stops the phases after it", async () => {
  const red = { [TIPS[AI]]: ["validate"], [H1]: ["validate"] };
  // A transport failure: one create, then the next phases still run.
  const thrown = redTargets({ failed: red, create: "throws" });
  const failed = await maintain(LIVE(), thrown);
  assert.deepEqual(failed.baseRepair, [`${TAG}:unexpected_error`]);
  assert.equal(thrown[AI].created.length, 1);
  assert.notEqual(failed.result.status, "failed");
  const after = failed.progress.slice(
    failed.progress.indexOf("base_repair:start"),
  );
  for (
    const step of [
      "base_repair:finish",
      "ci_resume:start",
      "ci_resume:finish",
      "target_capability:start",
      "retired_pulls:start",
    ]
  ) assert.ok(after.includes(step), step);
  // GitHub kept the issue but the answer proved nothing: the next pass sees
  // its marker and files nothing more.
  const lost = redTargets({ failed: red, create: "lost" });
  const unproven = await maintain(LIVE(), lost);
  assert.deepEqual(unproven.baseRepair, [`${TAG}:file_failed`]);
  const next = await maintain(LIVE(), lost);
  assert.deepEqual(next.baseRepair, [`${TAG}:filed_before=#9000`]);
  assert.equal(lost[AI].created.length, 1);
  // GitHub refused it: one more create on the next pass, never two in one.
  const refused = redTargets({ failed: red, create: "refused" });
  for (const count of [1, 2]) {
    const pass = await maintain(LIVE(), refused);
    assert.deepEqual(pass.baseRepair, [`${TAG}:file_failed`]);
    assert.equal(refused[AI].created.length, count);
  }
});

Deno.test("base repair maintenance: the issue text is the fixed template over the branch, the tip and trusted check names", async () => {
  const shared = [
    "validate",
    "lint`<!-- sentinel:skip -->",
    "x\n@codex review",
    "<b>closes #5</b>",
  ];
  const targets = redTargets({
    failed: {
      [TIPS[AI]]: [...shared, "deploy-standby"],
      [H1]: [...shared, "head-only"],
    },
  });
  await maintain(LIVE(), targets);
  assert.equal(targets[AI].created.length, 1);
  const [issue] = targets[AI].created;
  assert.equal(issue.title, "CI is failing on development");
  assert.equal(
    issue.body,
    [
      MARKER,
      "",
      `CI is failing on \`development\` at ${
        TIPS[AI]
      }. Sentinel's open repairs in this repository fail the same checks, so none of them can merge until these checks pass on \`development\` again.`,
      "",
      "Failing checks:",
      "- `check with an unsupported name`",
      "- `validate`",
      "",
      "Fix the code so these checks pass on `development`. Change only what the failure requires.",
      "",
      "Filed automatically by Sentinel from the check results of that exact commit.",
    ].join("\n"),
  );
  // A default branch outside the plain ref shape files nothing at all.
  const odd = redTargets({
    failed: { [TIPS[AI]]: ["validate"], [H1]: ["validate"] },
    branch: "dev`<!--",
  });
  const { baseRepair } = await maintain(LIVE(), odd);
  assert.deepEqual(baseRepair, [`${TAG}:branch_unsupported`]);
  assert.deepEqual(odd[AI].reads, []);
  assert.equal(odd[AI].created.length, 0);
});

function openIssue(number: number, firstLine: string): HostedAppIssueV1 {
  return { number, state: "open", pullRequest: false, firstLine };
}

/** The repair of App issue `issue`, parked. */
function blockedOn(issue: number): WorkRecordV1 {
  return workRecord(`issue-ubiquity-ai.ubq.fi-${issue}`, {
    repository: { owner: "ubiquity", name: AI, installationId: 7 },
    source: { kind: "issue", id: String(issue), revision: SHA1 },
    related: { incidentId: null, issueNumber: issue },
    nextStep: "blocked",
    blocker: { kind: "other", message: "CI fix parked", since: T0 },
  });
}

/** The repair of App issue `issue`, delivered. */
function doneOn(issue: number): WorkRecordV1 {
  return workRecord(`issue-ubiquity-ai.ubq.fi-${issue}`, {
    repository: { owner: "ubiquity", name: AI, installationId: 7 },
    source: { kind: "issue", id: String(issue), revision: SHA1 },
    related: { incidentId: null, issueNumber: issue },
    nextStep: "done",
  });
}
