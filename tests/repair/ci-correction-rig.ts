/**
 * Shared rig for the CI correction route: an issue record whose head SHA3 was
 * reviewed (clean, fulfilled) against base SHA1 on PR 7, run through the real
 * repair loop over real Git state with fake GitHub/model ports. Every state
 * write is captured so a test can prove the generation-76 rollback contract:
 * nothing the route writes carries a key or enum value generation 76 cannot
 * parse.
 */
import assert from "node:assert/strict";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { asWorkItemId, type GitSha } from "../../src/contracts/brands.ts";
import {
  type GitHubCheckV1,
  portError,
  portOk,
  type PrepareBaseRefreshRequestV1,
} from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  candidateBranch,
  reviewOperationKey,
  reviewReceiptId,
} from "../../src/repair/keys.ts";
import { reservation, SHA1, SHA3, T0, workRecord } from "../state/helpers.ts";
import { makeRig, ROOT, seededSnapshot, SHA4 } from "./loop-rig.ts";
import { completedReceipt } from "./loop-review-fixtures.ts";
import { exactOpenPr, positiveLifecycle } from "./loop-candidate-fixtures.ts";

export const TASK = asWorkItemId("issue-1");
export const BRANCH = candidateBranch(TASK);

export function check(
  name: string,
  head: GitSha,
  conclusion: GitHubCheckV1["conclusion"],
  status: GitHubCheckV1["status"] = "completed",
): GitHubCheckV1 {
  return {
    name,
    status,
    conclusion,
    head,
    startedAt: T0,
    completedAt: status === "completed" ? T0 + 60_000 : null,
  };
}

export interface CiRigOptions {
  reviewRounds?: number;
  /** Development tip the base ref read reports (record base is SHA1). */
  baseTip?: GitSha;
  checks: Record<string, GitHubCheckV1[]>;
  blocker?: string;
  /** Lifecycle step the reviewed head is parked on (default `delivery`). */
  nextStep?: "delivery" | "work";
  /** Candidate state of the published head (default: the legacy shape). */
  candidateState?: { preserved: null; publishedHead: GitSha };
  /** Earlier review receipts of the same PR, seeded before the current one. */
  priorReviews?: RepairStateSnapshotV1["reviews"];
  /** Run the loop as a hosted (matrix) run does. */
  hosted?: boolean;
  /** The task digest the clean review accepted (default: the blanket fake's). */
  taskDigest?: string;
}

