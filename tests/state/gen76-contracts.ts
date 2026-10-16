/**
 * Generation-76 rollback parsers. A failed generation-77 first trial restores
 * the installed generation-76 runtime once, and that runtime's STRICT contract
 * parsers then read every record generation 77 wrote. This helper extracts the
 * exact `src/contracts/` tree of the pinned generation-76 runtime commit
 * read-only from the local object store (`git ls-tree` + `git show`) into a
 * disposable directory under the repository root and imports its parsers, so
 * a test can prove that every snapshot written by new code still parses under
 * the runtime a rollback would reinstate. No network, no checkout mutation.
 *
 * A shallow clone that does not hold the pinned commit cannot run the proof:
 * `gen76Available` reports that and callers mark the case ignored instead of
 * silently passing it. The structural key-set guard in `assertGen76Shape`
 * always runs and pins the generation-76 key sets as literals.
 */
import assert from "node:assert/strict";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";

/** Installed generation-76 runtime revision (the rollback target). */
export const GEN76_RUNTIME = "41bb853a1bedfc0422bf903dfabbe23bf714b44f";

const HERE = new URL(import.meta.url);
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/state\/gen76-contracts\.ts$/,
  "",
);

async function git(args: string[]): Promise<
  { ok: boolean; stdout: string }
