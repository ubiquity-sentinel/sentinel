/**
 * Git sidecar for the delivery-train ledger (sentinel #330): its own fixed
 * ref `refs/heads/sentinel-state/trains`, one canonical JSON file per target
 * repository (`trains/<installation>-<owner>-<name>.json`), so no repair or
 * release snapshot reader ever reads or rewrites it.
 *
 * The launcher delivery pass is its only writer. Each repository's head is
 * the blob id of its own file (null: never written), so one repository's
 * write never conflicts with another's: a write commits on the exact current
 * ref head only while that repository's blob is still the expected one, and
 * pushes without force (a moved ref is re-read, at most three times). A lost
 * push response is reconciled by a fresh lookup. `readHolds` is the
 * runtime's read-only view of every open train.
 */
import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import {
  deliveryTrainHolds,
  type DeliveryTrainHoldV1,
  type DeliveryTrainJournalV1,
  type DeliveryTrainLedgerV1,
  EMPTY_DELIVERY_TRAIN_LEDGER,
  parseDeliveryTrainLedgerV1,
} from "../contracts/delivery-train-ledger.ts";
import { portError, portOk, type PortResultV1 } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import {
  type GitStateStoreOptions,
  type OpContext,
  StateGitTransport,
} from "./state-git.ts";

export const DELIVERY_TRAIN_REF = "refs/heads/sentinel-state/trains";
const DIR = "trains";
const BOT = "github-actions[bot]";
const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";
const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const TREE_LINE = /^100644 blob ([0-9a-f]{40})\t(trains\/[^\t/]{1,240}\.json)$/;
const WRITE_ATTEMPTS = 3;
/** Bound of the files read for the runtime's holds. */
const MAX_FILES = 64;

type ReadValue = { head: string | null; ledger: DeliveryTrainLedgerV1 };
type WriteValue = {
  status: "applied" | "conflict" | "ambiguous";
  head: string | null;
};

interface StoredLedgerV1 {
  repository: RepositoryIdentityV1;
  ledger: DeliveryTrainLedgerV1;
}

/** The file of one exact repository identity, or null when unnameable. */
export function deliveryTrainPath(
  repository: RepositoryIdentityV1,
): string | null {
  return Number.isSafeInteger(repository.installationId) &&
      repository.installationId >= 0 && NAME.test(repository.owner) &&
      NAME.test(repository.name)
    ? `${DIR}/${repository.installationId}-${repository.owner}-${repository.name}.json`
    : null;
}

function sameRepository(a: RepositoryIdentityV1, b: RepositoryIdentityV1) {
  return a.installationId === b.installationId && a.owner === b.owner &&
    a.name === b.name;
}

function parseStored(text: string): StoredLedgerV1 | null {
  try {
    const value = JSON.parse(text);
    if (
      value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "ledger,repository"
    ) return null;
    const repository = value.repository;
    if (
      repository === null || typeof repository !== "object" ||
      Object.keys(repository).sort().join(",") !==
        "installationId,name,owner" ||
      deliveryTrainPath(repository) === null
    ) return null;
    const ledger = parseDeliveryTrainLedgerV1(value.ledger);
    return ledger === null ? null : {
      repository: {
        owner: repository.owner,
        name: repository.name,
        installationId: repository.installationId,
      },
      ledger,
    };
  } catch {
    return null;
  }
}

