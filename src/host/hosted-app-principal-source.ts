/** Exact reviewed launcher code and data, read without executing foreign source. */
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import type { ReplayRuntimeV1 } from "../replay/runtime.ts";
import { parseTargetSlugsV1 } from "./targets.ts";
import {
  readCleanGitHead,
  resolveRuntimeDirectories,
} from "./hosted-runtime-child.ts";
import type { HostedRuntimeIdentityV1 } from "./hosted-runtime-identity.ts";
import type { HostedAppJobSteps } from "./hosted-app-principal-native.ts";

export const HOSTED_APP_CAPABILITY_DATA =
  "src/host/hosted-custody-capability.json";
export const HOSTED_APP_SOURCE_PROFILES =
  "src/host/hosted-app-source-profiles.json";
export const HOSTED_RUNTIME_ROLLOUT_DATA =
  "src/host/hosted-runtime-rollout.json";
const workflow = ".github/workflows/supervisor.yml";
const targets = "sentinel.targets.json";
const digestPattern = /^[0-9a-f]{64}$/;
const maximumFileBytes = 1024 * 1024;
const maximumTreeBytes = 64 * 1024 * 1024;
const appClientId = "Iv23liHUJNXds9mU3j7Q";
// These names belong to the trusted workflow consumer, never source data or env.
const installedJobSteps = {
  repair: {
    dependencyStep: "Install locked self-test dependencies",
    mintStep: "Mint the scoped sentinel App token",
    runtimeStep: "Run selected Sentinel runtime",
  },
  matrix_plan: {
    dependencyStep: "Install locked self-test dependencies",
    mintStep: "Mint the scoped sentinel App token",
    runtimeStep: "Plan isolated issue matrix",
  },
};

/** Trusted runtime-owned reviewed profile; never accepted from environment. */
export interface HostedAppSourceProfile {
  version: 1;
  codeSha256: string;
  targetsSha256: string;
  appClientId: typeof appClientId;
  jobs: { repair: HostedAppJobSteps; matrix_plan: HostedAppJobSteps };
}

export interface HostedAppSourceInput {
  launcherDir: string;
  runtimeDir: string;
  identity: HostedRuntimeIdentityV1;
  execution: HostedExecutionIntentV1;
  process: ReplayRuntimeV1;
}

/** Inert evidence only; the private host factory also proves native execution. */
export interface HostedAppSourceEvidence {
  launcherDir: string;
  runtimeDir: string;
  codeSha256: string;
  capabilityText: string;
  rolloutText: string;
  targets: readonly string[];
  steps: HostedAppJobSteps;
}

interface TreeEntry {
  path: string;
  mode: string;
  blob: GitSha;
}
const fail = () => new Error("hosted App source evidence unavailable");
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}
function steps(value: unknown): value is HostedAppJobSteps {
  if (
    !record(value) ||
    !exact(value, ["dependencyStep", "mintStep", "runtimeStep"])
  ) return false;
  const names = Object.values(value);
  return names.every((name) =>
    typeof name === "string" && name.length > 0 && name.length <= 200 &&
    !/[\r\n\0]/.test(name)
  ) && new Set(names).size === 3;
}

/** Validate profile data before using its hashes; an empty source stays dormant. */
export function parseHostedAppSourceProfiles(
  value: unknown,
): readonly HostedAppSourceProfile[] {
  if (!Array.isArray(value) || value.length > 32) throw fail();
  const parsed: HostedAppSourceProfile[] = [];
  for (const row of value) {
    if (
      !record(row) ||
      !exact(row, [
        "version",
        "codeSha256",
        "targetsSha256",
        "appClientId",
        "jobs",
      ]) || row.version !== 1 || row.appClientId !== appClientId ||
      typeof row.codeSha256 !== "string" ||
      !digestPattern.test(row.codeSha256) ||
      typeof row.targetsSha256 !== "string" ||
      !digestPattern.test(row.targetsSha256) || !record(row.jobs) ||
      !exact(row.jobs, ["repair", "matrix_plan"]) || !steps(row.jobs.repair) ||
      !steps(row.jobs.matrix_plan)
    ) throw fail();
    if (parsed.some((profile) => profile.codeSha256 === row.codeSha256)) {
      throw fail();
    }
    parsed.push({
      version: 1,
      codeSha256: row.codeSha256,
      targetsSha256: row.targetsSha256,
      appClientId,
      jobs: {
        repair: { ...row.jobs.repair },
        matrix_plan: { ...row.jobs.matrix_plan },
      },
    });
  }
  return parsed;
}