> {
  try {
    const output = await new Deno.Command("git", {
      args: ["-C", ROOT, ...args],
      clearEnv: true,
      env: {
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdout: "piped",
      stderr: "null",
    }).output();
    return {
      ok: output.success,
      stdout: new TextDecoder().decode(output.stdout),
    };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/** True when the pinned generation-76 commit is in the local object store. */
export async function gen76Available(): Promise<boolean> {
  const probe = await git(["cat-file", "-e", `${GEN76_RUNTIME}^{commit}`]);
  return probe.ok;
}

export interface Gen76ParsersV1 {
  parseRepairStateSnapshotV1(input: unknown): RepairStateSnapshotV1;
  parseReleaseStateSnapshotV1(input: unknown): ReleaseStateSnapshotV1;
}

let cached: Promise<Gen76ParsersV1> | null = null;

/**
 * Import the generation-76 snapshot parsers from the pinned commit. The
 * extracted tree is removed right after the import (the module graph is held
 * in memory), so no scratch directory is left in the repository root.
 */
export function loadGen76Parsers(): Promise<Gen76ParsersV1> {
  if (cached !== null) return cached;
  cached = (async () => {
    const listing = await git([
      "ls-tree",
      "-r",
      "--name-only",
      GEN76_RUNTIME,
      "src/contracts",
    ]);
    if (!listing.ok) throw new Error("generation-76 contracts unavailable");
    const files = listing.stdout.split("\n").filter((line) =>
      line.endsWith(".ts")
    );
    assert.ok(files.length > 0, "generation-76 contract tree is empty");
    const tmp = await Deno.makeTempDir({
      dir: ROOT,
      prefix: "sentinel-gen76-contracts-",
    });
    try {
      for (const file of files) {
        const shown = await git(["show", `${GEN76_RUNTIME}:${file}`]);
        if (!shown.ok) throw new Error(`generation-76 ${file} unreadable`);
        const target = `${tmp}/${file}`;
        await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
          recursive: true,
        });
        await Deno.writeTextFile(target, shown.stdout);
      }
      const module = await import(
        new URL(`file://${tmp}/src/contracts/state-snapshots.ts`).href
      );
      return {
        parseRepairStateSnapshotV1: module.parseRepairStateSnapshotV1,
        parseReleaseStateSnapshotV1: module.parseReleaseStateSnapshotV1,
      } as Gen76ParsersV1;
    } finally {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    }
  })();
  return cached;
}

const WORK_KEYS = [
  "blocker",
  "classification",
  "controller",
  "counters",
  "createdAt",
  "dependencies",
  "evidence",
  "failingRevision",
  "fingerprint",
  "firstSeenAt",
  "id",
  "intent",
  "kind",
  "nextStep",
  "related",
  "repository",
  "source",
  "sourceSnapshotDigest",
  "target",
  "updatedAt",
  "urgency",
  "version",
  "wait",
];
const TARGET_KEYS = ["base", "branch", "checkpoint", "head", "pr"];
const TARGET_OPTIONAL_KEYS = ["candidateState", "selfMerge"];
const CANDIDATE_STATE_KEYS = ["preserved", "publishedHead"];
const PRESERVATION_KEYS = ["base", "head", "operationKey", "ref"];
const INTENT_KEYS = [
  "branch",
  "expectedHead",
  "key",
  "kind",
  "observedBase",
  "pr",
  "requestId",
  "resultId",
  "startedAt",
];
const INTENT_OPTIONAL_KEYS = ["failure", "selfMerge"];
const BLOCKER_KEYS = ["kind", "message", "since"];
const WAIT_KEYS = ["reason", "since", "until"];
const COUNTER_KEYS = ["attempts", "retries", "reviewRounds"];
const COUNTER_OPTIONAL_KEYS = ["stalled", "timeouts"];
const NEXT_STEPS = ["work", "review", "delivery", "blocked", "done"];
const BLOCKER_KINDS = [
  "stale_source",
  "missing_evidence",
  "evidence_expired",
  "dependency",
  "review_quota",
  "unavailable",
  "other",
];
const WAIT_REASONS = [
  "budget_cap",
  "review_pending",
  "review_quota",
  "ci_pending",
  "backoff",
  "unavailable",
  "manual",
];

function keysWithin(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  assert.ok(value !== null && typeof value === "object", `${path} object`);
  const keys = Object.keys(value as Record<string, unknown>);
  for (const key of required) {
    assert.ok(keys.includes(key), `${path}.${key} is required by gen 76`);
  }
  for (const key of keys) {
    assert.ok(
      required.includes(key) || optional.includes(key),
      `${path}.${key} is not a generation-76 key`,
    );
  }
}

/**
 * Literal generation-76 key-set and persisted-enum guard over every work
 * record of one snapshot. It runs everywhere (including shallow CI clones)
 * and complements the full pinned-parser proof.
 */
export function assertGen76Shape(snapshot: RepairStateSnapshotV1): void {
  for (const record of snapshot.work) {
    const raw = JSON.parse(JSON.stringify(record));
    keysWithin(raw, WORK_KEYS, [], `work[${record.id}]`);
    keysWithin(raw.target, TARGET_KEYS, TARGET_OPTIONAL_KEYS, "target");
    if (raw.target.candidateState !== undefined) {
      keysWithin(
        raw.target.candidateState,
        CANDIDATE_STATE_KEYS,
        [],
        "target.candidateState",
      );
      if (raw.target.candidateState.preserved !== null) {
        keysWithin(
          raw.target.candidateState.preserved,
          PRESERVATION_KEYS,
          [],
          "target.candidateState.preserved",
        );
      }
    }
    if (raw.intent !== null) {
      keysWithin(raw.intent, INTENT_KEYS, INTENT_OPTIONAL_KEYS, "intent");
    }
    if (raw.blocker !== null) {
      keysWithin(raw.blocker, BLOCKER_KEYS, [], "blocker");
      assert.ok(BLOCKER_KINDS.includes(raw.blocker.kind), "blocker kind");
    }
    if (raw.wait !== null) {
      keysWithin(raw.wait, WAIT_KEYS, [], "wait");
      assert.ok(WAIT_REASONS.includes(raw.wait.reason), "wait reason");
    }
    keysWithin(raw.counters, COUNTER_KEYS, COUNTER_OPTIONAL_KEYS, "counters");
    assert.ok(NEXT_STEPS.includes(raw.nextStep), "nextStep");
  }
}

/**
 * Full rollback proof for one written snapshot: the literal shape guard, then
 * the pinned generation-76 parser (which also re-validates every reservation,
 * review, attempt-memory and lesson row the snapshot carries).
 */
export async function assertGen76Parses(
  snapshot: RepairStateSnapshotV1,
): Promise<void> {
  assertGen76Shape(snapshot);
  const parsers = await loadGen76Parsers();
  parsers.parseRepairStateSnapshotV1(JSON.parse(JSON.stringify(snapshot)));
}
