/** Fixed, credential-free dependency preparation before Passport model execution. */
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import { portError, portOk, type PortResultV1 } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { DenoReplayRuntime, type ReplayRuntimeV1 } from "../replay/runtime.ts";
import { runTrustedGitResult } from "./local-git.ts";
import {
  fileDigest,
  realDirectory,
  textDigest,
} from "./self-dependency-files.ts";
import { isPassportTarget } from "./target-policy.ts";

export const PASSPORT_DEPENDENCY_REFUSAL =
  "Passport checkout dependencies unavailable";
const INPUTS = ["package.json", "bun.lock"] as const;
const PRIVATE = [
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".bunfig.toml",
  "bunfig.toml",
  ".netrc",
];
const PATH = "/usr/local/bin:/usr/bin:/bin";
const MAX_BYTES = 1024 * 1024 * 1024;
interface Entry {
  path: string;
  digest: string;
  executable: boolean;
  link: string | null;
}

export interface PassportDependenciesInputV1 {
  repository: RepositoryIdentityV1;
  checkout: string;
  sourcePath: string;
  base: GitSha;
}
export type PreparePassportDependenciesV1 = (
  input: PassportDependenciesInputV1,
) => Promise<PortResultV1<void>>;

function refuse(): never {
  throw new Error(PASSPORT_DEPENDENCY_REFUSAL);
}

