import { INACTIVE_CI_MINUTES } from "../../src/budget/ci-minutes.ts";
/** #335: the step loop records the concrete cause of its unavailable waits. */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import type { GitHubIssueV1, PortResultV1 } from "../../src/contracts/ports.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { prepareImplementationStart } from "../../src/repair/loop-implementation.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
} from "../../src/repair/loop-types.ts";
import { SHA1, T0, workRecord } from "../state/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "./helpers.ts";
import { seededSnapshot } from "./loop-rig.ts";

/** A GitHub port whose issue read answers HTTP 503 (no body or URL kept). */
class Unavailable503Github extends FakeGithub {
  override readIssue(
    issueNumber: number,
  ): Promise<PortResultV1<GitHubIssueV1 | null>> {
    this.calls.push(`readIssue:${issueNumber}`);
    return Promise.resolve({
      ok: false,
      error: {
        kind: "unavailable",
        detail: "issue read failed",
        issueSource: {
          target: "ubiquity/ai.ubq.fi",
          method: "GET",
          endpointPath: "/repos/ubiquity/ai.ubq.fi/issues/1",
          httpStatus: 503,
          page: 1,
          stage: "http",
          code: "http_error",
        },
      },
    });
  }
}

async function issueRead503(recordWaitCauses: boolean) {
  const record = workRecord("issue-503");
  const state = new MemoryState();
  state.repair = seededSnapshot([record]);
  state.repairHead = SHA1;
  const clock = new FakeClock(T0);
  const configs = repairConfigs({
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
  });
  const model = new FakeModel();
  const deps: RepairCycleDepsV1 = {
    ciMinutes: INACTIVE_CI_MINUTES,
    clock,
    state,
    configs,
    controllerSha: SHA1,
    github: new Unavailable503Github(),
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
    incidents: new FakeIncidents({ summaries: [] }),
    replay: new FakeReplay(),
    model,
    budget: new RollingStartBudget({ clock, state, configs }),
    recordWaitCauses,
  };
  const context: LoopContextV1 = {
    snapshot: state.repair,
    head: state.repairHead,
    executionBaseline: record,
    bounds: {
      runDeadline: clock.now() + 60 * 60_000,
      modelCutoff: clock.now() + 60 * 60_000,
    },
  };
  const result = await prepareImplementationStart(
    deps,
    context,
    record,
    configs[0]!,
  );
  assert.equal(result.kind, "progress", JSON.stringify(result));
  const after = await state.readRepair();
  assert.ok(after.ok && after.value.status === "found");
  if (!after.ok || after.value.status !== "found") throw new Error("absent");
  const stored = after.value.snapshot.work.find((row) => row.id === record.id);
  assert.equal(after.value.snapshot.reservations.length, 0, "nothing charged");
  assert.equal(model.requests.length, 0, "no model start");
  return stored;
}

Deno.test("an HTTP 503 issue read records a 5xx github cause on its unavailable wait", async () => {
  const stored = await issueRead503(true);
  assert.equal(stored?.wait?.reason, "unavailable");
  assert.deepEqual(stored?.wait?.cause, {
    port: "github",
    status: "5xx",
    code: "unavailable",
  });
  // Only the closed cause is stored: never the endpoint path or detail text.
  const text = JSON.stringify(stored);
  assert(!text.includes("/repos/"));
  assert(!text.includes("issue read failed"));
});

Deno.test("without the host's enablement the same wait keeps its prior shape", async () => {
  // A rollback target whose parser predates `cause` must read this state.
  const stored = await issueRead503(false);
  assert.equal(stored?.wait?.reason, "unavailable");
  assert.equal(Object.hasOwn(stored!.wait!, "cause"), false);
});

Deno.test("the work record parser tolerates waits with and without a cause", () => {
  const base = workRecord("issue-wait");
  const legacy = parseWorkRecordV1({
    ...base,
    wait: { reason: "backoff", since: T0, until: null },
  });
  assert.equal(Object.hasOwn(legacy.wait!, "cause"), false);
  const caused = parseWorkRecordV1({
    ...base,
    wait: {
      reason: "unavailable",
      since: T0,
      until: T0 + 1,
      cause: { port: "queue", status: "unknown", code: "obs_unavail" },
    },
  });
  assert.deepEqual(caused.wait?.cause, {
    port: "queue",
    status: "unknown",
    code: "obs_unavail",
  });
  for (
    const cause of [
      { port: "queue", status: "unknown", code: "x".repeat(17) },
      { port: "queue", status: "unknown", code: "https://x.example/" },
      { port: "web", status: "5xx", code: "unavailable" },
      { port: "github", status: "503", code: "unavailable" },
      { port: "github", status: "5xx", code: "unavailable", body: "x" },
    ]
  ) {
    assert.throws(() =>
      parseWorkRecordV1({
        ...base,
        wait: { reason: "unavailable", since: T0, until: null, cause },
      })
    );
  }
});
