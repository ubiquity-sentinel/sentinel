/**
 * Pass-scoped live GitHub inputs of the serial repair pass (issue #326).
 *
 * The pass asks each repository that holds live records ONCE for every such
 * record's inputs through the optional batched port read
 * (`GitHubPort.readLiveInputs`). When that read fails (any error but a
 * cooldown), the repository is reported `unavailable` — never an empty
 * success — and each record's inputs come from the existing per-record reads
 * instead (`readIssue`, `readPullRequest`, `readChecks`, `readRef`), at most
 * once per record per pass, with bounded read-only concurrency. A record whose
 * inputs cannot be read has no inputs (`null`): it is stepped as before, never
 * skipped.
 *
 * These are advisory scheduling inputs: they decide only whether a record
 * whose inputs are unchanged needs another step. A stepped record still
 * performs its own exact reads before any effect.
 */
import type { GitSha } from "../contracts/brands.ts";
import type { LiveInputsV1 } from "../contracts/live-inputs.ts";
import type { GitHubCheckV1 } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { checkGithubCooldown } from "./loop-bounds.ts";
import { configFor } from "./loop-records.ts";
import type { RepairCycleDepsV1, RunBoundsV1 } from "./loop-types.ts";

/** Read-only fallback records in flight; effects remain serial. */
const LIVE_INPUT_FALLBACK_CONCURRENCY = 4;

/** One record's normalized live inputs. */
export interface RecordLiveInputsV1 {
  /** Which read produced them; the two are never compared with each other. */
  source: "batch" | "fallback";
  /** `none`: the record has no source issue; null: the issue is absent. */
  issue: "open" | "closed" | "none" | null;
  /** `none`: the record has no PR yet; null: the PR is absent. */
  pull:
    | {
      state: "open" | "closed" | "merged";
      head: GitSha;
      base: GitSha;
      baseRef: string;
      checks: string;
      latestReview: number | null;
    }
    | "none"
    | null;
  /** Configured base branch tip; null when the branch is absent. */
  baseTip: GitSha | null;
}

type RepositoryReadV1 =
  | { status: "batch"; value: LiveInputsV1 }
  | { status: "unavailable" }
  | { status: "cooling" }
  | { status: "absent" };

export interface LiveInputMetricsV1 {
  /** Batched repository reads that answered. */
  batchReads: number;
  /** Repositories whose batched read failed (per-record fallback). */
  batchUnavailable: number;
  /** Distinct records whose inputs were read (batch or fallback). */
  recordsRead: number;
}

function repositoryKey(repository: RepositoryIdentityV1): string {
  return `${repository.installationId}/${repository.owner}/${repository.name}`;
}

function pullNumber(record: WorkRecordV1): number | null {
  return record.target.pr ?? record.intent?.pr ?? null;
}

export class PassLiveInputs {
  private readonly repositories = new Map<string, RepositoryReadV1>();
  private readonly records = new Map<string, RecordLiveInputsV1 | null>();
  private readonly fallbackTips = new Map<
    string,
    Promise<GitSha | null | "failed">
  >();
  readonly metrics: LiveInputMetricsV1 = {
    batchReads: 0,
    batchUnavailable: 0,
    recordsRead: 0,
  };

  constructor(
    private readonly deps: RepairCycleDepsV1,
    private readonly bounds: RunBoundsV1,
  ) {}

  /**
   * One batched read per repository not yet read in this pass, covering every
   * given record of that repository. Later records of an already-read
   * repository are answered from that read or have no inputs.
   */
  async prime(records: readonly WorkRecordV1[]): Promise<void> {
    const groups = new Map<string, WorkRecordV1[]>();
    for (const record of records) {
      if (configFor(this.deps, record.repository) === null) continue;
      const key = repositoryKey(record.repository);
      if (this.repositories.has(key)) continue;
      const group = groups.get(key) ?? [];
      group.push(record);
      groups.set(key, group);
    }
    for (const [key, group] of groups) {
      const read = await this.readRepository(group);
      this.repositories.set(key, read);
      if (read.status === "unavailable") await this.primeFallback(group);
    }
  }

