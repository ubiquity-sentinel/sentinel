/**
 * Owner command for issue #100: `deno task check:macos-boundary [--model]`.
 *
 * One self-contained macOS check that the fixed local supervisor, once the
 * owner opts in, lets the Codex child apply its own tool sandbox, and that
 * shows the owner what opting in gives up. It runs on the owner's Mac against
 * disposable state beneath `<repo>/.macos-boundary-check-<uuid>/` and prints
 * one line per step (PASS / FAIL / INFO / SKIP), then
 * `RESULT: PASS|FAIL <first failure>`, the `TRADE-OFF:` lines and a report
 * path. Exit 0 pass, 1 fail, 2 prerequisites missing or unsupported.
 *
 *   L0  prerequisites: macOS, /usr/bin/sandbox-exec, Deno, git, and the
 *       native Codex at ~/.codex/bin/codex accepted by the production
 *       resolver; the owner's opt-in state is information only.
 *   L1  Seatbelt behaviour without Codex, using copies of /bin/sh and the
 *       production profile text: without the opt-in no exemption is used;
 *       without the exemption a nested sandbox fails (`sandbox_apply`, the
 *       #100 baseline, information only); with it the exempted program
 *       applies its own inner sandbox and the inner rule holds, while a
 *       non-exempted sibling and the host stay confined.
 *   L2  the REAL lifecycle, no model and no login: `runLocalSupervisor` on a
 *       disposable state root with the real `defaultRunChild` and a
 *       disposable HOME (its own opt-in, `.codex/bin/codex` linked to the
 *       owner's real Codex), whose child is `macos-boundary-child.ts`, which
 *       starts that real Codex app-server, drives Codex's own `sentinel-local`
 *       sandbox and shows the residual risk (`residual_r1_unconfined_codex`).
 *   L3  `--model`: one real model turn through the local gateway
 *       (`UOS_AI_TOKEN`, 127.0.0.1:8000), judged by reading files back.
 *
 * It never reads or writes `~/.local/state/sentinel-local`, never creates the
 * owner's opt-in, only reads `~/.codex` and `~/.config/sentinel-local`, uses
 * dummy GitHub and model tokens unless `--model` is given, makes no GitHub
 * call, and removes any model token file before it exits.
 */

import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  localSessionMarkerExists,
  probeRunnerLock,
} from "../../src/host/local-release.ts";
import { runLocalSupervisor } from "../../src/host/local-supervisor.ts";
import {
  buildChildSandboxProfile,
  type CodexExemptionAbsentReasonV1,
  codexExemptionRule,
  readCodexOptInV1,
  resolveCodexExecExemptionV1,
  resolveCodexExecutableV1,
  validateChildSandboxProfile,
} from "../../src/host/local-supervisor-child.ts";
import {
  CHILD_MUTABLE_STATE_DIRS,
  CODEX_EXECUTABLE_SEGMENTS,
  CODEX_OPT_IN_ACK,
  CODEX_OPT_IN_SEGMENTS,
  joinPath,
  SANDBOX_EXEC_PATH,
} from "../../src/host/local-supervisor-shared.ts";
import { createRepairStateStore } from "../../src/state/mod.ts";
import type {
  BoundaryFixtureConfigV1,
  BoundaryFixtureResultsV1,
} from "./macos-boundary-child.ts";

export type CheckLevelV1 = "L0" | "L1" | "L2" | "L3";
export type CheckStatusV1 = "PASS" | "FAIL" | "INFO" | "SKIP";

export interface CheckStepV1 {
  level: CheckLevelV1;
  name: string;
  status: CheckStatusV1;
  detail: string;
  /** A failed prerequisite makes the whole check exit 2. */
  prerequisite?: boolean;
}

export interface CheckArgsV1 {
  model: boolean;
  keep: boolean;
  help: boolean;
}

