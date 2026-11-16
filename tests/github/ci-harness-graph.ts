/**
 * The CI harness as a module graph, for the self merge pin guard in
 * `self-merge-ops_test.ts`. Entry scripts are what `.github/workflows/ci.yml`
 * runs (`deno run`, with `deno task` names resolved through `deno.json`) and
 * the scripts those spawn. Their closure follows every code edge that
 * `deno info --json` reports (`../` and either quote style, JSON, side-effect
 * and statically analysable dynamic imports) and skips type-only edges. A
 * literal scan adds the files the workflow or the harness names by path. An
 * edge the guard cannot follow is a problem, never a silent pass.
 */
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const CI_WORKFLOW = ".github/workflows/ci.yml";

export interface CiHarnessV1 {
  /** Scripts ci.yml runs and the scripts those spawn. */
  entries: string[];
  /** Every local file an entry reaches by code edges, entries included. */
  closure: string[];
  /** Local files the closure reaches only by type edges (not followed). */
  typeOnly: string[];
  /** Other local files ci.yml or harness code names by path. */
  named: string[];
  /** Non-local code specifiers (`node:`, `jsr:`, `npm:`, remote URLs). */
  external: string[];
  /** Edges the guard cannot follow; any one fails it. */
  problems: string[];
}

const CODE = /\.[cm]?[jt]sx?$/;
/** Code CI checks and tests, which the harness names as toolchain operands. */
const TESTED = /^(?:src|tests)\//;
/** Subcommands that check the paths they name and run no script themselves. */
const CHECKS = new Set(["fmt", "lint", "check"]);
const SPECIFIER =
  /\b(?:from|import)\s+(?:"[^"\n]*"|'[^'\n]*')|\bimport\s*\(\s*(?:"[^"\n]*"|'[^'\n]*'|`[^`\n]*`)/g;
const LITERAL =
  /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\\n]|\\.)*)`/g;
const OPS_MENTION = /\bops\/[A-Za-z0-9_.-]+/g;
const PATH_LIKE = /^[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*$/;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*/g;
const STATIC_SPECIFIER = /^(?:"[^"\n]*"|'[^'\n]*'|`[^`$\n]*`)\s*[,)]/;

interface Named {
  path: string;
  /** Named relative to the naming module rather than the working tree. */
  relative: boolean;
  /** Named by harness code, which may load or spawn a module it names. */
  loads: boolean;
}
interface Scan {
  run: string[];
  named: Named[];
  problems: string[];
}

interface DenoInfoEdgeV1 {
  specifier?: string;
  error?: string;
}
interface DenoInfoV1 {
  version: number;
  roots: string[];
  modules: {
    specifier: string;
    error?: string;
    dependencies?: {
      specifier: string;
      code?: DenoInfoEdgeV1;
      type?: DenoInfoEdgeV1;
    }[];
  }[];
  redirects?: Record<string, string>;
}