export async function ciRig(prefix: string, options: CiRigOptions) {
  const rounds = options.reviewRounds ?? 1;
  const refreshes: PrepareBaseRefreshRequestV1[] = [];
  const rig = await makeRig(prefix, {
    summaries: false,
    ...(options.hosted === true ? { externalImplementations: true } : {}),
    model: { heads: [SHA4] },
    github: {
      openIssues: [],
      baseSha: options.baseTip ?? SHA1,
      candidateLifecycle: {
        ...positiveLifecycle(),
        refs: { [`refs/heads/${BRANCH}`]: SHA3 },
        pullRequests: [exactOpenPr(7, SHA3, BRANCH)],
        prepareBaseRefresh: (request) => {
          refreshes.push(request);
          return Promise.resolve(
            portError("unavailable", "refresh not exercised by this case"),
          );
        },
      },
    },
  });
  const checkReads: GitSha[] = [];
  rig.github.readChecks = (head: GitSha) => {
    checkReads.push(head);
    return Promise.resolve(
      portOk({
        head,
        checks: options.checks[head] ?? [check("ci", head, "success")],
      }),
    );
  };
  const record = workRecord(TASK, {
    source: { kind: "issue", id: "1", revision: SHA1 },
    related: { incidentId: null, issueNumber: 1 },
    failingRevision: null,
    target: {
      base: SHA1,
      branch: BRANCH,
      checkpoint: null,
      head: SHA3,
      pr: 7,
      ...(options.candidateState === undefined
        ? {}
        : { candidateState: options.candidateState }),
    },
    nextStep: options.blocker !== undefined
      ? "blocked"
      : options.nextStep ?? "delivery",
    blocker: options.blocker === undefined
      ? null
      : { kind: "other", message: options.blocker, since: T0 + 2000 },
    counters: { attempts: 1, retries: 0, reviewRounds: rounds },
    evidence: [{
      kind: "review_receipt",
      ref: `artifact:review-receipt:${"c".repeat(64)}`,
    }],
  });
  const receipt = completedReceipt(7, SHA3, SHA1, {
    id: await reviewReceiptId(reviewOperationKey(7, SHA3, rounds), SHA3),
    ...(options.taskDigest === undefined ? {} : {
      taskAcceptance: {
        issueNumber: 1,
        taskDigest: options.taskDigest,
        verdict: "fulfilled",
        evidence: ["the exact reviewed change implements the source issue"],
      },
    }),
  });
  const charges = [
    reservation("ci-impl-1", {
      taskId: TASK,
      head: SHA1,
      attempt: 1,
      purpose: "implementation",
      outcome: "submitted",
      settledAt: T0 + 500,
    }),
    ...Array.from(
      { length: rounds },
      (_, index) =>
        reservation(`ci-review-${index + 1}`, {
          taskId: TASK,
          head: SHA3,
          attempt: index + 1,
          purpose: "review_request",
          outcome: "submitted",
          settledAt: T0 + 900,
        }),
    ),
  ];
  const written = await rig.store.writeRepair(
    seededSnapshot([record], {
      reviews: [...(options.priorReviews ?? []), receipt],
      reservations: charges,
    }),
    null,
  );
  assert.ok(written.ok && written.value.status === "applied");
  rig.clock.advance(10 * 60_000);
  // Every snapshot the loop writes from here on, exactly as written.
  const writes: RepairStateSnapshotV1[] = [];
  const write = rig.store.writeRepair.bind(rig.store);
  rig.store.writeRepair = (snapshot, expectedHead) => {
    writes.push(structuredClone(snapshot));
    return write(snapshot, expectedHead);
  };
  // The durable record at the moment a correction session starts.
  const atModelStart: RepairStateSnapshotV1[] = [];
  const runModel = rig.model.runModel.bind(rig.model);
  rig.model.runModel = async (request) => {
    atModelStart.push(await rig.snapshot());
    return runModel(request);
  };
  /** Move the development tip the base ref read reports from now on. */
  const moveBase = (tip: GitSha) => {
    (rig.github as unknown as { options: { baseSha?: GitSha } }).options
      .baseSha = tip;
  };
  return {
    rig,
    moveBase,
    record,
    receipt,
    charges,
    refreshes,
    checkReads,
    atModelStart,
    writes,
  };
}

// ---------------------------------------------------------------------------
// Generation-76 rollback contract
// ---------------------------------------------------------------------------

/** Installed generation 76: the runtime a failed generation 77 restores. */
export const GENERATION_76 = "41bb853a1bedfc0422bf903dfabbe23bf714b44f";

/**
 * Frozen copies of the generation-76 work record shapes (src/contracts at
 * GENERATION_76: work-record.ts KEYS/WAIT_KEYS/BLOCKER_KEYS/COUNTERS_KEYS and
 * work-record-target.ts TARGET_KEYS) and of its closed persisted enums. They
 * are deliberately NOT imported from the current contracts: a field added
 * there must still fail this rollback check.
 */
const GEN76_WORK_KEYS = [
  "version",
  "kind",
  "repository",
  "id",
  "source",
  "related",
  "fingerprint",
  "failingRevision",
  "sourceSnapshotDigest",
  "classification",
  "urgency",
  "dependencies",
  "controller",
  "target",
  "nextStep",
  "wait",
  "blocker",
  "counters",
  "evidence",
  "intent",
  "firstSeenAt",
  "createdAt",
  "updatedAt",
];
const GEN76_TARGET_KEYS = ["base", "branch", "checkpoint", "head", "pr"];
const GEN76_TARGET_OPTIONAL_KEYS = ["candidateState", "selfMerge"];
const GEN76_WAIT_KEYS = ["reason", "since", "until"];
const GEN76_BLOCKER_KEYS = ["kind", "message", "since"];
const GEN76_COUNTER_KEYS = ["attempts", "retries", "reviewRounds"];
const GEN76_COUNTER_OPTIONAL_KEYS = ["stalled", "timeouts"];
const GEN76_NEXT_STEPS = ["work", "review", "delivery", "blocked", "done"];
const GEN76_WAIT_REASONS = [
  "budget_cap",
  "review_pending",
  "review_quota",
  "ci_pending",
  "backoff",
  "unavailable",
  "manual",
];
const GEN76_BLOCKER_KINDS = [
  "stale_source",
  "missing_evidence",
  "evidence_expired",
  "dependency",
  "review_quota",
  "unavailable",
  "other",
];
const GEN76_SNAPSHOT_KEYS = [
  "version",
  "kind",
  "stateHead",
  "sequence",
  "updatedAt",
  "incidents",
  "evidence",
  "work",
  "reservations",
  "reviews",
  "replays",
  "releaseRequests",
  "githubCooldowns",
  "attemptMemory",
  "lessons",
];

