/** Private repair-history reuse; no writer shares its mutable Git directory. */
import type { PortResultV1 } from "../contracts/ports.ts";
import { portError } from "../contracts/ports.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../contracts/state-snapshots.ts";
import type { OpContext } from "./state-git.ts";
import type { RecordIdentitySource } from "./state-records.ts";

type Snapshot = RepairStateSnapshotV1 | ReleaseStateSnapshotV1;
interface TreeProof {
  parents: string;
  tree: string;
  bytes: Uint8Array;
}
interface MemoEntry extends TreeProof {
  snapshot: Snapshot;
  size: number;
  records: Record<string, ValidatedMemoRecord>;
}
export interface ValidatedMemoRecord {
  text: string;
  id: string;
  value: RecordIdentitySource;
}

/** A validated result is reusable only after ALL freshly read bytes match. */
export class StateTreeMemo {
  private entries = new Map<string, MemoEntry>();

  read(key: string, proof: TreeProof):
    | { status: "miss" | "mismatch" }
    | { status: "hit"; snapshot: Snapshot } {
    const entry = this.entries.get(key);
    if (!entry) return { status: "miss" };
    if (
      entry.parents !== proof.parents || entry.tree !== proof.tree ||
      entry.bytes.length !== proof.bytes.length ||
      !entry.bytes.every((byte, i) => byte === proof.bytes[i])
    ) return { status: "mismatch" };
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { status: "hit", snapshot: structuredClone(entry.snapshot) };
  }

  record(path: string, text: string): ValidatedMemoRecord | undefined {
    for (const entry of this.entries.values()) {
      const record = entry.records[path];
      if (record?.text === text) return structuredClone(record);
    }
  }

  put(
    key: string,
    proof: TreeProof,
    snapshot: Snapshot,
    records: Record<string, ValidatedMemoRecord> = {},
  ): void {
    const size = proof.bytes.length +
      new TextEncoder().encode(proof.parents + proof.tree).length +
      Object.values(records).reduce(
        (n, row) => n + new TextEncoder().encode(row.text).length,
        0,
      );
    const limit = 8 * 1024 * 1024;
    if (size > limit) return;
    this.entries.delete(key);
    while (
      this.entries.size >= 2 ||
      [...this.entries.values()].reduce((n, row) => n + row.size, 0) + size >
        limit
    ) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, {
      ...proof,
      bytes: proof.bytes.slice(),
      snapshot: structuredClone(snapshot),
      records: structuredClone(records),
      size,
    });
  }
}

interface HistoryEntry {
  op: OpContext;
  head: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  unload: () => void;
}

/** Absolute validity; the unreferenced expiry timer never keeps a process alive. */
const VALID_MS = 120_000;
const RETAIN_BYTES = 256 * 1024 * 1024;

async function diskBytes(directory: string): Promise<number> {
  let total = 0;
  for await (const entry of Deno.readDir(directory)) {
    const path = directory + "/" + entry.name;
    if (entry.isSymlink) throw new Error("unexpected history cache link");
    total += entry.isDirectory
      ? await diskBytes(path)
      : (await Deno.stat(path)).size;
    if (total > RETAIN_BYTES) return total;
  }
  return total;
}

export class RepairHistoryCache {
  private entry: HistoryEntry | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly scratchDir: string) {}

  private async serial<T>(run: () => Promise<T>): Promise<T> {
    const before = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => release = resolve);
    await before;
    try {
      return await run();
    } finally {
      release();
    }
  }

  private async discard(entry: HistoryEntry): Promise<void> {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    globalThis.removeEventListener("unload", entry.unload);
    if (this.entry === entry) this.entry = null;
    entry.op.treeMemo = undefined;
    try {
      await Deno.remove(entry.op.directory, { recursive: true });
    } catch {
      /* Remove only our own mktemp directory; caller scratch is unrelated. */
    }
  }

  async use<T>(
    head: string,
    initialize: (op: OpContext) => Promise<PortResultV1<unknown>>,
    read: (op: OpContext, cold: boolean) => Promise<PortResultV1<T>>,
  ): Promise<PortResultV1<T>> {
    return await this.serial(async () => {
      if (
        this.entry && (
          this.entry.head !== head || Date.now() >= this.entry.expiresAt
        )
      ) await this.discard(this.entry);
      const cold = this.entry === null;
      let entry = this.entry;
      try {
        if (!entry) {
          const directory = await Deno.makeTempDir({
            prefix: "repair-history-",
            dir: this.scratchDir,
          });
          entry = {
            op: { directory, treeMemo: new StateTreeMemo() },
            head,
            expiresAt: Date.now() + VALID_MS,
            timer: null,
            unload: () => {
              try {
                Deno.removeSync(directory, { recursive: true });
              } catch { /* Owned directory only. */ }
            },
          };
          this.entry = entry;
          globalThis.addEventListener("unload", entry.unload);
          await Deno.chmod(directory, 0o700);
          const initialized = await initialize(entry.op);
          if (!initialized.ok) {
            await this.discard(entry);
            return initialized;
          }
          // The validity window starts once the complete history is fetched:
          // a cold fetch longer than the window must not expire the entry
          // before its first read, which would fail every later read of a
          // large or slowly fetched history deterministically. Freshness
          // against the live ref is proven by the caller's `ls-remote`
          // checks, not by this bound.
          entry.expiresAt = Date.now() + VALID_MS;
          const retained = await diskBytes(directory) <= RETAIN_BYTES;
          if (retained) {
            const owned = entry;
            entry.timer = setTimeout(() => {
              void this.serial(async () => {
                if (this.entry === owned) await this.discard(owned);
              });
            }, Math.max(0, entry.expiresAt - Date.now()));
            Deno.unrefTimer(entry.timer);
          }
          const result = await read(entry.op, true);
          if (
            !retained || !result.ok || Date.now() >= entry.expiresAt
          ) await this.discard(entry);
          return result;
        }
        // A read entered inside the window keeps its result even when it ends
        // after `expiresAt`: the bound only limits how long the private
        // history is retained, and the caller's `ls-remote` checks already
        // proved the read current (issue #200). The entry is still discarded,
        // so the next read starts from a fresh fetch.
        const result = await read(entry.op, cold);
        if (!result.ok || Date.now() >= entry.expiresAt) {
          await this.discard(entry);
        }
        return result;
      } catch {
        if (entry) await this.discard(entry);
        return portError("unavailable", "historical repair cache unavailable");
      }
    });
  }
}
