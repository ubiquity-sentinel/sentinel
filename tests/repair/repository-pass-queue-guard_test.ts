/**
 * The native queue guard inside a fan-out repository pass (issue #328).
 *
 * A repository cell steps its delegated records against a private in-memory
 * fork of the repair state while the serial trusted writer keeps committing
 * other records to the shared store. The guard's decision reads must observe
 * the state the pass itself writes: an in-pass write (a durable refresh
 * intent) or a concurrent trusted commit is not queue identity drift, and
 * with an authenticated no-rule observation it must never become the
 * re-armed `inactive_unavail` wait. Custody and an effective merge-queue rule
 * still hold. No network, model call or real waiting.
 */
import assert from "node:assert/strict";
import { INACTIVE_CI_MINUTES } from "../../src/budget/ci-minutes.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { GitHubQueueDeliveryClient } from "../../src/github/client-queue-delivery.ts";
import { createNativeQueueGuard } from "../../src/github/native-queue-guard.ts";
import { createQueueDeliveryReader } from "../../src/github/queue-delivery-reader.ts";
import { QUEUE_PROOF_POLICY } from "../../src/github/queue-runtime-policy.ts";
import type { GitHubBranchRuleWireV1 } from "../../src/github/wire.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { ensureBaseRefreshIntent } from "../../src/repair/loop-base-refresh.ts";
import { CHECK_POLL_MS } from "../../src/repair/loop-bounds.ts";
import { guardQueueOperation } from "../../src/repair/loop-queue-guard.ts";
import { RepairForkState } from "../../src/repair/repair-fork-state.ts";
import {
  fencedRepositoryDeps,
  RepositoryPassFence,
} from "../../src/repair/repository-pass-fence.ts";
import { FakeAuthProvider, FakeCooldownGate } from "../github/helpers.ts";
import { reservation, SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "./helpers.ts";
import {
  exactOpenPr,
  preservedIssueWork,
  PRODUCING_RESERVATION,
} from "./loop-candidate-fixtures.ts";
import { seededSnapshot } from "./loop-rig.ts";

const MERGE_QUEUE_RULE = { type: "merge_queue" } as GitHubBranchRuleWireV1;

/**
 * One ai.ubq.fi pull request record in the shared store, the production
 * guard composed over that shared store (mode off, proof inactive) and one
 * repository pass forked from it, exactly as a repair cell composes them.
 */
function rig(options: {
  rules?: GitHubBranchRuleWireV1[];
  record?: WorkRecordV1;
} = {}) {
  const record = options.record ?? preservedIssueWork("issue-1", SHA2);
  const shared = new MemoryState();
  shared.repair = seededSnapshot([record], {
    reservations: [reservation(PRODUCING_RESERVATION, {
      taskId: record.id,
      outcome: "submitted",
      settledAt: T0 + 1_000,
    })],
  });
  shared.repairHead = SHA1;
  const clock = new FakeClock(T0 + 5_000);
  const client = new GitHubQueueDeliveryClient({
    repository: record.repository,
    clock,
    apiBaseUrl: "https://api.github.com",
    auth: new FakeAuthProvider(),
    cooldownGate: new FakeCooldownGate(),
    http: () => Promise.reject(new Error("No network is authorized")),
  }, null);
  const reads = { rules: 0 };
  // The authenticated rule read is COMPLETE: the launcher's own observation
  // of the target is `queue:inactive_no_rule`, not an unreadable ruleset.
  client.readBranchRules = () => {
    reads.rules++;
    return Promise.resolve(portOk(options.rules ?? []));
  };
  const guard = createNativeQueueGuard({
    repository: record.repository,
    state: shared,
    clock,
    client,
    reader: createQueueDeliveryReader({
      repository: record.repository,
      clock,
      client,
      policy: QUEUE_PROOF_POLICY,
    }),
    policy: QUEUE_PROOF_POLICY,
    mode: "off",
    proofActivated: false,
  });
  const github = new FakeGithub({
    nativeQueue: guard,
    // The configured base moved: the ordinary step plans a refresh.
    baseSha: SHA3,
    candidateLifecycle: {
      refs: { [`refs/heads/${record.target.branch}`]: SHA2 },
      pullRequests: [exactOpenPr(7, SHA2, record.target.branch!)],
    },
  });
  const configs = repairConfigs({
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 400_000 },
  });
  const deps = {
    ciMinutes: INACTIVE_CI_MINUTES,
    state: shared,
    clock,
    github,
    configs,
    model: new FakeModel(),
    controllerSha: SHA1,
    budget: new RollingStartBudget({ state: shared, clock, configs }),
    githubCooldown: new DurableGitHubCooldownGate({ state: shared, clock }),
    incidents: new FakeIncidents({ summaries: [] }),
    replay: new FakeReplay(),
    // Hosted cells persist wait causes (#335).
    recordWaitCauses: true,
  };
  const fork = new RepairForkState(
    { snapshot: shared.repair, head: SHA1 },
    shared,
  );
  const fence = new RepositoryPassFence();
  const pass = fencedRepositoryDeps(deps, fork, configs, fence);
  const context = {
    snapshot: fork.current(),
    head: fork.head,
    executionBaseline: record,
    bounds: {
      runDeadline: clock.now() + 3_600_000,
      modelCutoff: clock.now() + 3_600_000,
    },
  };
  /** Every shared read observes a newer head (other records committed). */
  const commitConcurrently = () => {
    const read = shared.readRepair.bind(shared);
    shared.readRepair = () => {
      shared.repairHead = shared.repairHead === SHA1 ? SHA3 : SHA1;
      return read();
    };
  };
  const forkRow = () => {
    const row = fork.current().work.find((entry) => entry.id === record.id);
    assert.ok(row !== undefined);
    return row;
  };
  return {
    record,
    shared,
    clock,
    reads,
    guard,
    fork,
    fence,
    pass,
    context,
    commitConcurrently,
    forkRow,
  };
}