function sorted(keys: Iterable<string>): string[] {
  return [...keys].sort();
}

function expectKeys(
  value: object,
  required: string[],
  optional: string[],
  path: string,
): void {
  const keys = Object.keys(value).filter((key) =>
    (value as Record<string, unknown>)[key] !== undefined
  );
  for (const key of keys) {
    assert.ok(
      required.includes(key) || optional.includes(key),
      `${path}.${key} is not a generation-76 key`,
    );
  }
  for (const key of required) {
    assert.ok(keys.includes(key), `${path}.${key} is missing`);
  }
}

/**
 * Every written snapshot keeps exactly the generation-76 shapes: snapshot and
 * work record key sets, target/wait/blocker/counter key sets and the closed
 * persisted enums. Runs everywhere (no Git history needed).
 */
export function assertGeneration76Shapes(
  snapshots: readonly RepairStateSnapshotV1[],
): void {
  assert.ok(snapshots.length > 0, "the scenario wrote state");
  for (const [index, snapshot] of snapshots.entries()) {
    assert.deepEqual(
      sorted(Object.keys(snapshot)),
      sorted(GEN76_SNAPSHOT_KEYS),
      `write ${index}: snapshot keys`,
    );
    for (const work of snapshot.work) {
      const path = `write ${index}: work ${work.id}`;
      expectKeys(work, GEN76_WORK_KEYS, [], path);
      expectKeys(
        work.target,
        GEN76_TARGET_KEYS,
        GEN76_TARGET_OPTIONAL_KEYS,
        `${path}.target`,
      );
      expectKeys(
        work.counters,
        GEN76_COUNTER_KEYS,
        GEN76_COUNTER_OPTIONAL_KEYS,
        `${path}.counters`,
      );
      assert.ok(GEN76_NEXT_STEPS.includes(work.nextStep), `${path}.nextStep`);
      if (work.wait !== null) {
        expectKeys(work.wait, GEN76_WAIT_KEYS, [], `${path}.wait`);
        assert.ok(
          GEN76_WAIT_REASONS.includes(work.wait.reason),
          `${path}.wait.reason`,
        );
      }
      if (work.blocker !== null) {
        expectKeys(work.blocker, GEN76_BLOCKER_KEYS, [], `${path}.blocker`);
        assert.ok(
          GEN76_BLOCKER_KINDS.includes(work.blocker.kind),
          `${path}.blocker.kind`,
        );
      }
    }
  }
}

async function git(args: string[]): Promise<string | null> {
  const output = await new Deno.Command("git", {
    args,
    cwd: ROOT,
    stdout: "piped",
    stderr: "null",
  }).output();
  return output.success ? new TextDecoder().decode(output.stdout) : null;
}

/**
 * The generation-76 `parseRepairStateSnapshotV1`, loaded from the exact
 * src/contracts tree of GENERATION_76 materialized from the local object
 * store. Null when that commit is not available (a shallow CI checkout); the
 * frozen shape assertions above still run there.
 */
export async function loadGeneration76Parser(): Promise<
  ((input: unknown) => RepairStateSnapshotV1) | null
> {
  if (await git(["cat-file", "-e", `${GENERATION_76}^{commit}`]) === null) {
    return null;
  }
  const listing = await git([
    "ls-tree",
    "--name-only",
    GENERATION_76,
    "src/contracts/",
  ]);
  if (listing === null) return null;
  const files = listing.split("\n").filter((path) => path.endsWith(".ts"));
  const dir = await Deno.makeTempDir({
    dir: ROOT,
    prefix: "sentinel-gen76-contracts-",
  });
  try {
    for (const path of files) {
      const content = await git(["show", `${GENERATION_76}:${path}`]);
      if (content === null) return null;
      await Deno.writeTextFile(`${dir}/${basename(path)}`, content);
    }
    const module = await import(
      pathToFileURL(`${dir}/state-snapshots.ts`).href
    );
    return module.parseRepairStateSnapshotV1;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}
