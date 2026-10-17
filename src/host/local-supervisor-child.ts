import { DenoReplayRuntime } from "../replay/runtime.ts";
import { ensurePrivateDir, writeLocalChildLog } from "./local-release.ts";
import {
  CHILD_DENO_DIR,
  CHILD_MUTABLE_STATE_DIRS,
  CHILD_MUTABLE_STATE_FILES,
  CHILD_TMP_DIR,
  CODEX_EXECUTABLE_NAME,
  CODEX_EXECUTABLE_SEGMENTS,
  CODEX_EXEMPTION_MAX_LINK_HOPS,
  CODEX_OPT_IN_ACK,
  CODEX_OPT_IN_MAX_BYTES,
  CODEX_OPT_IN_SEGMENTS,
  GIT_MAX_OUTPUT_BYTES,
  joinPath,
  type LocalSupervisorChildInputV1,
  type LocalSupervisorChildResultV1,
  SANDBOX_EXEC_PATH,
  SANDBOX_VALIDATION_MAX_OUTPUT_BYTES,
  SANDBOX_VALIDATION_PROGRAM,
  SANDBOX_VALIDATION_TIMEOUT_MS,
  SYSTEM_EXECUTABLE_PREFIXES,
} from "./local-supervisor-shared.ts";

/** The prepared inline profile and dedicated child cache paths. */
interface LocalChildWriteBoundaryV1 {
  profile: string;
  canonicalRoot: string;
  denoDir: string;
  tmpDir: string;
}

/** Why the owner-installed Codex executable is not exempted this launch. */
export type CodexExemptionAbsentReasonV1 =
  | "missing"
  | "not_regular_file"
  | "not_executable"
  | "inside_state_root"
  | "system_executable"
  | "not_codex"
  | "not_macho"
  | "control_character"
  | "not_opted_in"
  | "opt_in_invalid";

/** The owner's opt-in to the exemption, read fresh before every launch. */
export type CodexOptInStateV1 = "opted_in" | "not_opted_in" | "opt_in_invalid";

/**
 * The exact exec literals that may leave the child boundary (the launch
 * spelling and its resolved file), or a precise static refusal reason.
 */
export type CodexExecExemptionV1 =
  | { kind: "exempt"; literals: readonly string[] }
  | { kind: "absent"; reason: CodexExemptionAbsentReasonV1 };