/** `deno run` scripts and named paths in shell text (ci.yml, deno.json tasks). */
function scanShell(
  text: string,
  tasks: Readonly<Record<string, string>>,
  scan: Scan,
  depth = 0,
): void {
  for (const [path] of text.matchAll(OPS_MENTION)) {
    scan.named.push({ path, relative: false, loads: false });
  }
  for (const line of text.replace(/\\\n/g, " ").split("\n")) {
    const commands = line.replace(/(?:^|\s)#.*$/, "").split(/&&|\|\||[;|]/);
    for (const command of commands) {
      const words = command.trim().split(/\s+/).map((word) =>
        word.replace(/^(["'])(.*)\1$/, "$2")
      );
      for (const word of words) {
        if (PATH_LIKE.test(word) && /[/.]/.test(word)) {
          scan.named.push({
            path: normalize(word),
            relative: false,
            loads: false,
          });
        }
      }
      const at = words.findIndex((w) => w === "deno" || w.endsWith("/deno"));
      const [sub, ...rest] = at < 0 ? [] : words.slice(at + 1);
      if (sub === undefined || CHECKS.has(sub)) continue;
      if (sub === "task") {
        const name = rest.find((word) => !word.startsWith("-"));
        if (name === undefined || !Object.hasOwn(tasks, name) || depth > 8) {
          scan.problems.push(`deno task not in deno.json: ${command.trim()}`);
        } else scanShell(tasks[name], tasks, scan, depth + 1);
      } else if (sub === "run") {
        const script = rest.find((w) => !w.startsWith("-") && CODE.test(w));
        if (script === undefined || /^[a-z]+:/.test(script)) {
          scan.problems.push(`deno run of no local script: ${command.trim()}`);
        } else scan.run.push(normalize(script));
      } else scan.problems.push(`unrecognised deno command: ${command.trim()}`);
    }
  }
}

/** Spawned `deno run` scripts and paths named by string in harness code. */
function scanCode(path: string, text: string): Scan {
  const scan: Scan = { run: [], named: [], problems: [] };
  for (const call of text.matchAll(DYNAMIC_IMPORT)) {
    const argument = text.slice((call.index ?? 0) + call[0].length);
    if (!STATIC_SPECIFIER.test(argument)) {
      scan.problems.push(`${path}: dynamic import of a computed specifier`);
    }
  }
  // Import specifiers are deno info's (type or code edge), not path reads.
  const body = text.replace(SPECIFIER, "");
  for (const [mention] of body.matchAll(OPS_MENTION)) {
    scan.named.push({ path: mention, relative: false, loads: true });
  }
  const words = [...body.matchAll(LITERAL)].map((m) => m[1] ?? m[2] ?? m[3]);
  words.forEach((word, index) => {
    if (PATH_LIKE.test(word) && /[/.]/.test(word)) {
      const relative = /^\.{1,2}\//.test(word);
      const named = relative ? join(dirname(path), word) : word;
      scan.named.push({ path: normalize(named), relative, loads: true });
    }
    if (word !== "run") return;
    const script = words.slice(index + 1).find((next) => !next.startsWith("-"));
    if (script === undefined || !CODE.test(script)) return;
    if (script.includes("${")) {
      scan.problems.push(`${path}: spawns a computed script ${script}`);
    } else scan.run.push(normalize(script));
  });
  return scan;
}

async function isFile(root: string, path: string): Promise<boolean> {
  if (path === ".." || path.startsWith("../") || isAbsolute(path)) {
    return false;
  }
  try {
    return (await Deno.stat(join(root, path))).isFile;
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.NotADirectory
    ) return false;
    throw error;
  }
}

/**
 * The code-edge closure of one module as `deno info --json` reports it, with
 * the repository's own `deno.json` and `deno.lock`, never fetching or writing:
 * remote, jsr and npm modules end the walk as `external`.
 */
export async function codeGraph(root: string, entry: string): Promise<{
  local: string[];
  typeOnly: string[];
  external: string[];
  problems: string[];
}> {
  root = await Deno.realPath(root);
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", "--frozen", "--no-remote", "--no-npm", entry],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(60_000),
  }).output();
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  if (!output.success) {
    throw new Error(`deno info ${entry} failed: ${decode(output.stderr)}`);
  }
  const info = JSON.parse(decode(output.stdout)) as DenoInfoV1;
  if (info.version !== 1) throw new Error(`deno info version ${info.version}`);
  const modules = new Map(info.modules.map((m) => [m.specifier, m]));
  const local = new Set<string>(), typeOnly = new Set<string>();
  const external = new Set<string>(), problems: string[] = [];
  const inRoot = (specifier: string) => {
    const path = relative(root, fileURLToPath(specifier));
    return path === ".." || path.startsWith("../") || isAbsolute(path)
      ? null
      : path;
  };
  const seen = new Set<string>();
  const pending = [...info.roots];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const specifier = info.redirects?.[next] ?? next;
    if (seen.has(specifier)) continue;
    seen.add(specifier);
    if (!specifier.startsWith("file:")) {
      external.add(specifier);
      continue;
    }
    const path = inRoot(specifier);
    const module = modules.get(specifier);
    if (path === null || module === undefined || module.error !== undefined) {
      problems.push(`${entry}: ${specifier}: ${module?.error ?? "unreadable"}`);
      continue;
    }
    local.add(path);
    for (const edge of module.dependencies ?? []) {
      if (edge.code === undefined) {
        const target = edge.type?.specifier;
        const typed = target?.startsWith("file:") ? inRoot(target) : null;
        if (typed !== null) typeOnly.add(typed);
      } else if (
        edge.code.specifier === undefined || edge.code.error !== undefined
      ) {
        problems.push(`${path}: ${edge.specifier}: ${edge.code.error}`);
      } else pending.push(edge.code.specifier);
    }
  }
  return {
    local: [...local].sort(),
    typeOnly: [...typeOnly].filter((path) => !local.has(path)).sort(),
    external: [...external].sort(),
    problems,
  };
}