export interface CheckRunResultV1 {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface CheckRunOptionsV1 {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** Every platform effect of the check; tests substitute it off macOS. */
export interface CheckIoV1 {
  os: string;
  cwd: string;
  env(name: string): string | undefined;
  print(line: string): void;
  run(
    command: string,
    args: string[],
    options?: CheckRunOptionsV1,
  ): Promise<CheckRunResultV1>;
}

export interface CheckVerdictV1 {
  result: "PASS" | "FAIL";
  exitCode: 0 | 1 | 2;
  firstFailure: string | null;
}

const PINNED_CODEX_VERSION: [number, number, number] = [0, 154, 0];
const MIN_DENO_VERSION: [number, number, number] = [2, 3, 0];
const RUN_TIMEOUT_MS = 20_000;
const DETAIL_CAP = 400;
const DUMMY_GITHUB_TOKEN = "macos-boundary-check-no-github-call";
const DUMMY_MODEL_TOKEN = "macos-boundary-check-no-model-call";
const OUTSIDE_TEXT = "macos-boundary-check outside file\n";
/**
 * Codex's own macOS process defaults let every tool command read and write
 * these scratch roots, so a check rooted beneath one could not observe its
 * boundary (an outside file there is legitimately reachable).
 */
/** The owner's opt-in file as the owner types it. */
const OPT_IN_DISPLAY = `~/${CODEX_OPT_IN_SEGMENTS.join("/")}`;

/** The two commands that opt in; removing the file opts out again. */
export const OPT_IN_COMMANDS = [
  `mkdir -p ~/${CODEX_OPT_IN_SEGMENTS.slice(0, -1).join("/")}`,
  `printf '%s\\n' '${CODEX_OPT_IN_ACK}' > ${OPT_IN_DISPLAY}`,
] as const;

/** The plain trade-off the owner accepts by opting in. */
const TRADE_OFF_SENTENCE =
  "Opting in lets merged repair-host code reach an unconfined Codex; only a supervisor-owned broker removes that.";

/**
 * Printed after every RESULT line. A PASS proves the exemption works with
 * the owner's Codex; it is not proof that the repair host is confined.
 */
export const TRADE_OFF_LINES = [
  `TRADE-OFF: ${TRADE_OFF_SENTENCE}`,
  "TRADE-OFF: any repair-host module that is not a protected path (most of the repair:run graph, not only the files that launch Codex) can start ~/.codex/bin/codex with its own arguments, config and sandbox and write the supervisor pointer, receipts and runtimes; residual_r1_unconfined_codex above shows it.",
  "TRADE-OFF: a PASS shows the exemption works with your Codex; it does not show that the repair host is confined against its own code. Close #100 only if you accept this; the broker is the follow-up that removes it.",
  `TRADE-OFF: your installed supervisor uses the exemption only after you opt in: ${
    OPT_IN_COMMANDS.join(" && ")
  } (rm ${OPT_IN_DISPLAY} to opt out).`,
] as const;

/** What the owner can do about each production resolver refusal. */
const CODEX_REMEDIES: Record<CodexExemptionAbsentReasonV1, string> = {
  missing:
    "install the native Codex CLI and link it there, e.g. ln -s ~/.codex/packages/standalone/current/bin/codex ~/.codex/bin/codex",
  not_regular_file: "it must resolve to a file, not a directory",
  not_executable: "the resolved file is not executable (chmod 755 it)",
  inside_state_root: "it must not resolve through a state directory",
  system_executable:
    "it resolves into a system directory; point it at the native Codex binary",
  not_codex:
    "the resolved file must be named exactly codex (copy or link the native binary to a .../bin/codex path)",
  not_macho:
    "it resolves to a script or launcher (for example the npm wrapper), not the native Mach-O Codex binary",
  control_character: "the path contains a control character",
  not_opted_in: `the owner has not opted in (${OPT_IN_DISPLAY})`,
  opt_in_invalid:
    `${OPT_IN_DISPLAY} must be a regular file you wrote, not a link, not group or world writable, holding exactly the opt-in text`,
};

export const CODEX_SCRATCH_ROOTS = [
  "/tmp",
  "/private/tmp",
  "/var/tmp",
  "/private/var/tmp",
] as const;
const SHELL_WRITE = 'printf %s "$2" > "$1"';
/** Run by the exempted (or not) launcher: apply an inner sandbox, write. */
const NESTED_APPLY =
  'exec /usr/bin/sandbox-exec -p "$1" /bin/sh -c \'printf %s ok > "$1"\' inner "$2"';

export const HELP_LINES = [
  "deno task check:macos-boundary [--model] [--keep]",
  "",
  "Checks on macOS that the fixed local supervisor confines the repair host",
  "while the owner-installed Codex applies its own tool sandbox (issue #100).",
  "",
  "Prerequisites:",
  "  - macOS with /usr/bin/sandbox-exec",
  "  - Deno 2.3 or newer (2.9.x recommended)",
  "  - git (Xcode Command Line Tools)",
  "  - the native Codex CLI at ~/.codex/bin/codex (0.154.0 or newer);",
  "    no Codex login is needed",
  "",
  "Opt-in (your installed supervisor keeps today's profile without it):",
  `  ${TRADE_OFF_SENTENCE}`,
  ...OPT_IN_COMMANDS.map((command) => `  ${command}`),
  `  Remove ${OPT_IN_DISPLAY} to opt out. This check uses its own`,
  "  disposable opt-in and never creates your opt-in.",
  "",
  "Options:",
  "  --model  also run one real model turn through the local gateway;",
  "           needs UOS_AI_TOKEN and the gateway at 127.0.0.1:8000",
  "  --keep   keep the disposable check directory even when it passes",
  "",
  "It writes only beneath <repo>/.macos-boundary-check-<uuid>/, never touches",
  "~/.local/state/sentinel-local, only reads ~/.codex and makes no GitHub call.",
  "Exit 0 pass, 1 fail, 2 prerequisites missing or unsupported.",
];

export function parseCheckArgs(
  args: readonly string[],
): { ok: true; value: CheckArgsV1 } | { ok: false; error: string } {
  const value: CheckArgsV1 = { model: false, keep: false, help: false };
  for (const arg of args) {
    if (arg === "--model") value.model = true;
    else if (arg === "--keep") value.keep = true;
    else if (arg === "--help" || arg === "-h") value.help = true;
    else return { ok: false, error: `unknown argument ${arg}` };
  }
  return { ok: true, value };
}

/**
 * Any failed step fails the check (a failed prerequisite exits 2); INFO and
 * SKIP never gate, and a run where no gating step passed is never a PASS.
 */
export function checkVerdict(steps: readonly CheckStepV1[]): CheckVerdictV1 {
  const label = (step: CheckStepV1) =>
    `[${step.level}] ${step.name}: ${step.detail}`;
  const prerequisite = steps.find((step) =>
    step.status === "FAIL" && step.prerequisite === true
  );
  if (prerequisite !== undefined) {
    return { result: "FAIL", exitCode: 2, firstFailure: label(prerequisite) };
  }
  const failed = steps.find((step) => step.status === "FAIL");
  if (failed !== undefined) {
    return { result: "FAIL", exitCode: 1, firstFailure: label(failed) };
  }
  if (!steps.some((step) => step.status === "PASS")) {
    return {
      result: "FAIL",
      exitCode: 1,
      firstFailure: "no gating step passed",
    };
  }
  return { result: "PASS", exitCode: 0, firstFailure: null };
}

/** The RESULT line, then the trade-off the owner must read, always. */
export function resultLines(verdict: CheckVerdictV1): string[] {
  return [
    `RESULT: ${verdict.result}${
      verdict.firstFailure === null ? "" : ` ${verdict.firstFailure}`
    }`,
    ...TRADE_OFF_LINES,
  ];
}

export function formatStep(step: CheckStepV1): string {
  const detail = step.detail.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
  return `[${step.level}] ${step.status} ${step.name}: ${detail}`;
}

export function parseCodexVersion(
  text: string,
): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match === null
    ? null
    : [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(
  left: readonly number[],
  right: readonly number[],
): number {
  for (let index = 0; index < 3; index++) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function bounded(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  const flat = text.trim();
  return flat.length > DETAIL_CAP ? `${flat.slice(0, DETAIL_CAP)}...` : flat;
}

/** One SBPL string, quoted exactly as the production profile quotes paths. */
function sbpl(text: string): string {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

class Recorder {
  readonly steps: CheckStepV1[] = [];
  readonly lines: string[] = [];
  constructor(private readonly io: CheckIoV1) {}

  print(line: string): void {
    this.lines.push(line);
    this.io.print(line);
  }

  add(step: CheckStepV1): CheckStepV1 {
    this.steps.push(step);
    this.print(formatStep(step));
    return step;
  }

  check(
    level: CheckLevelV1,
    name: string,
    ok: boolean,
    detail: string,
    prerequisite = false,
  ): boolean {
    this.add({
      level,
      name,
      status: ok ? "PASS" : "FAIL",
      detail: bounded(detail),
      ...(prerequisite ? { prerequisite } : {}),
    });
    return ok;
  }

  info(level: CheckLevelV1, name: string, detail: string): void {
    this.add({ level, name, status: "INFO", detail: bounded(detail) });
  }

  failed(): boolean {
    return this.steps.some((step) => step.status === "FAIL");
  }
}

interface PrerequisitesV1 {
  home: string;
  path: string;
  git: string;
  spelled: string;
  real: string;
}

function describeRun(result: CheckRunResultV1): string {
  return `exit=${result.code} stderr=${bounded(result.stderr)}`;
}

async function checkPrerequisites(
  io: CheckIoV1,
  rec: Recorder,
  root: string,
): Promise<PrerequisitesV1 | null> {
  const sw = await io.run("/usr/bin/sw_vers", []).catch(() => null);
  rec.info("L0", "macos", sw?.stdout.trim() ?? "sw_vers unavailable");
  let sandboxExec = false;
  try {
    sandboxExec = (await Deno.stat(SANDBOX_EXEC_PATH)).isFile;
  } catch {
    sandboxExec = false;
  }
  rec.check(
    "L0",
    "sandbox_exec",
    sandboxExec,
    sandboxExec ? SANDBOX_EXEC_PATH : `${SANDBOX_EXEC_PATH} is missing`,
    true,
  );
  const deno = parseCodexVersion(Deno.version.deno) ?? [0, 0, 0];
  rec.check(
    "L0",
    "deno",
    compareVersions(deno, MIN_DENO_VERSION) >= 0,
    `Deno ${Deno.version.deno} at ${Deno.execPath()} (needs 2.3 or newer)`,
    true,
  );
  const home = io.env("HOME") ?? "";
  const path = io.env("PATH") ?? "";
  const scratch = CODEX_SCRATCH_ROOTS.find((dir) =>
    root === dir || root.startsWith(`${dir}/`)
  );
  if (
    !rec.check("L0", "home", home.startsWith("/"), `HOME=${home}`, true) ||
    !rec.check("L0", "path", path.length > 0, "PATH is set", true) ||
    !rec.check(
      "L0",
      "check_location",
      scratch === undefined,
      scratch === undefined
        ? `disposable root ${root}`
        : `the clone is beneath ${scratch}, which Codex's own sandbox lets every tool read and write; clone the repository under your home directory instead`,
      true,
    )
  ) {
    return null;
  }
  const git = await exists("/usr/bin/git") ? "/usr/bin/git" : "git";
  const gitVersion = await io.run(git, ["--version"]).catch((error) => ({
    code: null,
    stdout: "",
    stderr: bounded(error),
  }));
  rec.check(
    "L0",
    "git",
    gitVersion.code === 0,
    gitVersion.code === 0
      ? gitVersion.stdout.trim()
      : `git is not usable (install the Xcode Command Line Tools: xcode-select --install); ${
        describeRun(gitVersion)
      }`,
    true,
  );
  const spelled = joinPath(home, ...CODEX_EXECUTABLE_SEGMENTS);
  const probeRoot = joinPath(root, "resolver-state");
  await Deno.mkdir(probeRoot, { recursive: true, mode: 0o700 });
  const canonicalProbeRoot = await Deno.realPath(probeRoot);
  const optIn = await readCodexOptInV1(home, canonicalProbeRoot);
  rec.info(
    "L0",
    "codex_opt_in",
    optIn === "opted_in"
      ? `${OPT_IN_DISPLAY} is present: your installed supervisor exempts Codex for every repair child and you have accepted the TRADE-OFF below`
      : optIn === "not_opted_in"
      ? `${OPT_IN_DISPLAY} is absent: your installed supervisor keeps today's exact profile (Codex tool commands still fail nested, #100) until you opt in; this check uses its own disposable opt-in`
      : `${OPT_IN_DISPLAY} is not valid (${CODEX_REMEDIES.opt_in_invalid}): your installed supervisor treats it as absent`,
  );
  const exemption = await resolveCodexExecutableV1(home, canonicalProbeRoot);
  if (exemption.kind === "absent") {
    rec.check(
      "L0",
      "codex_executable",
      false,
      `${spelled} is not exemptable (${exemption.reason}): ${
        CODEX_REMEDIES[exemption.reason]
      }. The local repair host launches exactly this path.`,
      true,
    );
    return null;
  }
  const real = exemption.literals[exemption.literals.length - 1];
  rec.check(
    "L0",
    "codex_executable",
    true,
    `${spelled} -> ${real} (executable Mach-O, accepted by the production resolver)`,
    true,
  );
  const version = await io.run(spelled, ["--version"], {
    env: { PATH: path, HOME: home },
  }).catch((error) => ({
    code: null,
    stdout: "",
    stderr: bounded(error),
  }));
  const parsed = parseCodexVersion(version.stdout);
  rec.check(
    "L0",
    "codex_version",
    version.code === 0 && parsed !== null,
    version.code === 0 ? version.stdout.trim() : describeRun(version),
    true,
  );
  if (
    parsed !== null && compareVersions(parsed, PINNED_CODEX_VERSION) < 0
  ) {
    rec.info(
      "L0",
      "codex_version_pin",
      `older than the pinned 0.154.0; command/exec permissionProfile may be missing`,
    );
  }
  const sign = await io.run("/usr/bin/codesign", ["-dv", "--verbose=2", real])
    .catch(() => null);
  const signLines = (sign?.stderr ?? "").split("\n").filter((line) =>
    /^(Identifier|TeamIdentifier|CodeDirectory|Runtime Version)/.test(line)
  );
  rec.info("L0", "codex_signature", signLines.join("; ") || "unavailable");
  if (rec.failed()) return null;
  return { home, path, git, spelled, real };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function link(io: CheckIoV1, target: string, path: string) {
  const linked = await io.run("/bin/ln", ["-s", target, path]);
  if (linked.code !== 0) throw new Error(`ln -s failed: ${linked.stderr}`);
}

/** A disposable HOME's opt-in, exactly as the owner commands write it. */
async function writeOptIn(home: string): Promise<void> {
  const path = joinPath(home, ...CODEX_OPT_IN_SEGMENTS);
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
    recursive: true,
    mode: 0o700,
  });
  await Deno.writeTextFile(path, `${CODEX_OPT_IN_ACK}\n`, { mode: 0o644 });
  await Deno.chmod(path, 0o644);
}

async function copyExecutable(source: string, target: string): Promise<void> {
  await Deno.copyFile(source, target);
  await Deno.chmod(target, 0o755);
}

/** L1: Seatbelt behaviour with copies of /bin/sh and the production rule. */
async function checkSeatbelt(
  io: CheckIoV1,
  rec: Recorder,
  root: string,
): Promise<void> {
  const l1 = joinPath(root, "l1");
  const home = joinPath(l1, "home");
  const standalone = joinPath(home, ".codex", "packages", "standalone");
  const release = joinPath(standalone, "releases", "0.0.0-check");
  const releaseBinary = joinPath(release, "bin", "codex");
  const spelled = joinPath(home, ...CODEX_EXECUTABLE_SEGMENTS);
  const sibling = joinPath(l1, "sibling", "codex");
  const state = joinPath(l1, "state");
  const outside = joinPath(l1, "outside");
  const innerDenied = joinPath(outside, "inner-denied");
  for (
    const dir of [
      joinPath(release, "bin"),
      joinPath(home, ".codex", "bin"),
      joinPath(l1, "sibling"),
      innerDenied,
      ...CHILD_MUTABLE_STATE_DIRS.map((name) => joinPath(state, name)),
    ]
  ) {
    await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  }
  await copyExecutable("/bin/sh", releaseBinary);
  await copyExecutable("/bin/sh", sibling);
  await link(io, release, joinPath(standalone, "current"));
  await link(io, joinPath(standalone, "current", "bin", "codex"), spelled);
  const canonical = await Deno.realPath(state);
  const base = buildChildSandboxProfile(
    canonical,
    CHILD_MUTABLE_STATE_DIRS.map((name) => joinPath(canonical, name)),
  );
  const withoutOptIn = await resolveCodexExecExemptionV1(home, canonical);
  rec.check(
    "L1",
    "resolver_requires_opt_in",
    withoutOptIn.kind === "absent" && withoutOptIn.reason === "not_opted_in",
    `without the owner's opt-in a valid Codex keeps today's profile: ${
      JSON.stringify(withoutOptIn)
    }`,
  );
  await writeOptIn(home);
  const exemption = await resolveCodexExecExemptionV1(home, canonical);
  const realBinary = await Deno.realPath(releaseBinary);
  if (
    !rec.check(
      "L1",
      "resolver_accepts_installer_layout",
      exemption.kind === "exempt" &&
        exemption.literals.join("|") === `${spelled}|${realBinary}`,
      JSON.stringify(exemption),
    ) || exemption.kind !== "exempt"
  ) {
    return;
  }
  const rule = codexExemptionRule(exemption.literals);
  const exempt = `${base}\n${rule}`;
  rec.info("L1", "production_rule", rule);
  rec.check(
    "L1",
    "platform_accepts_profile",
    await validateChildSandboxProfile(exempt),
    "sandbox-exec applied the exemption profile to /usr/bin/true",
  );
  const inner = (denied: string) =>
    `(version 1)\n(allow default)\n(deny file-write* (subpath ${
      sbpl(denied)
    }))`;
  const nested = (profile: string, launcher: string, target: string) =>
    io.run(SANDBOX_EXEC_PATH, [
      "-p",
      profile,
      launcher,
      "-c",
      NESTED_APPLY,
      "outer",
      inner(innerDenied),
      target,
    ], { env: { PATH: "/usr/bin:/bin" } });

  const baselineTarget = joinPath(outside, "baseline.txt");
  const baseline = await nested(base, spelled, baselineTarget);
  rec.info(
    "L1",
    "baseline_without_exemption",
    baseline.code !== 0 && baseline.stderr.includes("sandbox_apply")
      ? `reproduces #100: ${describeRun(baseline)}`
      : `did not reproduce #100: ${describeRun(baseline)}`,
  );
  const allowedTarget = joinPath(outside, "exempt-write.txt");
  const applied = await nested(exempt, spelled, allowedTarget);
  const appliedOk = applied.code === 0 &&
    await readOrNull(allowedTarget) === "ok";
  rec.check(
    "L1",
    "exempt_nested_apply",
    appliedOk,
    appliedOk
      ? "the exempted launcher applied its own sandbox and wrote outside the outer boundary"
      : describeRun(applied),
  );
  const deniedTarget = joinPath(innerDenied, "denied.txt");
  const innerRun = await nested(exempt, spelled, deniedTarget);
  rec.check(
    "L1",
    "inner_rule_holds",
    !await exists(deniedTarget),
    `the inner deny rule kept ${deniedTarget} absent (${
      describeRun(innerRun)
    })`,
  );
  const siblingTarget = joinPath(outside, "sibling.txt");
  const siblingRun = await io.run(SANDBOX_EXEC_PATH, [
    "-p",
    exempt,
    sibling,
    "-c",
    SHELL_WRITE,
    "probe",
    siblingTarget,
    "x",
  ]);
  rec.check(
    "L1",
    "sibling_stays_confined",
    !await exists(siblingTarget),
    `a non-exempted copy could not write outside (${describeRun(siblingRun)})`,
  );
  const hostOutside = joinPath(outside, "host.txt");
  const hostInside = joinPath(canonical, "tmp", "host-ok.txt");
  const hostRun = await io.run(SANDBOX_EXEC_PATH, [
    "-p",
    exempt,
    "/bin/sh",
    "-c",
    'printf x > "$1"; printf y > "$2"',
    "probe",
    hostOutside,
    hostInside,
  ]);
  rec.check(
    "L1",
    "host_stays_confined",
    !await exists(hostOutside) && await readOrNull(hostInside) === "y",
    `outside write denied and state/tmp writable (${describeRun(hostRun)})`,
  );
  if (appliedOk) return;
  // Diagnostics only: which spelling, if any, this macOS honours.
  const filters = exemption.literals.map((path) => `(literal ${sbpl(path)})`)
    .join(" ");
  const alternatives: [string, string, string][] = [
    [
      "modifier_last",
      `(allow process-exec ${filters} (with no-sandbox))`,
      spelled,
    ],
    [
      "process_exec_star",
      `(allow process-exec* (with no-sandbox) ${filters})`,
      spelled,
    ],
    [
      "real_path_only",
      `(allow process-exec (with no-sandbox) (literal ${sbpl(realBinary)}))`,
      spelled,
    ],
    ["launch_real_path", rule, realBinary],
  ];
  for (const [name, alternative, launcher] of alternatives) {
    const target = joinPath(outside, `alt-${name}.txt`);
    const run = await nested(`${base}\n${alternative}`, launcher, target);
    rec.info(
      "L1",
      `alternative_${name}`,
      run.code === 0 && await readOrNull(target) === "ok"
        ? `WORKS: ${alternative}`
        : `fails: ${describeRun(run)}`,
    );
  }
}

function emptySnapshot(now: number): RepairStateSnapshotV1 {
  return {
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: now,
    incidents: [],
    evidence: [],
    work: [],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  };
}

interface LifecycleRigV1 {
  state: string;
  /** Disposable HOME: its own opt-in and a link to the owner's real Codex. */
  home: string;
  revision: string;
  outside: string;
  results: string;
  pointerText: string;
}

/** Disposable state root with an empty state repo and one clean runtime. */
async function buildLifecycleRig(
  io: CheckIoV1,
  root: string,
  pre: PrerequisitesV1,
  model: boolean,
): Promise<LifecycleRigV1> {
  const l2 = joinPath(root, "l2");
  const state = joinPath(l2, "state");
  const home = joinPath(l2, "home");
  const runtimeSource = joinPath(l2, "runtime-source");
  const outsideDir = joinPath(l2, "outside");
  for (
    const dir of [
      state,
      runtimeSource,
      outsideDir,
      joinPath(home, ".codex", "bin"),
      joinPath(l2, "git-home"),
      joinPath(state, "runtimes"),
      joinPath(state, "checkouts", "macos-boundary"),
      joinPath(l2, "nonexempt"),
    ]
  ) {
    await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  }
  const env = {
    PATH: pre.path,
    HOME: joinPath(l2, "git-home"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = async (cwd: string, args: string[]): Promise<string> => {
    const run = await io.run(pre.git, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=macos-boundary-check",
      "-c",
      "user.email=macos-boundary-check@localhost",
      ...args,
    ], { cwd, env });
    if (run.code !== 0) {
      throw new Error(`git ${args[0]} failed: ${bounded(run.stderr)}`);
    }
    return run.stdout.trim();
  };
  // The owner's real Codex through the production launch spelling, and an
  // opt-in that exists only here: the owner's own opt-in is never created.
  await link(io, pre.real, joinPath(home, ...CODEX_EXECUTABLE_SEGMENTS));
  await writeOptIn(home);
  await git(l2, ["init", "-q", "--bare", joinPath(state, "state.git")]);
  const written = await createRepairStateStore({
    scratchDir: joinPath(l2, "seed-scratch"),
    remoteUrl: joinPath(state, "state.git"),
  }).writeRepair(emptySnapshot(Date.now()), null);
  if (!written.ok || written.value.status !== "applied") {
    throw new Error("the empty repair state could not be seeded");
  }
  await git(joinPath(state, "checkouts", "macos-boundary"), ["init", "-q"]);
  const outside = joinPath(outsideDir, "protected.txt");
  await Deno.writeTextFile(outside, OUTSIDE_TEXT, { mode: 0o600 });
  let nonExemptCodex: string | null = joinPath(l2, "nonexempt", "codex");
  try {
    await copyExecutable(pre.real, nonExemptCodex);
  } catch {
    nonExemptCodex = null;
  }
  const results = joinPath(state, "tmp", "host", "macos-boundary-results.json");
  const configPath = joinPath(l2, "fixture-config.json");
  const config: BoundaryFixtureConfigV1 = {
    stateRoot: state,
    outsideFile: outside,
    nonExemptCodex,
    resultsPath: results,
    model,
  };
  await Deno.writeTextFile(configPath, JSON.stringify(config) + "\n");
  const fixture = decodeURIComponent(
    new URL("./macos-boundary-child.ts", import.meta.url).pathname,
  );
  const task = [
    `'${Deno.execPath()}'`,
    "run --no-config --no-lock --allow-read --allow-write --allow-run",
    "--allow-env --allow-net=127.0.0.1:8000",
    `'${fixture}'`,
    `'${configPath}'`,
  ].join(" ");
  await Deno.writeTextFile(
    joinPath(runtimeSource, "deno.json"),
    JSON.stringify({ lock: false, tasks: { "repair:run": task } }, null, 2) +
      "\n",
  );
  await git(runtimeSource, ["init", "-q"]);
  await git(runtimeSource, ["add", "deno.json"]);
  await git(runtimeSource, ["commit", "-q", "-m", "macos boundary fixture"]);
  const revision = await git(runtimeSource, ["rev-parse", "HEAD"]);
  const runtime = joinPath(state, "runtimes", revision);
  await git(l2, ["clone", "-q", "--no-hardlinks", runtimeSource, runtime]);
  await git(runtime, ["checkout", "-q", "--detach", revision]);
  const pointerText = JSON.stringify({
    version: "v1",
    kind: "local_active_runtime",
    revision,
  }) + "\n";
  await Deno.writeTextFile(
    joinPath(state, "active-runtime.json"),
    pointerText,
    {
      mode: 0o600,
    },
  );
  return { state, home, revision, outside, results, pointerText };
}

/** L2 (and L3 when requested): the real supervisor lifecycle. */
async function checkLifecycle(
  io: CheckIoV1,
  rec: Recorder,
  root: string,
  pre: PrerequisitesV1,
  model: boolean,
): Promise<void> {
  const unsafe = [root, Deno.execPath(), import.meta.url].find((text) =>
    // deno-lint-ignore no-control-regex
    /['\x00-\x1f\x7f]/.test(decodeURIComponent(text))
  );
  if (
    !rec.check(
      "L2",
      "paths_quotable",
      unsafe === undefined,
      unsafe === undefined
        ? "repository and Deno paths can be quoted in the fixture task"
        : `a path contains a quote or control character: ${unsafe}`,
    )
  ) {
    return;
  }
  const modelToken = io.env("UOS_AI_TOKEN") ?? "";
  if (
    model &&
    !rec.check(
      "L3",
      "model_token",
      modelToken.length > 0,
      "UOS_AI_TOKEN is set",
    )
  ) {
    return;
  }
  const rig = await buildLifecycleRig(io, root, pre, model);
  rec.info(
    "L2",
    "rig",
    `disposable state root ${rig.state}, runtime ${rig.revision}`,
  );
  rec.info(
    "L2",
    "rig_home",
    `disposable HOME ${rig.home} with its own opt-in; .codex/bin/codex -> ${pre.real}`,
  );
  const result = await runLocalSupervisor({
    stateRoot: rig.state,
    env: {
      HOME: rig.home,
      PATH: pre.path,
      GITHUB_TOKEN: DUMMY_GITHUB_TOKEN,
      UOS_AI_TOKEN: model ? modelToken : DUMMY_MODEL_TOKEN,
    },
    denoExecutable: Deno.execPath(),
  });
  rec.check(
    "L2",
    "supervisor_idle",
    result.status === "idle" && result.activeRevision === rig.revision,
    JSON.stringify(result),
  );
  const logDir = joinPath(rig.state, "supervisor-logs");
  const logs: string[] = [];
  try {
    for await (const entry of Deno.readDir(logDir)) {
      if (entry.name.startsWith(`child-${rig.revision}-`)) {
        logs.push(entry.name);
      }
    }
  } catch {
    // reported below
  }
  const logPath = logs.length === 1 ? joinPath(logDir, logs[0]) : null;
  const logText = logPath === null ? "" : await readOrNull(logPath) ?? "";
  const firstLine = logText.split("\n")[0] ?? "";
  rec.check(
    "L2",
    "exemption_applied",
    firstLine === "codex-exemption: applied",
    logPath === null
      ? `expected exactly one child log, found ${logs.length}`
      : firstLine,
  );
  const resultsText = await readOrNull(rig.results);
  let fixture: BoundaryFixtureResultsV1 | null = null;
  try {
    fixture = resultsText === null ? null : JSON.parse(resultsText);
  } catch {
    fixture = null;
  }
  if (
    !rec.check(
      "L2",
      "fixture_results",
      fixture !== null && Array.isArray(fixture.probes),
      fixture === null
        ? `no fixture results; child log ${logPath ?? "missing"}: ${
          bounded(logText.slice(-DETAIL_CAP))
        }`
        : `${fixture.probes.length} probes from the real child`,
    ) || fixture === null
  ) {
    return;
  }
  for (const probe of fixture.probes) {
    const level: CheckLevelV1 = probe.name.startsWith("model_") ? "L3" : "L2";
    if (probe.gating) rec.check(level, probe.name, probe.ok, probe.detail);
    else rec.info(level, probe.name, probe.detail);
  }
  rec.check(
    "L2",
    "pointer_bytes_unchanged",
    await readOrNull(joinPath(rig.state, "active-runtime.json")) ===
      rig.pointerText,
    "host readback of active-runtime.json",
  );
  rec.check(
    "L2",
    "outside_bytes_unchanged",
    await readOrNull(rig.outside) === OUTSIDE_TEXT,
    "host readback of the outside file",
  );
  rec.check(
    "L2",
    "runner_lock_released",
    await probeRunnerLock(rig.state),
    "runner.lock can be acquired after the child settled",
  );
  rec.check(
    "L2",
    "session_marker_absent",
    !await localSessionMarkerExists(rig.state),
    "session-active.json is gone",
  );
  rec.check(
    "L2",
    "child_log_clean",
    logText.length > 0 && !logText.includes("sandbox_apply"),
    logPath ?? "no child log",
  );
  if (!model) {
    rec.add({
      level: "L3",
      name: "model_turn",
      status: "SKIP",
      detail: "run with --model to add one real model turn",
    });
  }
}

/** Remove every client token file the fixture wrote (never kept on disk). */
async function scrubTokens(root: string): Promise<void> {
  const clients = joinPath(root, "l2", "state", "clients");
  try {
    for await (const entry of Deno.readDir(clients)) {
      await Deno.remove(joinPath(clients, entry.name, "model.token")).catch(
        () => {},
      );
    }
  } catch {
    // no client was created
  }
}

export async function runMacosBoundaryCheck(
  args: readonly string[],
  io: CheckIoV1,
): Promise<number> {
  const parsed = parseCheckArgs(args);
  if (!parsed.ok) {
    for (const line of HELP_LINES) io.print(line);
    io.print(`RESULT: FAIL usage: ${parsed.error}`);
    return 2;
  }
  if (parsed.value.help) {
    for (const line of HELP_LINES) io.print(line);
    return 0;
  }
  if (io.os !== "darwin") {
    io.print(
      `RESULT: UNSUPPORTED this check runs only on macOS (this host is ${io.os}); nothing was run`,
    );
    return 2;
  }
  const rec = new Recorder(io);
  const root = joinPath(
    await Deno.realPath(io.cwd),
    `.macos-boundary-check-${crypto.randomUUID()}`,
  );
  await Deno.mkdir(root, { mode: 0o700 });
  try {
    const pre = await checkPrerequisites(io, rec, root);
    if (pre !== null) {
      await checkSeatbelt(io, rec, root);
      await checkLifecycle(io, rec, root, pre, parsed.value.model);
    }
  } catch (error) {
    rec.add({
      level: "L2",
      name: "unexpected_error",
      status: "FAIL",
      detail: bounded(error instanceof Error ? error.stack ?? error : error),
    });
  }
  await scrubTokens(root);
  const verdict = checkVerdict(rec.steps);
  for (const line of resultLines(verdict)) rec.print(line);
  const report = joinPath(root, "report.txt");
  if (verdict.result === "PASS" && !parsed.value.keep) {
    for (const name of ["l1", "l2", "resolver-state"]) {
      await Deno.remove(joinPath(root, name), { recursive: true }).catch(
        () => {},
      );
    }
  }
  rec.print(`REPORT: ${report}`);
  await Deno.writeTextFile(report, rec.lines.join("\n") + "\n").catch(() => {});
  return verdict.exitCode;
}

/** The real platform effects; every subprocess is bounded and env-cleared. */
export function realCheckIo(): CheckIoV1 {
  return {
    os: Deno.build.os,
    cwd: Deno.cwd(),
    env: (name) => Deno.env.get(name),
    print: (line) => console.log(line),
    run: async (command, args, options = {}) => {
      const child = new Deno.Command(command, {
        args,
        cwd: options.cwd,
        clearEnv: true,
        env: options.env ?? { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already exited
        }
      }, options.timeoutMs ?? RUN_TIMEOUT_MS);
      try {
        const output = await child.output();
        return {
          code: output.signal === null ? output.code : null,
          stdout: new TextDecoder().decode(output.stdout),
          stderr: new TextDecoder().decode(output.stderr),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

if (import.meta.main) {
  Deno.exit(await runMacosBoundaryCheck(Deno.args, realCheckIo()));
}