function included(path: string): boolean {
  if (
    path === HOSTED_APP_CAPABILITY_DATA ||
    path === HOSTED_APP_SOURCE_PROFILES ||
    path === HOSTED_RUNTIME_ROLLOUT_DATA
  ) return false;
  return path.startsWith("src/") || path.startsWith("ops/") ||
    path.startsWith(".github/actions/") ||
    path.startsWith(".github/workflows/") || path === targets ||
    path === "deno.json" || path === "deno.lock" || path === "import_map.json";
}

async function hash(bytes: Uint8Array, algorithm = "SHA-256"): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(algorithm, bytes as Uint8Array<ArrayBuffer>),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function gitTree(
  input: HostedAppSourceInput,
  dir: string,
): Promise<TreeEntry[]> {
  const result = await input.process.run({
    executable: "/usr/bin/git",
    args: [
      "--no-replace-objects",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      dir,
      "ls-tree",
      "-rz",
      "HEAD",
    ],
    cwd: dir,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: dir,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    maxDurationMs: 30_000,
    maxOutputBytes: 2 * 1024 * 1024,
  });
  if (
    !result.settled || result.outcome !== "exited" || result.exitCode !== 0 ||
    result.truncated
  ) throw fail();
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  if (!raw.endsWith("\0")) throw fail();
  const entries = raw.slice(0, -1).split("\0").map((line): TreeEntry => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t([A-Za-z0-9_.\/-]+)$/
      .exec(line);
    if (
      match === null ||
      match[3].split("/").some((part) =>
        part === "." || part === ".." || part === ""
      )
    ) throw fail();
    return { mode: match[1], blob: match[2] as GitSha, path: match[3] };
  });
  if (
    entries.length > 10_000 ||
    new Set(entries.map((entry) => entry.path)).size !== entries.length
  ) throw fail();
  return entries;
}

async function checkedFile(dir: string, entry: TreeEntry): Promise<Uint8Array> {
  const path = `${dir}/${entry.path}`;
  const info = await Deno.lstat(path);
  if (
    !info.isFile || info.isSymlink || info.size > maximumFileBytes ||
    await Deno.realPath(path) !== path
  ) throw fail();
  const bytes = await Deno.readFile(path);
  if (bytes.length !== info.size || bytes.length > maximumFileBytes) {
    throw fail();
  }
  const prefix = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const object = new Uint8Array(prefix.length + bytes.length);
  object.set(prefix);
  object.set(bytes, prefix.length);
  if (await hash(object, "SHA-1") !== entry.blob) throw fail();
  return bytes;
}

/** Complete source manifest, including modes; only three strictly parsed source data files are excluded. */
export async function readHostedAppSourceManifest(
  input: HostedAppSourceInput,
  dir: string,
): Promise<{ digest: string; entries: readonly TreeEntry[] }> {
  const entries = await gitTree(input, dir);
  const selected = entries.filter((entry) => included(entry.path));
  const required = [
    workflow,
    targets,
    "deno.json",
    "src/host/hosted-runtime-main.ts",
    "src/host/hosted-runtime-child.ts",
    "src/host/hosted-runtime-launcher.ts",
    ".github/actions/sentinel-app-token/action.yml",
    ".github/actions/sentinel-app-token/main.js",
    ".github/actions/sentinel-app-token/post.js",
    ".github/actions/sentinel-app-token/package.json",
    ".github/actions/sentinel-app-token/package-lock.json",
  ];
  if (required.some((path) => !selected.some((entry) => entry.path === path))) {
    throw fail();
  }
  let total = 0;
  for (const entry of selected) {
    total += (await checkedFile(dir, entry)).length;
    if (total > maximumTreeBytes) throw fail();
  }
  return {
    digest: await hash(new TextEncoder().encode(canonicalStringify(selected))),
    entries,
  };
}