/** The profile one child launch uses plus its static child-log line. */
export interface ChildProfileSelectionV1 {
  profile: string;
  note: string;
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
      canonicalRoot,
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
export function buildChildSandboxProfile(
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
 * The one rule that lets exactly the resolved Codex executable start outside
 * the inherited Seatbelt sandbox (issue #100). Nested Seatbelt cannot be
 * applied from inside a sandbox (`sandbox_apply: Operation not permitted`),
 * so Codex confines its own tool commands with its own narrower profile
 * instead. It is appended last, where the last matching rule wins, and names
 * only exact file literals: every other program the child runs stays under
 * the inherited write boundary.
 *
 * The rule constrains only which file starts, never its arguments,
 * environment, config or which code in the child starts it. Any code running
 * in the confined repair host can therefore reach unconfined execution
 * through the exempted Codex (`codex sandbox` with `danger-full-access`,
 * `-c` overrides, a `command/exec` sandbox policy) without a model call, a
 * login or a protected-path change. That is why the rule is used only after
 * the owner's explicit opt-in (`readCodexOptInV1`): opting in lets merged
 * repair-host code reach an unconfined Codex, and only a supervisor-owned
 * broker removes that.
 */
export function codexExemptionRule(literals: readonly string[]): string {
  if (literals.length === 0) {
    throw new TypeError(
      "local supervisor rejected: an exemption names no exact executable",
    );
  }
  const filters = literals.map((path) => `(literal ${sandboxLiteral(path)})`);
  return `(allow process-exec (with no-sandbox) ${filters.join(" ")})`;
}

/**
 * The exemption one launch may use: none unless the owner opted in, and then
 * only the validated native Codex executable (`resolveCodexExecutableV1`).
 * Never throws; every refusal is a precise static reason and keeps today's
 * exact profile.
 */
export async function resolveCodexExecExemptionV1(
  home: string | undefined,
  canonicalRoot: string,
): Promise<CodexExecExemptionV1> {
  if (typeof home !== "string" || !home.startsWith("/")) {
    return absentExemption("missing");
  }
  if (hasControlCharacter(home)) return absentExemption("control_character");
  const optIn = await readCodexOptInV1(home, canonicalRoot);
  if (optIn !== "opted_in") return absentExemption(optIn);
  return await resolveCodexExecutableV1(home, canonicalRoot);
}

/**
 * The owner's explicit opt-in: `~/.config/sentinel-local/codex-exemption-opt-in`
 * holding exactly `CODEX_OPT_IN_ACK`. It counts only as a regular file (not a
 * link, a directory or a hard link), not writable by group or others, small,
 * and in a directory whose canonical path is outside the canonical state
 * root, so neither the confined child nor any installed runtime can create or
 * change it. A missing file is `not_opted_in`; anything else that is not the
 * owner's exact file is `opt_in_invalid`. Never throws.
 */
export async function readCodexOptInV1(
  home: string,
  canonicalRoot: string,
): Promise<CodexOptInStateV1> {
  const path = joinPath(home, ...CODEX_OPT_IN_SEGMENTS);
  try {
    if (hasControlCharacter(path)) return "opt_in_invalid";
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(path);
    } catch (error) {
      return error instanceof Deno.errors.NotFound
        ? "not_opted_in"
        : "opt_in_invalid";
    }
    if (!info.isFile || info.isSymlink) return "opt_in_invalid";
    if (info.mode === null || (info.mode & 0o022) !== 0) {
      return "opt_in_invalid";
    }
    if (info.nlink !== null && info.nlink > 1) return "opt_in_invalid";
    if (info.size > CODEX_OPT_IN_MAX_BYTES) return "opt_in_invalid";
    const parent = await Deno.realPath(path.slice(0, path.lastIndexOf("/")));
    if (isInsideRoot(parent, canonicalRoot)) return "opt_in_invalid";
    const text = await readBoundedText(path, CODEX_OPT_IN_MAX_BYTES);
    return text !== null && text.trim() === CODEX_OPT_IN_ACK
      ? "opted_in"
      : "opt_in_invalid";
  } catch {
    return "opt_in_invalid";
  }
}

/**
 * Resolve the owner-installed native Codex executable the local repair host
 * launches (`$HOME/.codex/bin/codex`), independent of the opt-in. Only an
 * exact executable Mach-O file named `codex` outside the platform directories
 * qualifies, and only when the spelling and every link hop live outside the
 * canonical private state root, so the confined child can neither plant nor
 * redirect an exempted program (nothing outside the state root is writable to
 * it). This narrows which file may start unconfined; it does not narrow what
 * that file is asked to do. Never throws.
 */
export async function resolveCodexExecutableV1(
  home: string | undefined,
  canonicalRoot: string,
): Promise<CodexExecExemptionV1> {
  if (typeof home !== "string" || !home.startsWith("/")) {
    return absentExemption("missing");
  }
  const spelled = joinPath(home, ...CODEX_EXECUTABLE_SEGMENTS);
  if (hasControlCharacter(spelled)) return absentExemption("control_character");
  try {
    const hops = await linkHopsOutsideRoot(spelled, canonicalRoot);
    if (hops === null) return absentExemption("missing");
    if (!hops) return absentExemption("inside_state_root");
    const real = await Deno.realPath(spelled);
    if (hasControlCharacter(real)) return absentExemption("control_character");
    const info = await Deno.stat(real);
    if (!info.isFile) return absentExemption("not_regular_file");
    if (info.mode === null || (info.mode & 0o111) === 0) {
      return absentExemption("not_executable");
    }
    if (isInsideRoot(real, canonicalRoot)) {
      return absentExemption("inside_state_root");
    }
    if (SYSTEM_EXECUTABLE_PREFIXES.some((prefix) => real.startsWith(prefix))) {
      return absentExemption("system_executable");
    }
    if (real.slice(real.lastIndexOf("/") + 1) !== CODEX_EXECUTABLE_NAME) {
      return absentExemption("not_codex");
    }
    if (!await hasMachOHeader(real)) return absentExemption("not_macho");
    return {
      kind: "exempt",
      literals: spelled === real ? [real] : [spelled, real],
    };
  } catch {
    return absentExemption("missing");
  }
}

/**
 * Choose the profile for one launch. An exemption is used only after the
 * platform accepted that exact profile; an absent exemption, a rejection or
 * a validator failure keeps the exact base profile, so the child is always
 * sandboxed and Codex at worst fails nested exactly as before. Never throws.
 */
export async function selectChildSandboxProfile(
  baseProfile: string,
  exemption: CodexExecExemptionV1,
  validate: (profile: string) => Promise<boolean>,
): Promise<ChildProfileSelectionV1> {
  if (exemption.kind === "absent") {
    return {
      profile: baseProfile,
      note: `codex-exemption: absent:${exemption.reason}`,
    };
  }
  let candidate: string;
  let accepted = false;
  try {
    candidate = `${baseProfile}\n${codexExemptionRule(exemption.literals)}`;
    accepted = await validate(candidate) === true;
  } catch {
    accepted = false;
    candidate = baseProfile;
  }
  return accepted
    ? { profile: candidate, note: "codex-exemption: applied" }
    : { profile: baseProfile, note: "codex-exemption: rejected" };
}

/**
 * One bounded platform validation: the exact candidate profile must apply to
 * a fixed trivial program and exit 0. A profile the platform does not accept
 * (for example an unsupported modifier) is never used for a real child.
 */
export async function validateChildSandboxProfile(
  profile: string,
): Promise<boolean> {
  const result = await new DenoReplayRuntime(SANDBOX_EXEC_PATH).run({
    executable: SANDBOX_EXEC_PATH,
    args: ["-p", profile, SANDBOX_VALIDATION_PROGRAM],
    cwd: "/",
    env: {},
    maxDurationMs: SANDBOX_VALIDATION_TIMEOUT_MS,
    maxOutputBytes: SANDBOX_VALIDATION_MAX_OUTPUT_BYTES,
  });
  return result.settled && result.exitCode === 0;
}

function absentExemption(
  reason: CodexExemptionAbsentReasonV1,
): CodexExecExemptionV1 {
  return { kind: "absent", reason };
}

function isInsideRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Follow the bounded link chain from the launch spelling. True when every
 * entry on it sits in a directory whose canonical path is outside the state
 * root; false when one is inside it; null for a missing entry or a loop.
 */
async function linkHopsOutsideRoot(
  start: string,
  root: string,
): Promise<boolean | null> {
  let path = start;
  for (let hop = 0; hop <= CODEX_EXEMPTION_MAX_LINK_HOPS; hop++) {
    const slash = path.lastIndexOf("/");
    const parent = await Deno.realPath(slash <= 0 ? "/" : path.slice(0, slash));
    if (isInsideRoot(parent, root)) return false;
    const entry = joinPath(parent, path.slice(slash + 1));
    const info = await Deno.lstat(entry);
    if (!info.isSymlink) return true;
    const target = await Deno.readLink(entry);
    path = target.startsWith("/") ? target : joinPath(parent, target);
  }
  return null;
}

/** At most `limit` bytes as text, or null when the file is larger. */
async function readBoundedText(
  path: string,
  limit: number,
): Promise<string | null> {
  const file = await Deno.open(path, { read: true });
  try {
    const buffer = new Uint8Array(limit + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const count = await file.read(buffer.subarray(filled));
      if (count === null) break;
      filled += count;
    }
    if (filled > limit) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, filled),
    );
  } finally {
    file.close();
  }
}