Deno.test("repository pass: a refresh intent written to the fork is not queue identity drift", async () => {
  const r = rig();
  const sharedBefore = structuredClone(r.shared.repair);
  // The ordinary step persists the durable refresh intent to the pass's
  // private fork only; the cell can never write the shared store.
  assert.deepEqual(
    await ensureBaseRefreshIntent(r.pass, r.context, r.record),
    { kind: "progress" },
  );
  const intended = r.forkRow();
  assert.equal(intended.intent?.kind, "base_refresh");
  assert.equal(intended.intent?.observedBase, SHA3);
  // The next step executes that intent. Every later run re-judges it with
  // the same complete no-rule observation: it is never parked.
  for (let run = 0; run < 3; run++) {
    assert.equal(
      await guardQueueOperation(r.pass, r.context, intended, "refresh"),
      null,
    );
    assert.deepEqual(r.forkRow(), intended);
    r.clock.advance(CHECK_POLL_MS + 1);
  }
  assert.equal(r.reads.rules, 4);
  assert.equal(r.fence.total, 0);
  assert.equal(r.shared.repairWrites, 0);
  assert.deepEqual(r.shared.repair, sharedBefore);
});

Deno.test("repository pass: trusted commits to the shared store mid-decision do not hold the pass", async () => {
  const r = rig();
  r.commitConcurrently();
  for (let run = 0; run < 3; run++) {
    assert.equal(
      await guardQueueOperation(r.pass, r.context, r.record, "resume"),
      null,
    );
    assert.deepEqual(r.forkRow(), r.record);
    r.clock.advance(CHECK_POLL_MS + 1);
  }
  assert.equal(r.reads.rules, 3);
  // The serial trusted composition keeps failing closed when the
  // authoritative head moves during its own observation.
  assert.deepEqual(
    await r.guard.inspect({
      record: r.record,
      operation: "resume",
      deadline: r.clock.now() + 60_000,
    }),
    { status: "hold", reason: "inactive_observation_unavailable", pull: null },
  );
  assert.equal(r.shared.repairWrites, 0);
});

Deno.test("repository pass: an effective merge-queue rule still refuses the fork's merge", async () => {
  const r = rig({ rules: [MERGE_QUEUE_RULE] });
  const held = await guardQueueOperation(r.pass, r.context, r.record, "merge");
  assert.equal(held?.kind, "progress");
  assert.deepEqual(r.forkRow().wait, {
    reason: "backoff",
    since: r.clock.now(),
    until: null,
    cause: { port: "queue", status: "none", code: "queue_required" },
  });
  assert.equal(r.shared.repairWrites, 0);
});

Deno.test("repository pass: queue custody in the fork still holds every operation", async () => {
  const custody = {
    ...preservedIssueWork("issue-1", SHA2),
    wait: { reason: "backoff" as const, since: T0, until: null },
  };
  const r = rig({ record: custody });
  assert.deepEqual(
    await guardQueueOperation(r.pass, r.context, custody, "resume"),
    { kind: "deferred", detail: "native merge queue custody hold" },
  );
  assert.deepEqual(r.forkRow(), custody);
  assert.equal(r.reads.rules, 0);
});
