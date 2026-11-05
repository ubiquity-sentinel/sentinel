/**
 * Git sidecar for the throughput metrics surface (#338): its own fixed ref
 * `refs/heads/sentinel-state/metrics`, so no repair/release snapshot reader,
 * step loop, planner or maintenance walk ever reads or rewrites it.
 *
 * One commit per write, parented on the exact expected head, pushed without
 * force; a moved ref is a `conflict`, a lost push response is reconciled by a
 * fresh lookup (same CAS shape as the maintenance index sidecar). Only the
 * trusted finalize host constructs it.
 */
import type { GitSha } from "../contracts/brands.ts";
import { portError, portOk, type PortResultV1 } from "../contracts/ports.ts";
import {
  parseThroughputMetricsRecordV1,
  type ThroughputMetricsRecordV1,
} from "../contracts/throughput-metrics.ts";
import {
  type GitStateStoreOptions,
  type OpContext,
  randomHex,
  StateGitTransport,
} from "./state-git.ts";
import {
  appendThroughputRecordV1,
  decodeThroughputLedgerV1,
  EMPTY_THROUGHPUT_LEDGER,
  encodeThroughputLedgerV1,
  THROUGHPUT_METRICS_REF,
  type ThroughputMetricsLedgerV1,
} from "./throughput-metrics-ledger.ts";

export type ThroughputWriteStatusV1 = "applied" | "conflict" | "ambiguous";

/** The read/write port the finalize writer uses (fakeable in tests). */
export interface ThroughputMetricsPortV1 {
  read(): Promise<
    PortResultV1<{ head: GitSha | null; ledger: ThroughputMetricsLedgerV1 }>
  >;
  write(input: {
    expectedHead: GitSha | null;
    ledger: ThroughputMetricsLedgerV1;
  }): Promise<
    PortResultV1<{ status: ThroughputWriteStatusV1; head: GitSha | null }>
  >;
}

type Value<T> = T extends { ok: true; value: infer V } ? V : never;
type ReadValue = Value<Awaited<ReturnType<ThroughputMetricsPortV1["read"]>>>;
type WriteValue = Value<Awaited<ReturnType<ThroughputMetricsPortV1["write"]>>>;

const BOT = "github-actions[bot]";
const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";
const TREE_LINE = /^100644 blob [0-9a-f]{40}\t(throughput\/[a-z0-9.-]{1,32})$/;
const SHA = /^[0-9a-f]{40}$/;