/** Thin or universal Mach-O magic; scripts and interpreters never qualify. */
async function hasMachOHeader(path: string): Promise<boolean> {
  const file = await Deno.open(path, { read: true });
  try {
    const head = new Uint8Array(4);
    let filled = 0;
    while (filled < head.length) {
      const count = await file.read(head.subarray(filled));
      if (count === null) break;
      filled += count;
    }
    if (filled < head.length) return false;
    const magic = new DataView(head.buffer).getUint32(0, false);
    return MACHO_MAGICS.has(magic);
  } finally {
    file.close();
  }
}

/** MH_MAGIC/MH_CIGAM (32/64-bit) and FAT_MAGIC/FAT_CIGAM, read big-endian. */
const MACHO_MAGICS = new Set([
  0xfeedface,
  0xcefaedfe,
  0xfeedfacf,
  0xcffaedfe,
  0xcafebabe,
  0xbebafeca,
]);

function hasControlCharacter(path: string): boolean {
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * One correctly quoted SBPL string. The profile is passed as a single argv
 * element and never through a shell; a path that cannot be represented safely
 * is a refusal rather than an interpolation into the profile.
 */
function sandboxLiteral(path: string): string {
  if (hasControlCharacter(path)) {
    throw new TypeError(
      "local supervisor rejected: a child sandbox path contains a control character",
    );
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
 *
 * Only after the owner's explicit opt-in is the owner-installed native Codex
 * executable exempted from the inherited sandbox (validated per launch,
 * otherwise today's exact profile), and the child log records which case
 * applied as one static first line. Opted in, any repair-host code can reach
 * an unconfined Codex; see `codexExemptionRule`.
 */
export async function defaultRunChild(
  input: LocalSupervisorChildInputV1,
): Promise<LocalSupervisorChildResultV1> {
  const boundary = await prepareChildWriteBoundary(input.stateRoot);
  if (boundary === null) return { settled: false, exitCode: null };
  const selection = await selectChildSandboxProfile(
    boundary.profile,
    await resolveCodexExecExemptionV1(input.env.HOME, boundary.canonicalRoot),
    validateChildSandboxProfile,
  );
  const result = await new DenoReplayRuntime(SANDBOX_EXEC_PATH).run({
    executable: SANDBOX_EXEC_PATH,
    args: [
      "-p",
      selection.profile,
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
    `${selection.note}\nstdout:\n${stdout}\nstderr:\n${stderr}\n`,
  ).catch(() => {});
  // Truthful mapping: an unsettled run stays unsettled and a timed-out run
  // keeps its null exit code, so it can never be read as a successful run.
  return { settled: result.settled, exitCode: result.exitCode };
}
