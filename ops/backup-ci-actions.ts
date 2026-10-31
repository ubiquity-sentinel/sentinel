/**
 * Action resolution of the v1 shape (docs/backup-ci-spec.md §5, steps).
 *
 * Every `uses:` of a planned step is resolved before a unit is planned: the
 * action's `action.yml` (or `action.yaml`) at its ref, read anonymously from
 * `raw.githubusercontent.com` for a remote action and from the target tree
 * at the commit for a local one, and cached per pass. `runs.using` must be
 * `node20`, `node24` or `composite` (Docker is `docker_action`; anything else
 * or an unreadable action is `action_unresolved`). Composite actions are
 * resolved recursively to depth 3, at most 20 distinct actions in total; a
 * composite step's `./` action is relative to the target workspace.
 */
import {
  BACKUP_CI_MAX_FILE_BYTES,
  type BackupCiUnsupportedV1,
} from "../src/contracts/backup-ci.ts";
import { parseBoundedYaml } from "./backup-ci-workflow-map.ts";
import { readBoundedBody } from "./backup-ci-materialize.ts";

export const BACKUP_CI_MAX_ACTION_DEPTH = 3;
export const BACKUP_CI_MAX_ACTIONS = 20;
const RAW_TIMEOUT_MS = 15_000;
const REMOTE_RE =
  /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})((?:\/[A-Za-z0-9._/-]{1,200})?)@([A-Za-z0-9._/-]{1,128})$/;
const LOCAL_RE = /^\.\/[A-Za-z0-9._/-]{0,254}$/;

/** Where action metadata comes from; null for an absent or unreadable file. */
export interface BackupCiActionSourceV1 {
  remote(
    owner: string,
    repo: string,
    ref: string,
    file: string,
  ): Promise<Uint8Array | null>;
  /** A regular file of the target tree at the planned commit. */
  local(path: string): Promise<Uint8Array | null>;
}

type Verdict = BackupCiUnsupportedV1 | null;
type Metadata = { using: string; nested: string[] } | BackupCiUnsupportedV1;

/** Per-pass cache of resolved remote actions (local ones are per commit). */
export type BackupCiActionCacheV1 = Map<string, Metadata>;

function actionFiles(dir: string): string[] {
  const base = dir.replace(/^\/+|\/+$/g, "");
  return base.length === 0
    ? ["action.yml", "action.yaml"]
    : [`${base}/action.yml`, `${base}/action.yaml`];
}

function metadata(bytes: Uint8Array): Metadata {
  const doc = parseBoundedYaml(bytes, BACKUP_CI_MAX_FILE_BYTES, 20_000);
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return "action_unresolved";
  }
  const runs = (doc as Record<string, unknown>).runs;
  if (typeof runs !== "object" || runs === null || Array.isArray(runs)) {
    return "action_unresolved";
  }
  const r = runs as Record<string, unknown>;
  const using = typeof r.using === "string" ? r.using.toLowerCase() : "";
  if (using === "docker") return "docker_action";
  if (using === "node20" || using === "node24") return { using, nested: [] };
  if (using !== "composite" || !Array.isArray(r.steps)) {
    return "action_unresolved";
  }
  const nested: string[] = [];
  for (const step of r.steps) {
    if (typeof step !== "object" || step === null || Array.isArray(step)) {
      return "action_unresolved";
    }
    const uses = (step as Record<string, unknown>).uses;
    if (uses === undefined) continue;
    if (typeof uses !== "string") return "action_unresolved";
    if (uses.startsWith("docker://")) return "docker_action";
    if (uses.includes("${{")) return "action_unresolved";
    nested.push(uses);
  }
  return { using, nested };
}

async function readMetadata(
  uses: string,
  source: BackupCiActionSourceV1,
): Promise<Metadata> {
  let read: (file: string) => Promise<Uint8Array | null>;
  let files: string[];
  if (uses.startsWith("./")) {
    if (!LOCAL_RE.test(uses) || uses.split("/").includes("..")) {
      return "action_unresolved";
    }
    files = actionFiles(uses.slice(2));
    read = (file) => source.local(file);
  } else {
    const match = REMOTE_RE.exec(uses);
    if (match === null || match[3].split("/").includes("..")) {
      return "action_unresolved";
    }
    const [, owner, repo, dir, ref] = match;
    files = actionFiles(dir);
    read = (file) => source.remote(owner, repo, ref, file);
  }
  for (const file of files) {
    let bytes: Uint8Array | null = null;
    try {
      bytes = await read(file);
    } catch {
      bytes = null;
    }
    if (bytes !== null) return metadata(bytes);
  }
  return "action_unresolved";
}

/**
 * Resolves the planned steps' actions; null when every one is supported,
 * else the first refusal. `cache` holds remote verdicts across a pass.
 */
export async function resolveBackupCiActions(
  uses: { remote: readonly string[]; local: readonly string[] },
  source: BackupCiActionSourceV1,
  cache: BackupCiActionCacheV1 = new Map(),
): Promise<Verdict> {
  const visited = new Set<string>();
  let queue: string[] = [...uses.local, ...uses.remote];
  for (let depth = 1; queue.length > 0; depth++) {
    if (depth > BACKUP_CI_MAX_ACTION_DEPTH) return "action_unresolved";
    const next: string[] = [];
    for (const action of queue) {
      if (visited.has(action)) continue;
      visited.add(action);
      if (visited.size > BACKUP_CI_MAX_ACTIONS) return "action_unresolved";
      const local = action.startsWith("./");
      let meta = local ? undefined : cache.get(action);
      if (meta === undefined) {
        meta = await readMetadata(action, source);
        if (!local) cache.set(action, meta);
      }
      if (typeof meta === "string") return meta;
      next.push(...meta.nested);
    }
    queue = next;
  }
  return null;
}

/** Anonymous `raw.githubusercontent.com` reads, bounded and time-limited. */
export function rawGithubActionSource(
  local: BackupCiActionSourceV1["local"],
  fetcher: typeof fetch = fetch,
): BackupCiActionSourceV1 {
  return {
    local,
    async remote(owner, repo, ref, file) {
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/${
        ref.split("/").map(encodeURIComponent).join("/")
      }/${file}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RAW_TIMEOUT_MS);
      try {
        const response = await fetcher(url, {
          redirect: "error",
          signal: controller.signal,
          headers: { "user-agent": "sentinel-backup-ci" },
        });
        if (response.status !== 200) {
          await response.body?.cancel();
          return null;
        }
        return await readBoundedBody(response, BACKUP_CI_MAX_FILE_BYTES);
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
