import { DenoReplayRuntime } from "../replay/runtime.ts";
import { ensurePrivateDir, writeLocalChildLog } from "./local-release.ts";
import {
  CHILD_DENO_DIR,
  CHILD_MUTABLE_STATE_DIRS,
  CHILD_MUTABLE_STATE_FILES,
  CHILD_TMP_DIR,
  GIT_MAX_OUTPUT_BYTES,
  joinPath,
  type LocalSupervisorChildInputV1,
  type LocalSupervisorChildResultV1,
  SANDBOX_EXEC_PATH,
} from "./local-supervisor-shared.ts";

/** The prepared inline profile and dedicated child cache paths. */
interface LocalChildWriteBoundaryV1 {
  profile: string;
  denoDir: string;
  tmpDir: string;
}

/**
 * The exact inherited OS write boundary for one real repair child. The child
 * keeps the trusted host's read, process and network permissions, but every
 * write, hardlink and rename is denied unless it is beneath one exact mutable
 * private state directory, on one exact child-owned receipt or on
 * `/dev/null`. `file-write-mode` on the state root itself exists only for the
 * existing `ensurePrivateDir` chmod. Each mutable top-level directory is
 * additionally unlinked-denied so an allowed directory can never be replaced
 * or renamed into authority.
 *
 * The state root and every granted directory are re-observed here: a symlinked
 * root or a symlinked mutable directory would silently expand the granted
 * subpath, so it is a refusal and never a partially granted profile. The
 * profile is an inline argv string; no child-writable profile file exists.
 */
async function prepareChildWriteBoundary(
  stateRoot: string,
): Promise<LocalChildWriteBoundaryV1 | null> {
  if (Deno.build.os !== "darwin") return null;
  try {
    const rootInfo = await Deno.lstat(stateRoot);
    if (!rootInfo.isDirectory || rootInfo.isSymlink) return null;
    const canonicalRoot = await Deno.realPath(stateRoot);
    await ensurePrivateDir(canonicalRoot);
    const mutableDirs: string[] = [];
    for (const name of CHILD_MUTABLE_STATE_DIRS) {
      const dir = joinPath(canonicalRoot, name);
      if (!await prepareMutableGrantDir(dir)) return null;
      mutableDirs.push(dir);
    }
    const denoDir = joinPath(canonicalRoot, CHILD_DENO_DIR);
    const tmpDir = joinPath(canonicalRoot, CHILD_TMP_DIR);
    for (const dir of [denoDir, tmpDir]) {
      if (!await prepareMutableGrantDir(dir)) return null;
    }
    return {
      profile: buildChildSandboxProfile(canonicalRoot, mutableDirs),
      denoDir,
      tmpDir,
    };
  } catch {
    return null;
  }
}

/**
 * One mutable grant directory. An entry that already exists is re-observed
 * BEFORE any chmod: a symlink there would otherwise redirect the mode change
 * outside the state root, so a symlink or non-directory is a refusal and no
 * existing entry is ever recreated, removed or reset. A missing entry is
 * created private, and every accepted directory must resolve to its own exact
 * path.
 */
async function prepareMutableGrantDir(dir: string): Promise<boolean> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(dir);
  } catch {
    await ensurePrivateDir(dir);
    return await Deno.realPath(dir) === dir;
  }
  if (!info.isDirectory || info.isSymlink) return false;
  await Deno.chmod(dir, 0o700);
  return await Deno.realPath(dir) === dir;
}

/**
 * The inline Seatbelt profile for one real child. The broad deny lands first,
 * the exact mutable grants land next, and the per-directory unlink denials
 * land last so an allowed directory is writable but never replaceable.
 */
function buildChildSandboxProfile(
  canonicalRoot: string,
  mutableDirs: readonly string[],
): string {
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write* file-link)",
  ];
  for (const dir of mutableDirs) {
    lines.push(
      `(allow file-write* file-link (subpath ${sandboxLiteral(dir)}))`,
    );
  }
  for (const name of CHILD_MUTABLE_STATE_FILES) {
    lines.push(
      `(allow file-write* (literal ${
        sandboxLiteral(joinPath(canonicalRoot, name))
      }))`,
    );
  }
  lines.push(`(allow file-write* (literal ${sandboxLiteral("/dev/null")}))`);
  lines.push(
    `(allow file-write-mode (literal ${sandboxLiteral(canonicalRoot)}))`,
  );
  for (const dir of mutableDirs) {
    lines.push(`(deny file-write-unlink (literal ${sandboxLiteral(dir)}))`);
  }
  return lines.join("\n");
}

/**
 * One correctly quoted SBPL string. The profile is passed as a single argv
 * element and never through a shell; a path that cannot be represented safely
 * is a refusal rather than an interpolation into the profile.
 */
function sandboxLiteral(path: string): string {
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      throw new TypeError(
        "local supervisor rejected: a child sandbox path contains a control character",
      );
    }
  }
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * The only injected implementation border: real Deno child execution. Every
 * real child is launched through the fixed platform sandbox with `DENO_DIR`
 * and `TMPDIR` redirected beneath the private state, using the same owned
 * process-group runtime as every other real subprocess. The deadline spans the
 * whole sandboxed group and its captured streams, so a descendant that
 * outlives the task leader is terminated and settlement is verified before the
 * run is reported. A platform or profile that cannot provide the boundary
 * returns a non-success result and the child is never launched unsandboxed.
 */
export async function defaultRunChild(
  input: LocalSupervisorChildInputV1,
): Promise<LocalSupervisorChildResultV1> {
  const boundary = await prepareChildWriteBoundary(input.stateRoot);
  if (boundary === null) return { settled: false, exitCode: null };
  const result = await new DenoReplayRuntime(SANDBOX_EXEC_PATH).run({
    executable: SANDBOX_EXEC_PATH,
    args: [
      "-p",
      boundary.profile,
      input.denoExecutable,
      "task",
      input.taskName,
    ],
    cwd: input.runtimeDir,
    env: {
      ...input.env,
      DENO_DIR: boundary.denoDir,
      TMPDIR: boundary.tmpDir,
    },
    maxDurationMs: input.deadlineMs,
    maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  await writeLocalChildLog(
    input.stateRoot,
    `child-${input.revision}-${Date.now()}`,
    `stdout:\n${stdout}\nstderr:\n${stderr}\n`,
  ).catch(() => {});
  // Truthful mapping: an unsettled run stays unsettled and a timed-out run
  // keeps its null exit code, so it can never be read as a successful run.
  return { settled: result.settled, exitCode: result.exitCode };
}