/** Exact installed source is inert until the private host proves saved/native custody. */
export async function readHostedAppSourceEvidence(
  input: HostedAppSourceInput,
  accepted?: unknown,
): Promise<HostedAppSourceEvidence | null> {
  try {
    // Explicit profiles are a trusted in-process historical fixture seam only.
    const approved = accepted === undefined
      ? null
      : parseHostedAppSourceProfiles(accepted);
    if (
      approved?.length === 0 ||
      (input.identity.job !== "repair" &&
        input.identity.job !== "matrix_plan") ||
      input.execution.purpose !== "ordinary" ||
      input.execution.launcherSha !== input.identity.launcherSha ||
      !isGitSha(input.execution.revision) ||
      (approved === null &&
        input.execution.revision !== input.identity.launcherSha)
    ) return null;
    const dirs = await resolveRuntimeDirectories(
      input.launcherDir,
      input.runtimeDir,
    );
    if (
      await readCleanGitHead(input.process, dirs.launcher) !==
        input.identity.launcherSha ||
      await readCleanGitHead(input.process, dirs.runtime) !==
        input.execution.revision
    ) return null;
    const source = await readHostedAppSourceManifest(input, dirs.launcher);
    const profile = approved?.find((row) => row.codeSha256 === source.digest);
    if (approved !== null && profile === undefined) return null;
    if (approved === null) {
      const installed = await readHostedAppSourceManifest(input, dirs.runtime);
      if (installed.digest !== source.digest) return null;
      // The three excluded data files are still exact native Git blobs in both
      // checkouts, including hidden tracked changes that status can miss.
      for (
        const path of [
          HOSTED_APP_CAPABILITY_DATA,
          HOSTED_APP_SOURCE_PROFILES,
          HOSTED_RUNTIME_ROLLOUT_DATA,
        ]
      ) {
        const entry = installed.entries.find((row) => row.path === path);
        if (entry === undefined) return null;
        await checkedFile(dirs.runtime, entry);
      }
    }
    const dataEntry = source.entries.find((entry) =>
      entry.path === HOSTED_APP_CAPABILITY_DATA
    );
    const targetEntry = source.entries.find((entry) => entry.path === targets);
    const rolloutEntry = source.entries.find((entry) =>
      entry.path === HOSTED_RUNTIME_ROLLOUT_DATA
    );
    const profilesEntry = source.entries.find((entry) =>
      entry.path === HOSTED_APP_SOURCE_PROFILES
    );
    if (
      dataEntry === undefined || targetEntry === undefined ||
      rolloutEntry === undefined || profilesEntry === undefined
    ) return null;
    const capabilityBytes = await checkedFile(dirs.launcher, dataEntry);
    if (capabilityBytes.length > 32_768) return null;
    const rolloutBytes = await checkedFile(dirs.launcher, rolloutEntry);
    if (rolloutBytes.length > 512 * 1024) return null;
    const profileBytes = await checkedFile(dirs.launcher, profilesEntry);
    if (profileBytes.length > 32_768) return null;
    const targetBytes = await checkedFile(dirs.launcher, targetEntry);
    if (
      profile !== undefined && await hash(targetBytes) !== profile.targetsSha256
    ) return null;
    const decode = new TextDecoder("utf-8", { fatal: true });
    parseHostedAppSourceProfiles(JSON.parse(decode.decode(profileBytes)));
    const launcherTargets = parseTargetSlugsV1(
      JSON.parse(decode.decode(targetBytes)),
    );
    const runtimeTree = await gitTree(input, dirs.runtime);
    const runtimeTarget = runtimeTree.find((entry) => entry.path === targets);
    if (runtimeTarget === undefined) return null;
    const runtimeTargets = parseTargetSlugsV1(
      JSON.parse(decode.decode(await checkedFile(dirs.runtime, runtimeTarget))),
    );
    if (
      await readCleanGitHead(input.process, dirs.launcher) !==
        input.identity.launcherSha ||
      await readCleanGitHead(input.process, dirs.runtime) !==
        input.execution.revision
    ) return null;
    return {
      launcherDir: dirs.launcher,
      runtimeDir: dirs.runtime,
      codeSha256: source.digest,
      capabilityText: decode.decode(capabilityBytes),
      rolloutText: decode.decode(rolloutBytes),
      targets: launcherTargets.map((row) => row.slug).filter((slug) =>
        runtimeTargets.some((row) => row.slug === slug)
      ),
      steps: { ...(profile?.jobs ?? installedJobSteps)[input.identity.job] },
    };
  } catch {
    return null;
  }
}
