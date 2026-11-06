/** Opaque CI sidecar. Construct only after separate storage/disclosure acceptance. */
import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import {
  CI_MINUTE_MAX_BYTES,
  CI_MINUTE_PRIVATE_REMOTE,
  CI_MINUTE_REF,
  parseCiMinuteLedger,
  validateCiMinuteTransition,
} from "../contracts/ci-minute-budget.ts";
import type {
  CiMinuteLedgerV1,
  CiMinuteStoreV1,
} from "../contracts/ci-minute-budget.ts";
import {
  type GitStateStoreOptions,
  type OpContext,
  randomHex,
  StateGitTransport,
} from "./state-git.ts";

const SHA = /^[0-9a-f]{40}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const TREE =
  /^100644 blob ([0-9a-f]{40})\t(ci-minutes\/ubiquity\/(\d{4}-(?:0[1-9]|1[0-2]))\.json)$/;
type ReadValue = { head: GitSha | null; ledger: CiMinuteLedgerV1 | null };
type WriteValue = {
  status: "applied" | "conflict" | "ambiguous";
  head: GitSha | null;
};

export class GitCiMinuteStore extends StateGitTransport
  implements CiMinuteStoreV1 {
  constructor(
    options: Omit<GitStateStoreOptions, "role"> & { storageAcceptance: string },
  ) {
    if (!/^[0-9a-f]{64}$/.test(options.storageAcceptance)) {
      throw new Error("CI storage acceptance required");
    }
    if (
      options.remoteUrl !== CI_MINUTE_PRIVATE_REMOTE &&
      !options.remoteUrl.startsWith("/")
    ) {
      throw new Error(
        "CI state requires the fixed private remote or an owned local fixture",
      );
    }
    super({ ...options, role: "repair" });
  }

  private async initialize(op: OpContext): Promise<boolean> {
    for (
      const args of [["init", "-q"], [
        "remote",
        "add",
        "origin",
        this.remoteUrl,
      ]]
    ) {
      if (!(await this.git(op, args)).ok) return false;
    }
    return true;
  }

  private async lookup(op: OpContext): Promise<PortResultV1<GitSha | null>> {
    const result = await this.git(op, ["ls-remote", "origin", CI_MINUTE_REF]);
    if (!result.ok) return portError("unavailable", "CI ledger lookup");
    const parsed = this.parseLsRemote(result.stdout, CI_MINUTE_REF);
    return parsed.status === "invalid"
      ? portError("invalid", "CI ledger ref")
      : portOk(parsed.status === "absent" ? null : parsed.head as GitSha);
  }

  private async load(
    op: OpContext,
    head: GitSha,
  ): Promise<PortResultV1<Map<string, CiMinuteLedgerV1>>> {
    const fetched = await this.git(op, [
      "fetch",
      "-q",
      "--no-tags",
      "--no-auto-gc",
      "--depth=1",
      "origin",
      CI_MINUTE_REF,
    ]);
    const actual = fetched.ok
      ? await this.git(op, ["rev-parse", "FETCH_HEAD"])
      : null;
    if (actual === null || !actual.ok || actual.stdout.trim() !== head) {
      return portError("conflict", "CI ledger moved");
    }
    const tree = await this.git(op, ["ls-tree", "-r", head]);
    if (!tree.ok) return portError("unavailable", "CI ledger tree");
    const rows = tree.stdout.split("\n").filter(Boolean);
    if (rows.length > 120) {
      return portError("invalid", "CI ledger history bound");
    }
    const ledgers = new Map<string, CiMinuteLedgerV1>();
    for (const row of rows) {
      const match = TREE.exec(row);
      if (match === null) return portError("invalid", "CI ledger path");
      const size = await this.git(op, ["cat-file", "-s", match[1]]);
      if (
        !size.ok || !/^\d+\s*$/.test(size.stdout) ||
        Number(size.stdout) > CI_MINUTE_MAX_BYTES
      ) {
        return portError("invalid", "CI ledger size");
      }
      const blob = await this.git(op, ["cat-file", "blob", match[1]]);
      if (!blob.ok) return portError("unavailable", "CI ledger blob");
      try {
        const ledger = parseCiMinuteLedger(JSON.parse(blob.stdout));
        if (ledger.month !== match[3]) throw new Error("CI month mismatch");
        ledgers.set(match[3], ledger);
      } catch {
        return portError("invalid", "CI ledger validation");
      }
    }
    return portOk(ledgers);
  }

  read(month: string): ReturnType<CiMinuteStoreV1["read"]> {
    return this.readMonth(month, false);
  }

  readPrior(month: string): ReturnType<CiMinuteStoreV1["readPrior"]> {
    return this.readMonth(month, true);
  }

  private readMonth(
    month: string,
    prior: boolean,
  ): ReturnType<CiMinuteStoreV1["read"]> {
    if (!MONTH.test(month)) {
      return Promise.resolve(portError("invalid", "CI month"));
    }
    return this.withOpDir<ReadValue>(async (op) => {
      if (!await this.initialize(op)) {
        return portError("unavailable", "CI scratch initialization");
      }
      const found = await this.lookup(op);
      if (!found.ok) return found;
      if (found.value === null) return portOk({ head: null, ledger: null });
      const loaded = await this.load(op, found.value);
      if (!loaded.ok) return loaded;
      const selected = prior
        ? [...loaded.value.keys()].filter((key) => key < month).sort().at(-1)
        : month;
      return portOk({
        head: found.value,
        ledger: selected === undefined
          ? null
          : loaded.value.get(selected) ?? null,
      });
    });
  }

  write(
    input: Parameters<CiMinuteStoreV1["write"]>[0],
  ): ReturnType<CiMinuteStoreV1["write"]> {
    let ledger: CiMinuteLedgerV1;
    try {
      if (input.expectedHead !== null && !SHA.test(input.expectedHead)) {
        throw new Error("CI head");
      }
      ledger = parseCiMinuteLedger(input.ledger);
    } catch {
      return Promise.resolve(
        portError("invalid", "CI ledger write validation"),
      );
    }
    return this.withOpDir<WriteValue>(async (op) => {
      if (!await this.initialize(op)) {
        return portError("unavailable", "CI scratch initialization");
      }
      const found = await this.lookup(op);
      if (!found.ok) return found;
      if (found.value !== input.expectedHead) {
        return portOk({ status: "conflict", head: found.value });
      }
      let ledgers = new Map<string, CiMinuteLedgerV1>();
      if (found.value !== null) {
        const loaded = await this.load(op, found.value);
        if (!loaded.ok) return loaded;
        ledgers = loaded.value;
      }
      const prior = ledgers.get(ledger.month);
      try {
        if (prior !== undefined) validateCiMinuteTransition(prior, ledger);
      } catch {
        return portError("invalid", "CI ledger monotonic transition");
      }
      ledgers.set(ledger.month, ledger);
      if (ledgers.size > 120) {
        return portError("invalid", "CI ledger history bound");
      }
      await Deno.mkdir(`${op.directory}/ci-minutes/ubiquity`, {
        recursive: true,
      });
      const paths: string[] = [];
      for (const [month, body] of ledgers) {
        const path = `ci-minutes/ubiquity/${month}.json`;
        await Deno.writeTextFile(
          `${op.directory}/${path}`,
          canonicalStringify(body) + "\n",
        );
        paths.push(path);
      }
      if (!(await this.git(op, ["add", "--", ...paths])).ok) {
        return portError("unavailable", "CI ledger staging");
      }
      const tree = await this.git(op, ["write-tree"]);
      if (!tree.ok || !SHA.test(tree.stdout.trim())) {
        return portError("unavailable", "CI ledger tree");
      }
      const commit = await this.git(op, [
        "commit-tree",
        tree.stdout.trim(),
        ...(input.expectedHead === null ? [] : ["-p", input.expectedHead]),
        "-m",
        `sentinel CI accounting\n\nnonce: ${randomHex(32)}`,
      ], {
        GIT_AUTHOR_NAME: "github-actions[bot]",
        GIT_COMMITTER_NAME: "github-actions[bot]",
        GIT_AUTHOR_EMAIL:
          "41898282+github-actions[bot]@users.noreply.github.com",
        GIT_COMMITTER_EMAIL:
          "41898282+github-actions[bot]@users.noreply.github.com",
      });
      if (!commit.ok || !SHA.test(commit.stdout.trim())) {
        return portError("unavailable", "CI ledger commit");
      }
      const candidate = commit.stdout.trim() as GitSha;
      const fresh = await this.lookup(op);
      if (!fresh.ok) return fresh;
      if (fresh.value !== input.expectedHead) {
        return portOk({ status: "conflict", head: fresh.value });
      }
      const push = await this.git(op, [
        "push",
        "origin",
        `${candidate}:${CI_MINUTE_REF}`,
      ]);
      const after = await this.lookup(op);
      if (!after.ok) return portOk({ status: "ambiguous", head: null });
      if (after.value === candidate) {
        return portOk({ status: "applied", head: candidate });
      }
      return portOk({
        status: !push.ok && after.value !== input.expectedHead
          ? "conflict"
          : "ambiguous",
        head: after.value,
      });
    });
  }
}