/** The CI harness of the working tree at `root`, from ci.yml and deno.json. */
export async function ciHarness(root: string): Promise<CiHarnessV1> {
  root = await Deno.realPath(root);
  const config = JSON.parse(await Deno.readTextFile(join(root, "deno.json")));
  const tasks: Record<string, string> = config.tasks ?? {};
  const entries = new Set<string>(), closure = new Set<string>();
  const typeOnly = new Set<string>(), external = new Set<string>();
  const named = new Set<string>([CI_WORKFLOW]), problems: string[] = [];
  const queue: string[] = [];
  const enter = async (path: string) => {
    if (entries.has(path)) return;
    if (!await isFile(root, path)) {
      problems.push(`spawned script not found: ${path}`);
    } else {
      entries.add(path);
      queue.push(path);
    }
  };
  const absorb = async (scan: Scan) => {
    problems.push(...scan.problems);
    for (const path of scan.run) await enter(path);
    for (const { path, relative, loads } of scan.named) {
      if (!await isFile(root, path)) continue;
      // `deno check src/...` and `deno test tests/` name the code under test.
      if (!relative && CODE.test(path) && TESTED.test(path)) continue;
      if (loads && CODE.test(path)) await enter(path);
      else named.add(path);
    }
  };
  const workflow: Scan = { run: [], named: [], problems: [] };
  scanShell(await Deno.readTextFile(join(root, CI_WORKFLOW)), tasks, workflow);
  await absorb(workflow);
  const scanned = new Set<string>();
  for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
    const graph = await codeGraph(root, entry);
    problems.push(...graph.problems);
    for (const specifier of graph.external) external.add(specifier);
    for (const path of graph.typeOnly) typeOnly.add(path);
    for (const path of graph.local) {
      closure.add(path);
      if (!CODE.test(path) || scanned.has(path)) continue;
      scanned.add(path);
      await absorb(scanCode(path, await Deno.readTextFile(join(root, path))));
    }
  }
  const outside = (paths: Set<string>) =>
    [...paths].filter((path) => !closure.has(path)).sort();
  return {
    entries: [...entries].sort(),
    closure: [...closure].sort(),
    typeOnly: outside(typeOnly),
    named: outside(named),
    external: [...external].sort(),
    problems,
  };
}

/** Whether a non-local specifier is a Deno builtin or pinned by deno.lock. */
export function lockPins(
  lock: {
    specifiers?: Record<string, string>;
    remote?: Record<string, string>;
  },
  specifier: string,
): boolean {
  if (specifier.startsWith("node:")) return true;
  if (/^https?:/.test(specifier)) {
    return Object.hasOwn(lock.remote ?? {}, specifier);
  }
  return Object.keys(lock.specifiers ?? {}).some((key) =>
    specifier === key || specifier.startsWith(`${key}/`)
  );
}