  /** A failed batch must not turn a hot tier into serial network round trips. */
  private async primeFallback(records: readonly WorkRecordV1[]): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (
        next < records.length &&
        this.deps.clock.now() < this.bounds.runDeadline
      ) {
        await this.inputsFor(records[next++]);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(LIVE_INPUT_FALLBACK_CONCURRENCY, records.length) },
        worker,
      ),
    );
  }

  private async readRepository(
    group: readonly WorkRecordV1[],
  ): Promise<RepositoryReadV1> {
    const repository = group[0].repository;
    const config = configFor(this.deps, repository)!;
    // A port without the batched capability keeps the pass exactly as it
    // was: no cooldown check, no extra per-record read, no fingerprint and
    // no skip.
    const read = this.deps.github.readLiveInputs;
    if (read === undefined) return { status: "absent" };
    const cooling = await checkGithubCooldown(
      this.deps,
      repository,
      this.bounds,
    );
    if (cooling.kind !== "ok") return { status: "cooling" };
    let result;
    try {
      result = await read.call(this.deps.github, {
        repository,
        issues: group.flatMap((record) =>
          record.related.issueNumber === null
            ? []
            : [record.related.issueNumber]
        ),
        pulls: group.flatMap((record) => {
          const number = pullNumber(record);
          return number === null ? [] : [number];
        }),
        branches: [config.baseBranch],
      });
    } catch {
      this.metrics.batchUnavailable++;
      return { status: "unavailable" };
    }
    if (result.ok) {
      this.metrics.batchReads++;
      return { status: "batch", value: result.value };
    }
    if (result.error.kind === "rate_limited") return { status: "cooling" };
    this.metrics.batchUnavailable++;
    return { status: "unavailable" };
  }

  /** The record's inputs for this pass, or null when they cannot be read. */
  async inputsFor(record: WorkRecordV1): Promise<RecordLiveInputsV1 | null> {
    if (this.records.has(record.id)) return this.records.get(record.id)!;
    const read = this.repositories.get(repositoryKey(record.repository));
    let inputs: RecordLiveInputsV1 | null = null;
    if (read?.status === "batch") inputs = this.fromBatch(record, read.value);
    if (read?.status === "unavailable") inputs = await this.fallback(record);
    // An unread repository (not primed, cooling, no batched capability)
    // records nothing.
    if (read?.status === "batch" || read?.status === "unavailable") {
      this.records.set(record.id, inputs);
      if (inputs !== null) this.metrics.recordsRead++;
    }
    return inputs;
  }

  private fromBatch(
    record: WorkRecordV1,
    value: LiveInputsV1,
  ): RecordLiveInputsV1 | null {
    const config = configFor(this.deps, record.repository);
    if (config === null) return null;
    const branch = value.branches.find((row) =>
      row.branch === config.baseBranch
    );
    if (branch === undefined) return null;
    let issue: RecordLiveInputsV1["issue"] = "none";
    const issueNumber = record.related.issueNumber;
    if (issueNumber !== null) {
      const row = value.issues.find((entry) => entry.number === issueNumber);
      if (row === undefined) return null;
      issue = row.state;
    }
    let pull: RecordLiveInputsV1["pull"] = "none";
    const number = pullNumber(record);
    if (number !== null) {
      const row = value.pulls.find((entry) => entry.number === number);
      if (row === undefined) return null;
      pull = row.pull === null ? null : {
        state: row.pull.state,
        head: row.pull.head,
        base: row.pull.base,
        baseRef: row.pull.baseRef,
        checks: row.pull.checks,
        latestReview: row.pull.latestReview,
      };
    }
    return { source: "batch", issue, pull, baseTip: branch.tip };
  }

  /** The old per-record reads; any failed read means no inputs. */
  private async fallback(
    record: WorkRecordV1,
  ): Promise<RecordLiveInputsV1 | null> {
    const config = configFor(this.deps, record.repository);
    if (config === null) return null;
    const cooling = await checkGithubCooldown(
      this.deps,
      record.repository,
      this.bounds,
    );
    if (cooling.kind !== "ok") return null;
    try {
      const baseTip = await this.fallbackTip(record, config.baseBranch);
      if (baseTip === "failed") return null;
      let issue: RecordLiveInputsV1["issue"] = "none";
      if (record.related.issueNumber !== null) {
        const read = await this.deps.github.readIssue(
          record.related.issueNumber,
        );
        if (!read.ok) return null;
        issue = read.value?.state ?? null;
      }
      let pull: RecordLiveInputsV1["pull"] = "none";
      const number = pullNumber(record);
      if (number !== null) {
        const read = await this.deps.github.readPullRequest(number);
        if (!read.ok) return null;
        if (read.value === null) {
          pull = null;
        } else {
          const checks = await this.deps.github.readChecks(read.value.head);
          if (!checks.ok) return null;
          pull = {
            state: read.value.state,
            head: read.value.head,
            base: read.value.base,
            baseRef: read.value.baseRef,
            checks: reduceChecks(checks.value.checks),
            latestReview: null,
          };
        }
      }
      return { source: "fallback", issue, pull, baseTip };
    } catch {
      return null;
    }
  }

  private fallbackTip(
    record: WorkRecordV1,
    branch: string,
  ): Promise<GitSha | null | "failed"> {
    const key = `${repositoryKey(record.repository)}#${branch}`;
    const cached = this.fallbackTips.get(key);
    if (cached !== undefined) return cached;
    // Cache the in-flight read too: concurrent fallback records share the
    // same repository/branch observation, including a failed observation.
    const tip = (async () => {
      const read = await this.deps.github.readRef(`refs/heads/${branch}`);
      return read.ok ? read.value?.sha ?? null : "failed" as const;
    })();
    this.fallbackTips.set(key, tip);
    return tip;
  }
}

/** The per-record check read reduced to one conclusion. */
export function reduceChecks(checks: readonly GitHubCheckV1[]): string {
  if (checks.length === 0) return "none";
  if (checks.some((check) => check.status !== "completed")) return "pending";
  const failed = new Set([
    "failure",
    "cancelled",
    "timed_out",
    "action_required",
  ]);
  return checks.some((check) => failed.has(check.conclusion ?? ""))
    ? "failure"
    : "success";
}
