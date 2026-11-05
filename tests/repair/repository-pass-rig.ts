/**
 * Shared rig of the fan-out repository pass tests (issue #328): the ACTUAL
 * step loop over in-memory state, a fake multi-repository GitHub port with
 * the batched live read, and an injected clock. No network, no model call.
 */
import { RollingStartBudget } from "../../src/budget/mod.ts";
import type {
  LiveInputsRequestV1,
  LiveInputsV1,
} from "../../src/contracts/live-inputs.ts";
import { portOk, type PortResultV1 } from "../../src/contracts/ports.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import {
  planRepairFanoutV1,
  repairFanoutBindingV1,
  type RepairFanoutPlanV1,
} from "../../src/repair/repair-fanout-plan.ts";
import { repositoryConfig } from "../budget/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
} from "./helpers.ts";
import { SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";

export const MINUTE = 60_000;
export const REPOS = ["alpha", "beta", "gamma"].map((name) => ({
  owner: "ubiquity",
  name,
  installationId: 7,
}));
export type Repo = (typeof REPOS)[number];

/** A live record whose only step is the pending matrix-artifact deferral. */
export function pendingArtifact(
  repo: Repo,
  index: number,
  extra: Record<string, unknown> = {},
): WorkRecordV1 {
  const id = `issue-${repo.name}-${index}`;
  const branch = `sentinel/repair/${id}`;
  const number = 100 + index;
  return workRecord(id, {
    repository: repo,
    source: { kind: "issue", id: String(number), revision: SHA1 },
    related: { incidentId: null, issueNumber: number },
    target: { base: SHA1, branch, checkpoint: null, head: null, pr: null },
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
    intent: {
      kind: "implementation",
      key: `impl:${index.toString(16).padStart(64, "0")}`,
      startedAt: T0,
      branch,
      expectedHead: null,
      observedBase: SHA1,
      pr: null,
      requestId: index.toString(16).padStart(64, "0"),
      resultId: null,
    },
    ...extra,
  });
}

/** Fake port answering the batched read for every repository asked. */
export class BatchGithub extends FakeGithub {
  readonly closed = new Set<string>();

  readLiveInputs(
    request: LiveInputsRequestV1,
  ): Promise<PortResultV1<LiveInputsV1>> {
    return Promise.resolve(portOk({
      issues: request.issues.map((number) => ({
        number,
        state: this.closed.has(`${request.repository.name}#${number}`)
          ? "closed" as const
          : "open" as const,
      })),
      pulls: request.pulls.map((number) => ({ number, pull: null })),
      branches: request.branches.map((branch) => ({ branch, tip: SHA1 })),
    }));
  }

  /** Every call that would write to GitHub. */
  effects(): string[] {
    return this.calls.filter((call) =>
      /^(push|createPr|requestReview|merge|assignIssue|closeIssue)/.test(call)
    );
  }
}

export function seeded(work: WorkRecordV1[]): RepairStateSnapshotV1 {
  return {
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
  };
}

export function makeRig(
  work: WorkRecordV1[],
  options: ConstructorParameters<typeof FakeGithub>[0] = {},
) {
  const clock = new FakeClock(T0);
  const state = new MemoryState();
  state.repair = seeded(work);
  state.repairHead = SHA1;
  const configs: RepositoryConfigV1[] = REPOS.map((repo) =>
    repositoryConfig(
      repo as unknown as Parameters<typeof repositoryConfig>[0],
      { perHour: 5, perSevenDays: 20 },
      { sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 } },
    )
  );
  const github = new BatchGithub({ baseSha: SHA1, openIssues: [], ...options });
  const deps = {
    clock,
    state,
    configs,
    controllerSha: SHA1,
    github,
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
    incidents: new FakeIncidents({ summaries: [], evidence: null }),
    replay: new FakeReplay(),
    model: new FakeModel({ head: SHA2, changedPaths: ["src/app.ts"] }),
    budget: new RollingStartBudget({ clock, state, configs }),
    externalImplementations: true,
  };
  return { clock, state, github, deps, configs };
}

export type Rig = ReturnType<typeof makeRig>;

/** The fan-out plan of the rig's current head (run 41, attempt 1). */
export async function plan(rig: Rig): Promise<{
  plan: RepairFanoutPlanV1;
  binding: Awaited<ReturnType<typeof repairFanoutBindingV1>>;
}> {
  const fanout = planRepairFanoutV1({
    snapshot: rig.state.repair!,
    head: rig.state.repairHead!,
    configs: rig.configs,
    runId: 41,
    runAttempt: 1,
  });
  return { plan: fanout, binding: await repairFanoutBindingV1(fanout) };
}

/** Run `body` with console.log captured; returns the parsed JSON lines. */
export async function captured<T>(
  body: () => Promise<T>,
): Promise<{ value: T; lines: Record<string, unknown>[] }> {
  const raw: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    raw.push(args.map((arg) => String(arg)).join(" "));
  };
  let value: T;
  try {
    value = await body();
  } finally {
    console.log = original;
  }
  const lines = raw.flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
  return { value, lines };
}