/** Host-owned capability; no package-manager or command options come from a model. */
export function createPassportDependencyPreparer(options: {
  scratch: string;
  trustedPath: string;
  /** Test port only; production uses the bounded owned-process runtime. */
  runtime?: ReplayRuntimeV1;
}): PreparePassportDependenciesV1 {
  const scratch = options.scratch;
  const trustedPath = options.trustedPath;
  const runtime = options.runtime ?? new DenoReplayRuntime(PATH);
  return async (input) => {
    if (!isPassportTarget(input.repository)) return portOk(undefined);
    let stage: string | null = null;
    let settled = true;
    try {
      if (!isGitSha(input.base)) refuse();
      await realDirectory(scratch);
      await realDirectory(input.checkout);
      await realDirectory(input.sourcePath);
      if (
        scratch === input.checkout || scratch.startsWith(`${input.checkout}/`)
      ) refuse();
      await rejectConfiguration(input.checkout);
      try {
        await Deno.lstat(`${input.checkout}/node_modules`);
        await tree(`${input.checkout}/node_modules`);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      const contents = new Map<string, string>();
      for (const path of INPUTS) {
        const source = await runTrustedGitResult({
          cwd: input.sourcePath,
          trustedPath,
          scratch,
          args: ["show", `${input.base}:${path}`],
        });
        if (source.code !== 0) refuse();
        if (
          (await fileDigest(`${input.checkout}/${path}`)).sha256 !==
            textDigest(source.stdout)
        ) refuse();
        contents.set(path, source.stdout);
      }
      const pkg = JSON.parse(contents.get("package.json")!);
      if (pkg.packageManager !== "bun@1.4.0" || pkg.engines?.bun !== "1.4.0") {
        refuse();
      }
      stage = await Deno.makeTempDir({
        dir: scratch,
        prefix: "passport-dependencies-",
      });
      const home = `${stage}/home`;
      const graph = `${stage}/graph`;
      await Deno.mkdir(home, { mode: 0o700 });
      await Deno.mkdir(graph, { mode: 0o700 });
      for (const [path, text] of contents) {
        await Deno.writeTextFile(`${graph}/${path}`, text, {
          createNew: true,
          mode: 0o600,
        });
      }
      const env = {
        PATH,
        HOME: home,
        TMPDIR: stage,
        BUN_INSTALL_CACHE_DIR: `${stage}/cache`,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        NODE_V8_COVERAGE: "",
      };
      for (
        const args of [["--version"], [
          "--no-env-file",
          "install",
          "--frozen-lockfile",
          "--ignore-scripts",
          "--backend=copyfile",
        ]]
      ) {
        const result = await runtime.run({
          executable: "/usr/local/bin/bun",
          args,
          cwd: graph,
          env,
          maxDurationMs: 280_000,
          maxOutputBytes: 1_048_576,
        });
        settled = result.settled;
        if (
          !settled || result.outcome !== "exited" || result.exitCode !== 0 ||
          result.truncated
        ) refuse();
        if (
          args[0] === "--version" &&
          new TextDecoder().decode(result.stdout).trim() !== "1.4.0"
        ) refuse();
      }
      for (const [path, text] of contents) {
        if (
          (await fileDigest(`${graph}/${path}`)).sha256 !== textDigest(text) ||
          (await fileDigest(`${input.checkout}/${path}`)).sha256 !==
            textDigest(text)
        ) refuse();
      }
      await rejectConfiguration(input.checkout);
      const source = `${graph}/node_modules`;
      const entries = await tree(source);
      const destination = `${input.checkout}/node_modules`;
      let present = false;
      try {
        await Deno.lstat(destination);
        present = true;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      if (present) {
        if (
          JSON.stringify(await tree(destination)) !== JSON.stringify(entries)
        ) refuse();
      } else {
        await copyTree(source, input.checkout, entries);
      }
      for (const [path, text] of contents) {
        if (
          (await fileDigest(`${input.checkout}/${path}`)).sha256 !==
            textDigest(text)
        ) refuse();
      }
      return portOk(undefined);
    } catch {
      return portError("unavailable", PASSPORT_DEPENDENCY_REFUSAL);
    } finally {
      // Uncertain descendants retain their exact private scratch for diagnosis.
      if (stage !== null && settled) {
        await Deno.remove(stage, { recursive: true }).catch(() => {});
      }
    }
  };
}

async function rejectConfiguration(root: string): Promise<void> {
  for await (const item of Deno.readDir(root)) {
    if (
      item.name === ".env" || item.name.startsWith(".env.") ||
      PRIVATE.includes(item.name)
    ) refuse();
  }
}

async function tree(root: string): Promise<Entry[]> {
  await realDirectory(root);
  const entries: Entry[] = [];
  let bytes = 0;
  let count = 0;
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (depth > 32) refuse();
    for await (const item of Deno.readDir(`${root}/${relative}`)) {
      if (
        ++count > 100_000 || item.name === "." || item.name === ".." ||
        item.name.includes("\\") || Array.from(item.name).some((character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        )
      ) {
        refuse();
      }
      const path = relative ? `${relative}/${item.name}` : item.name;
      const absolute = `${root}/${path}`;
      const info = await Deno.lstat(absolute);
      if (info.isDirectory) {
        await visit(path, depth + 1);
      } else if (info.isSymlink) {
        const link = await Deno.readLink(absolute);
        const target = await Deno.realPath(absolute);
        if (
          link.startsWith("/") || !target.startsWith(`${root}/`) ||
          !(await Deno.stat(target)).isFile
        ) {
          refuse();
        }
        entries.push({
          path,
          digest: textDigest(link),
          executable: false,
          link,
        });
      } else if (info.isFile && info.nlink === 1) {
        bytes += info.size;
        if (bytes > MAX_BYTES || info.size > 256 * 1024 * 1024) {
          refuse();
        }
        entries.push({
          path,
          digest: (await fileDigest(absolute, 256 * 1024 * 1024)).sha256,
          executable: ((info.mode ?? 0) & 0o111) !== 0,
          link: null,
        });
      } else refuse();
    }
  };
  await visit("", 0);
  if (entries.length === 0) refuse();
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

async function copyTree(
  source: string,
  checkout: string,
  entries: Entry[],
): Promise<void> {
  const stage = await Deno.makeTempDir({
    dir: checkout,
    prefix: ".passport-dependencies-",
  });
  try {
    for (const entry of entries) {
      const path = `${stage}/${entry.path}`;
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
        recursive: true,
        mode: 0o700,
      });
      if (entry.link !== null) continue;
      const bytes = await Deno.readFile(`${source}/${entry.path}`);
      if (await digest(bytes) !== entry.digest) refuse();
      await Deno.writeFile(path, bytes, {
        createNew: true,
        mode: entry.executable ? 0o700 : 0o600,
      });
    }
    for (const entry of entries) {
      if (entry.link !== null) {
        // The fixed filesystem utility also works under Deno's scoped read
        // grants, which cannot authorize Deno.symlink on current runtimes.
        const linked = await new DenoReplayRuntime(PATH).run({
          executable: "/bin/ln",
          args: ["-s", "--", entry.link, `${stage}/${entry.path}`],
          cwd: stage,
          env: { PATH, NODE_V8_COVERAGE: "" },
          maxDurationMs: 5_000,
          maxOutputBytes: 4096,
        });
        if (
          !linked.settled || linked.outcome !== "exited" ||
          linked.exitCode !== 0 || linked.truncated
        ) refuse();
      }
    }
    if (JSON.stringify(await tree(stage)) !== JSON.stringify(entries)) refuse();
    await realDirectory(checkout);
    try {
      await Deno.lstat(`${checkout}/node_modules`);
      refuse();
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await Deno.rename(stage, `${checkout}/node_modules`);
  } finally {
    await Deno.remove(stage, { recursive: true }).catch(() => {});
  }
}

async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer)),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
}
