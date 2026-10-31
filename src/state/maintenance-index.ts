import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import {
  type CurrentMatrixIndexPortV1,
  MAINTENANCE_INDEX_PATH,
  MAINTENANCE_INDEX_REF,
  parseCurrentMatrixIndexV1,
} from "../contracts/maintenance-index.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import {
  type GitStateStoreOptions,
  type OpContext,
  randomHex,
  StateGitTransport,
} from "./state-git.ts";

type Value<T> = T extends { ok: true; value: infer V } ? V : never;

/** Trusted maintenance-only sidecar; never writes repair/release snapshots. */
export class GitMaintenanceIndex extends StateGitTransport
  implements CurrentMatrixIndexPortV1 {
  constructor(options: Omit<GitStateStoreOptions, "role">) {
    super({ ...options, role: "repair" });
  }

  private async lookup(op: OpContext) {
    const result = await this.git(op, [
      "ls-remote",
      "origin",
      MAINTENANCE_INDEX_REF,
    ]);
    if (!result.ok) {
      return portError("unavailable", "maintenance index lookup failed");
    }
    const parsed = this.parseLsRemote(result.stdout, MAINTENANCE_INDEX_REF);
    if (parsed.status === "invalid") {
      return portError("invalid", "maintenance index ref is malformed");
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
        return portError(
          "unavailable",
          "maintenance index initialization failed",
        );
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
      MAINTENANCE_INDEX_REF,
    ]);
    const actual = fetched.ok &&
      await this.git(op, ["rev-parse", "FETCH_HEAD"]);
    if (!actual || !actual.ok || actual.stdout.trim() !== head) {
      return portError("conflict", "maintenance index changed during fetch");
    }
    return portOk(null);
  }

  read(): ReturnType<CurrentMatrixIndexPortV1["read"]> {
    return this.withOpDir<
      Value<Awaited<ReturnType<CurrentMatrixIndexPortV1["read"]>>>
    >(async (op) => {
      const ready = await this.initialize(op);
      if (!ready.ok) return ready;
      const found = await this.lookup(op);
      if (!found.ok) return found;
      if (found.value === null) return portOk({ head: null, index: null });
      const fetched = await this.fetch(op, found.value);
      if (!fetched.ok) return fetched;
      const tree = await this.git(op, ["ls-tree", "-r", found.value]);
      if (
        !tree.ok || !new RegExp(
          `^100644 blob [0-9a-f]{40}\\t${
            MAINTENANCE_INDEX_PATH.replaceAll(".", "\\.")
          }\\n$`,
        ).test(tree.stdout)
      ) {
        return portError("invalid", "maintenance index tree is malformed");
      }
      const body = await this.git(op, [
        "show",
        `${found.value}:${MAINTENANCE_INDEX_PATH}`,
      ]);
      if (!body.ok) {
        return portError("unavailable", "maintenance index blob unavailable");
      }
      try {
        const index = parseCurrentMatrixIndexV1(JSON.parse(body.stdout));
        if (body.stdout !== `${canonicalStringify(index)}\n`) {
          return portError(
            "invalid",
            "maintenance index is not canonical JSON",
          );
        }
        const fresh = await this.lookup(op);
        if (!fresh.ok) return fresh;
        if (fresh.value !== found.value) {
          return portError("conflict", "maintenance index changed during read");
        }
        return portOk({ head: found.value, index });
      } catch {
        return portError(
          "invalid",
          "maintenance index failed contract validation",
        );
      }
    });
  }

  write(
    input: Parameters<CurrentMatrixIndexPortV1["write"]>[0],
  ): ReturnType<CurrentMatrixIndexPortV1["write"]> {
    let text: string;
    try {
      text = `${canonicalStringify(parseCurrentMatrixIndexV1(input.index))}\n`;
      if (
        input.expectedHead !== null &&
        !/^[0-9a-f]{40}$/.test(input.expectedHead)
      ) {
        throw new Error("invalid head");
      }
    } catch {
      return Promise.resolve(
        portError("invalid", "maintenance index write is malformed"),
      );
    }
    return this.withOpDir<
      Value<Awaited<ReturnType<CurrentMatrixIndexPortV1["write"]>>>
    >(async (op) => {
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
      await Deno.writeTextFile(
        `${op.directory}/${MAINTENANCE_INDEX_PATH}`,
        text,
      );
      if (!(await this.git(op, ["add", "--", MAINTENANCE_INDEX_PATH])).ok) {
        return portError("unavailable", "maintenance index staging failed");
      }
      const tree = await this.git(op, ["write-tree"]);
      if (!tree.ok || !/^[0-9a-f]{40}$/.test(tree.stdout.trim())) {
        return portError("unavailable", "maintenance index tree unavailable");
      }
      const identity = {
        GIT_AUTHOR_NAME: "github-actions[bot]",
        GIT_AUTHOR_EMAIL:
          "41898282+github-actions[bot]@users.noreply.github.com",
        GIT_COMMITTER_NAME: "github-actions[bot]",
        GIT_COMMITTER_EMAIL:
          "41898282+github-actions[bot]@users.noreply.github.com",
      };
      const commit = await this.git(op, [
        "commit-tree",
        tree.stdout.trim(),
        ...(input.expectedHead === null ? [] : ["-p", input.expectedHead]),
        "-m",
        `sentinel maintenance discovery\n\nnonce: ${randomHex(32)}`,
      ], identity);
      if (!commit.ok || !/^[0-9a-f]{40}$/.test(commit.stdout.trim())) {
        return portError("unavailable", "maintenance index commit unavailable");
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
        `${candidate}:${MAINTENANCE_INDEX_REF}`,
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