export class GitThroughputMetricsStore extends StateGitTransport
  implements ThroughputMetricsPortV1 {
  constructor(options: Omit<GitStateStoreOptions, "role">) {
    super({ ...options, role: "repair" });
  }

  private async lookup(op: OpContext): Promise<PortResultV1<GitSha | null>> {
    const result = await this.git(op, [
      "ls-remote",
      "origin",
      THROUGHPUT_METRICS_REF,
    ]);
    if (!result.ok) return portError("unavailable", "metrics lookup failed");
    const parsed = this.parseLsRemote(result.stdout, THROUGHPUT_METRICS_REF);
    if (parsed.status === "invalid") {
      return portError("invalid", "metrics ref is malformed");
    }
    return portOk(parsed.status === "absent" ? null : parsed.head as GitSha);
  }

  private async initialize(op: OpContext): Promise<PortResultV1<null>> {
    for (
      const args of [["init", "-q"], [
        "remote",
        "add",
        "origin",
        this.remoteUrl,
      ]]
    ) {
      if (!(await this.git(op, args)).ok) {
        return portError("unavailable", "metrics initialization failed");
      }
    }
    return portOk(null);
  }

  private async fetch(
    op: OpContext,
    head: GitSha,
  ): Promise<PortResultV1<null>> {
    const fetched = await this.git(op, [
      "fetch",
      "-q",
      "--no-tags",
      "--no-auto-gc",
      "--depth=1",
      "origin",
      THROUGHPUT_METRICS_REF,
    ]);
    const actual = fetched.ok &&
      await this.git(op, ["rev-parse", "FETCH_HEAD"]);
    if (!actual || !actual.ok || actual.stdout.trim() !== head) {
      return portError("conflict", "metrics ref changed during fetch");
    }
    return portOk(null);
  }

  private async load(
    op: OpContext,
    head: GitSha,
  ): Promise<PortResultV1<ThroughputMetricsLedgerV1>> {
    const tree = await this.git(op, ["ls-tree", "-r", head]);
    if (!tree.ok) return portError("unavailable", "metrics tree unavailable");
    const files = new Map<string, string>();
    for (const line of tree.stdout.split("\n").filter((l) => l.length > 0)) {
      const match = TREE_LINE.exec(line);
      if (match === null) {
        return portError("invalid", "metrics tree is malformed");
      }
      const body = await this.git(op, ["show", `${head}:${match[1]}`]);
      if (!body.ok) return portError("unavailable", "metrics blob unavailable");
      files.set(match[1], body.stdout);
    }
    try {
      return portOk(decodeThroughputLedgerV1(files));
    } catch {
      return portError("invalid", "metrics surface failed validation");
    }
  }

  read(): ReturnType<ThroughputMetricsPortV1["read"]> {
    return this.withOpDir<ReadValue>(async (op) => {
      const ready = await this.initialize(op);
      if (!ready.ok) return ready;
      const found = await this.lookup(op);
      if (!found.ok) return found;
      if (found.value === null) {
        return portOk({ head: null, ledger: EMPTY_THROUGHPUT_LEDGER });
      }
      const fetched = await this.fetch(op, found.value);
      if (!fetched.ok) return fetched;
      const ledger = await this.load(op, found.value);
      if (!ledger.ok) return ledger;
      return portOk({ head: found.value, ledger: ledger.value });
    });
  }

  write(
    input: Parameters<ThroughputMetricsPortV1["write"]>[0],
  ): ReturnType<ThroughputMetricsPortV1["write"]> {
    let files: Map<string, string>;
    try {
      if (input.expectedHead !== null && !SHA.test(input.expectedHead)) {
        throw new Error("invalid head");
      }
      files = encodeThroughputLedgerV1(input.ledger);
      // Re-decode what will be committed: an unbounded or malformed ledger
      // is refused before any Git work.
      decodeThroughputLedgerV1(files);
      if (files.size === 0) throw new Error("empty metrics surface");
    } catch {
      return Promise.resolve(
        portError("invalid", "metrics write is malformed"),
      );
    }
    return this.withOpDir<WriteValue>(async (op) => {
      const ready = await this.initialize(op);
      if (!ready.ok) return ready;
      const found = await this.lookup(op);
      if (!found.ok) return found;
      if (found.value !== input.expectedHead) {
        return portOk({ status: "conflict" as const, head: found.value });
      }
      if (found.value !== null) {
        const fetched = await this.fetch(op, found.value);
        if (!fetched.ok) return fetched;
      }
      await Deno.mkdir(`${op.directory}/throughput`, { recursive: true });
      for (const [path, text] of files) {
        await Deno.writeTextFile(`${op.directory}/${path}`, text);
      }
      if (!(await this.git(op, ["add", "--", ...files.keys()])).ok) {
        return portError("unavailable", "metrics staging failed");
      }
      const tree = await this.git(op, ["write-tree"]);
      if (!tree.ok || !SHA.test(tree.stdout.trim())) {
        return portError("unavailable", "metrics tree unavailable");
      }
      const commit = await this.git(op, [
        "commit-tree",
        tree.stdout.trim(),
        ...(input.expectedHead === null ? [] : ["-p", input.expectedHead]),
        "-m",
        `sentinel throughput metrics\n\nnonce: ${randomHex(32)}`,
      ], {
        GIT_AUTHOR_NAME: BOT,
        GIT_AUTHOR_EMAIL: BOT_EMAIL,
        GIT_COMMITTER_NAME: BOT,
        GIT_COMMITTER_EMAIL: BOT_EMAIL,
      });
      if (!commit.ok || !SHA.test(commit.stdout.trim())) {
        return portError("unavailable", "metrics commit unavailable");
      }
      const candidate = commit.stdout.trim() as GitSha;
      const fresh = await this.lookup(op);
      if (!fresh.ok) return fresh;
      if (fresh.value !== input.expectedHead) {
        return portOk({ status: "conflict" as const, head: fresh.value });
      }
      const push = await this.git(op, [
        "push",
        "origin",
        `${candidate}:${THROUGHPUT_METRICS_REF}`,
      ]);
      const after = await this.lookup(op);
      if (!after.ok) {
        return portOk({ status: "ambiguous" as const, head: null });
      }
      if (after.value === candidate) {
        return portOk({ status: "applied" as const, head: candidate });
      }
      if (!push.ok && after.value !== input.expectedHead) {
        return portOk({ status: "conflict" as const, head: after.value });
      }
      return portOk({ status: "ambiguous" as const, head: after.value });
    });
  }
}

export type ThroughputAppendResultV1 =
  | { status: "applied"; head: GitSha }
  | { status: "duplicate"; head: GitSha | null }
  | { status: "unavailable"; detail: string };

/**
 * Read, append one record and write with the exact read head; a lost CAS
 * race re-reads and retries, at most `attempts` times. Never throws.
 */
export async function appendThroughputMetricsV1(
  port: ThroughputMetricsPortV1,
  record: ThroughputMetricsRecordV1,
  attempts = 3,
): Promise<ThroughputAppendResultV1> {
  try {
    const validated = parseThroughputMetricsRecordV1(record);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const read = await port.read();
      if (!read.ok) return { status: "unavailable", detail: read.error.kind };
      const next = appendThroughputRecordV1(read.value.ledger, validated, {
        compactCompletedDays: true,
      });
      if (next.status === "duplicate") {
        return { status: "duplicate", head: read.value.head };
      }
      const written = await port.write({
        expectedHead: read.value.head,
        ledger: next.ledger,
      });
      if (!written.ok) {
        return { status: "unavailable", detail: written.error.kind };
      }
      if (written.value.status === "applied" && written.value.head !== null) {
        return { status: "applied", head: written.value.head };
      }
      // conflict or ambiguous: re-read; a landed ambiguous write reads back
      // as a duplicate, so the record is never written twice.
    }
    return { status: "unavailable", detail: "conflict" };
  } catch {
    return { status: "unavailable", detail: "invalid" };
  }
}