export class GitDeliveryTrainStore extends StateGitTransport
  implements DeliveryTrainJournalV1 {
  constructor(options: Omit<GitStateStoreOptions, "role">) {
    super({ ...options, role: "repair" });
  }

  private async prepare(
    op: OpContext,
  ): Promise<PortResultV1<GitSha | null>> {
    for (
      const args of [["init", "-q"], [
        "remote",
        "add",
        "origin",
        this.remoteUrl,
      ]]
    ) {
      if (!(await this.git(op, args)).ok) {
        return portError("unavailable", "train ledger initialization failed");
      }
    }
    return await this.lookup(op);
  }

  private async lookup(op: OpContext): Promise<PortResultV1<GitSha | null>> {
    const result = await this.git(op, [
      "ls-remote",
      "origin",
      DELIVERY_TRAIN_REF,
    ]);
    if (!result.ok) return portError("unavailable", "train ledger lookup");
    const parsed = this.parseLsRemote(result.stdout, DELIVERY_TRAIN_REF);
    if (parsed.status === "invalid") {
      return portError("invalid", "train ledger ref is malformed");
    }
    return portOk(parsed.status === "absent" ? null : parsed.head as GitSha);
  }

  private async fetch(op: OpContext, head: GitSha): Promise<boolean> {
    const fetched = await this.git(op, [
      "fetch",
      "-q",
      "--no-tags",
      "--no-auto-gc",
      "--depth=1",
      "origin",
      DELIVERY_TRAIN_REF,
    ]);
    const actual = fetched.ok &&
      await this.git(op, ["rev-parse", "FETCH_HEAD"]);
    return actual !== false && actual.ok && actual.stdout.trim() === head;
  }

  /** The ledger files at `head`: path -> blob id. */
  private async files(
    op: OpContext,
    head: GitSha,
  ): Promise<Map<string, string> | null> {
    const tree = await this.git(op, ["ls-tree", "-r", head]);
    if (!tree.ok) return null;
    const files = new Map<string, string>();
    for (const line of tree.stdout.split("\n").filter((l) => l.length > 0)) {
      const match = TREE_LINE.exec(line);
      if (match === null) return null;
      files.set(match[2], match[1]);
    }
    return files.size > MAX_FILES ? null : files;
  }

  private async blob(op: OpContext, id: string): Promise<string | null> {
    const body = await this.git(op, ["cat-file", "blob", id]);
    return body.ok ? body.stdout : null;
  }

  read(
    repository: RepositoryIdentityV1,
  ): ReturnType<DeliveryTrainJournalV1["read"]> {
    const path = deliveryTrainPath(repository);
    if (path === null) return Promise.resolve(null);
    return this.withOpDir<ReadValue>(async (op) => {
      const head = await this.prepare(op);
      if (!head.ok) return head;
      if (head.value === null) {
        return portOk({ head: null, ledger: EMPTY_DELIVERY_TRAIN_LEDGER });
      }
      if (!await this.fetch(op, head.value)) {
        return portError("conflict", "train ledger moved during fetch");
      }
      const files = await this.files(op, head.value);
      if (files === null) return portError("invalid", "train ledger tree");
      const id = files.get(path);
      if (id === undefined) {
        return portOk({ head: null, ledger: EMPTY_DELIVERY_TRAIN_LEDGER });
      }
      const text = await this.blob(op, id);
      const stored = text === null ? null : parseStored(text);
      if (stored === null || !sameRepository(stored.repository, repository)) {
        return portError("invalid", "train ledger file failed validation");
      }
      return portOk({ head: id, ledger: stored.ledger });
    }).then((result) => result.ok ? result.value : null);
  }

  write(
    input: Parameters<DeliveryTrainJournalV1["write"]>[0],
  ): ReturnType<DeliveryTrainJournalV1["write"]> {
    const path = deliveryTrainPath(input.repository);
    const ledger = parseDeliveryTrainLedgerV1(structuredClone(input.ledger));
    if (
      path === null || ledger === null ||
      (input.expectedHead !== null && !SHA.test(input.expectedHead))
    ) return Promise.resolve(null);
    const text = `${
      canonicalStringify({ repository: input.repository, ledger })
    }\n`;
    return this.withOpDir<WriteValue>(async (op) => {
      const ready = await this.prepare(op);
      if (!ready.ok) return ready;
      let current: GitSha | null = ready.value;
      for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
        let files = new Map<string, string>();
        if (current !== null) {
          if (!await this.fetch(op, current)) {
            const again = await this.lookup(op);
            if (!again.ok) return again;
            current = again.value;
            continue;
          }
          const read = await this.files(op, current);
          if (read === null) return portError("invalid", "train ledger tree");
          files = read;
        }
        const blob = files.get(path) ?? null;
        if (blob !== input.expectedHead) {
          return portOk({ status: "conflict" as const, head: blob });
        }
        const written = await this.git(
          op,
          [
            "hash-object",
            "-w",
            "--stdin",
          ],
          undefined,
          { stdin: new TextEncoder().encode(text) },
        );
        const id = written.stdout.trim();
        if (!written.ok || !SHA.test(id)) {
          return portError("unavailable", "train ledger blob");
        }
        files.set(path, id);
        const tree = await this.git(op, ["mktree"], undefined, {
          stdin: new TextEncoder().encode(
            [...files].sort(([a], [b]) => a < b ? -1 : 1)
              .map(([file, sha]) =>
                `100644 blob ${sha}\t${file.slice(DIR.length + 1)}\n`
              ).join(""),
          ),
        });
        const subtree = tree.stdout.trim();
        if (!tree.ok || !SHA.test(subtree)) {
          return portError("unavailable", "train ledger tree");
        }
        const root = await this.git(op, ["mktree"], undefined, {
          stdin: new TextEncoder().encode(`040000 tree ${subtree}\t${DIR}\n`),
        });
        const rootTree = root.stdout.trim();
        if (!root.ok || !SHA.test(rootTree)) {
          return portError("unavailable", "train ledger tree");
        }
        const commit = await this.git(op, [
          "commit-tree",
          rootTree,
          ...(current === null ? [] : ["-p", current]),
          "-m",
          "sentinel delivery train ledger",
        ], {
          GIT_AUTHOR_NAME: BOT,
          GIT_AUTHOR_EMAIL: BOT_EMAIL,
          GIT_COMMITTER_NAME: BOT,
          GIT_COMMITTER_EMAIL: BOT_EMAIL,
        });
        const candidate = commit.stdout.trim();
        if (!commit.ok || !SHA.test(candidate)) {
          return portError("unavailable", "train ledger commit");
        }
        await this.git(op, [
          "push",
          "-q",
          "origin",
          `${candidate}:${DELIVERY_TRAIN_REF}`,
        ]);
        const after = await this.lookup(op);
        if (!after.ok) {
          return portOk({ status: "ambiguous" as const, head: null });
        }
        if (after.value === candidate) {
          return portOk({ status: "applied" as const, head: id });
        }
        // Another repository's write moved the ref: re-read and retry while
        // this repository's own file is still the expected one.
        current = after.value;
      }
      return portOk({ status: "ambiguous" as const, head: null });
    }).then((result) => result.ok ? result.value : null);
  }

  /** Every open train on the ledger (the runtime's refresh hold). */
  readHolds(): Promise<PortResultV1<DeliveryTrainHoldV1[]>> {
    return this.withOpDir<DeliveryTrainHoldV1[]>(async (op) => {
      const head = await this.prepare(op);
      if (!head.ok) return head;
      if (head.value === null) return portOk([]);
      if (!await this.fetch(op, head.value)) {
        return portError("conflict", "train ledger moved during fetch");
      }
      const files = await this.files(op, head.value);
      if (files === null) return portError("invalid", "train ledger tree");
      const ledgers: StoredLedgerV1[] = [];
      for (const [path, id] of files) {
        const text = await this.blob(op, id);
        const stored = text === null ? null : parseStored(text);
        if (stored === null || deliveryTrainPath(stored.repository) !== path) {
          return portError("invalid", "train ledger file failed validation");
        }
        ledgers.push(stored);
      }
      return portOk(deliveryTrainHolds(ledgers));
    });
  }
}
