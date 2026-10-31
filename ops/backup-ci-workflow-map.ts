/**
 * The v1 supported workflow shape (docs/backup-ci-spec.md §5). Pure: it reads
 * a workflow blob's bytes (as `git cat-file` returned them in the trusted
 * job), never runs anything, and maps one never-started check name to the
 * exact (job, matrix combination) and planned main steps a leg runs.
 *
 * `readBackupCiWorkflow` applies the workflow-level rules and renders every
 * job's check names the way GitHub does (`name ?? key`, with ` (v1, v2, …)`
 * appended in axis order when the name has no matrix expression); the names
 * are the coverage row's `expected`. `planBackupCiJob` applies the target
 * job and step rules. Every refusal is one `BackupCiUnsupportedV1` reason,
 * final per commit because the blob is fixed at the commit.
 *
 * YAML is parsed with `@std/yaml`'s core schema (no merge keys, no custom
 * tags, duplicate keys refused) after a 256 KiB bound; any object reached
 * twice means an alias and is refused, and at most 20,000 nodes are walked.
 */
import { parse } from "@std/yaml";
import {
  BACKUP_CI_CHECK_NAME_PATTERN,
  BACKUP_CI_MAX_FILE_BYTES,
  BACKUP_CI_MAX_JOB_MINUTES,
  type BackupCiMatrixV1,
  type BackupCiPlannedStepV1,
  type BackupCiRunsOnV1,
  type BackupCiUnsupportedV1,
} from "../src/contracts/backup-ci.ts";
import {
  checkTemplate,
  expressionBodies,
  runTextReference,
  stepCondition,
} from "./backup-ci-expressions.ts";

export const BACKUP_CI_MAX_WORKFLOW_NODES = 20_000;
export const BACKUP_CI_MAX_COMBINATIONS = 16;
export const BACKUP_CI_MAX_EXPECTED = 64;
export const BACKUP_CI_MAX_STEPS = 100;
export const BACKUP_CI_RUNS_ON: readonly BackupCiRunsOnV1[] = [
  "ubuntu-latest",
  "ubuntu-24.04",
  "ubuntu-22.04",
];
/** act reads these at the tree root (§5 tree rule, A1). */
export const BACKUP_CI_ROOT_CONFIG_FILES = [
  ".actrc",
  ".env",
  ".secrets",
  ".vars",
  ".input",
] as const;
export const BACKUP_CI_WORKFLOW_PATH_RE =
  /^\.github\/workflows\/[A-Za-z0-9._-]{1,64}\.ya?ml$/;

type Obj = Record<string, unknown>;
type Reason = BackupCiUnsupportedV1;

const WORKFLOW_KEYS = new Set([
  "name",
  "run-name",
  "on",
  "permissions",
  "env",
  "defaults",
  "concurrency",
  "jobs",
]);
const JOB_KEYS = new Set([
  "name",
  "runs-on",
  "timeout-minutes",
  "steps",
  "strategy",
  "env",
  "defaults",
  "permissions",
  "concurrency",
  "outputs",
  "continue-on-error",
]);
const STEP_KEYS = new Set([
  "id",
  "name",
  "run",
  "uses",
  "with",
  "env",
  "if",
  "shell",
  "working-directory",
  "continue-on-error",
  "timeout-minutes",
]);
const CHECKOUT_KEYS = new Set([
  "persist-credentials",
  "clean",
  "show-progress",
  "fetch-depth",
  "submodules",
  "lfs",
]);
const JOB_KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/;
const STEP_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/;
const AXIS_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const PRINTABLE_RE = /^[\x20-\x7e]{1,256}$/;
const USES_LOCAL_RE = /^\.\/[A-Za-z0-9._/-]{0,254}$/;
const USES_REMOTE_RE =
  /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}(?:\/[A-Za-z0-9._/-]{1,200})?@[A-Za-z0-9._/-]{1,128}$/;

const isMap = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isScalar = (value: unknown) =>
  typeof value === "string" || typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

/**
 * Parses bounded YAML with the core schema; null when it is too large, not
 * UTF-8, does not parse, uses an alias, or has more than `maxNodes` nodes.
 */
export function parseBoundedYaml(
  bytes: Uint8Array,
  maxBytes: number = BACKUP_CI_MAX_FILE_BYTES,
  maxNodes: number = BACKUP_CI_MAX_WORKFLOW_NODES,
): unknown | null {
  if (bytes.length > maxBytes) return null;
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = parse(text, { schema: "core" });
  } catch {
    return null;
  }
  const seen = new Set<object>();
  let nodes = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (++nodes > maxNodes) return null;
    if (typeof node !== "object" || node === null) continue;
    if (seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) stack.push(...node);
    else stack.push(...Object.values(node as Obj));
  }
  return value;
}

export interface BackupCiRenderedNameV1 {
  jobKey: string;
  matrix: BackupCiMatrixV1;
  checkName: string;
}
export type BackupCiWorkflowV1 =
  | { ok: false; reason: Reason }
  | {
    ok: true;
    path: string;
    name: string;
    jobs: Record<string, Obj>;
    /** Every rendered check name, in job then combination order. */
    rendered: BackupCiRenderedNameV1[];
    /** Workflow-level `env`/`defaults` already checked. */
  };

type Combination = [string, string | number | boolean][];

/** The matrix combinations of a job (null: no matrix), or the refusal. */
function combinations(strategy: unknown): Combination[] | null | Reason {
  if (strategy === undefined) return null;
  if (!isMap(strategy)) return "matrix_shape";
  for (const [key, value] of Object.entries(strategy)) {
    if (key === "fail-fast" && typeof value === "boolean") continue;
    if (
      key === "max-parallel" && typeof value === "number" &&
      Number.isSafeInteger(value) && value > 0
    ) continue;
    if (key !== "matrix") return "matrix_shape";
  }
  const matrix = strategy.matrix;
  if (matrix === undefined) return null;
  if (!isMap(matrix)) return "matrix_shape";
  const axes = Object.entries(matrix);
  if (axes.length === 0 || axes.length > 8) return "matrix_shape";
  let combos: Combination[] = [[]];
  for (const [axis, values] of axes) {
    if (
      !AXIS_RE.test(axis) || axis === "include" || axis === "exclude" ||
      !Array.isArray(values) || values.length === 0
    ) return "matrix_shape";
    for (const value of values) {
      if (
        !isScalar(value) ||
        (typeof value === "string" &&
          (value.includes("${{") || value.length > 256))
      ) return "matrix_shape";
    }
    const next: Combination[] = [];
    for (const combo of combos) {
      for (const value of values as (string | number | boolean)[]) {
        next.push([...combo, [axis, value]]);
      }
    }
    combos = next;
    if (combos.length > BACKUP_CI_MAX_COMBINATIONS) return "matrix_shape";
  }
  return combos;
}

/** GitHub's rendering of one job's check name for one combination. */
function renderName(
  key: string,
  name: unknown,
  combo: Combination | null,
): string | null {
  const suffix = combo === null || combo.length === 0
    ? ""
    : ` (${combo.map(([, v]) => String(v)).join(", ")})`;
  if (name === undefined) return `${key}${suffix}`;
  if (typeof name !== "string" || name.length === 0) return null;
  const bodies = expressionBodies(name);
  if (bodies === null) return null;
  if (bodies.length === 0) return `${name}${suffix}`;
  const values = new Map(combo ?? []);
  let rendered = "";
  let at = 0;
  for (const body of bodies) {
    const start = name.indexOf("${{", at);
    const match = /^\s*matrix\.([A-Za-z_][A-Za-z0-9_-]*)\s*$/.exec(body);
    if (match === null || !values.has(match[1])) return null;
    rendered += name.slice(at, start) + String(values.get(match[1]));
    at = start + 3 + body.length + 2;
  }
  return rendered + name.slice(at);
}

function matrixRecord(combo: Combination | null): BackupCiMatrixV1 {
  return combo === null || combo.length === 0
    ? null
    : Object.fromEntries(combo);
}

/** The refusal of an `env` mapping's names and templates, or null. */
function envRefusal(env: unknown): Reason | null {
  if (env === undefined) return null;
  if (!isMap(env)) return "step_shape";
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME_RE.test(name) || !(isScalar(value) || value === null)) {
      return "step_shape";
    }
    const refusal = checkTemplate(value);
    if (refusal !== null) return refusal;
  }
  return null;
}

function defaultsRefusal(defaults: unknown): Reason | null {
  if (defaults === undefined) return null;
  if (!isMap(defaults)) return "step_shape";
  for (const [key, value] of Object.entries(defaults)) {
    if (key !== "run" || !isMap(value)) return "step_shape";
    for (const [field, text] of Object.entries(value)) {
      if (
        (field !== "shell" && field !== "working-directory") ||
        typeof text !== "string"
      ) return "step_shape";
      const refusal = checkTemplate(text);
      if (refusal !== null) return refusal;
    }
  }
  return null;
}

/** The workflow-level rules and every job's rendered check names. */
export function readBackupCiWorkflow(
  path: string,
  mode: string,
  bytes: Uint8Array,
): BackupCiWorkflowV1 {
  if (!BACKUP_CI_WORKFLOW_PATH_RE.test(path)) {
    return { ok: false, reason: "workflow_path" };
  }
  if (mode !== "100644") return { ok: false, reason: "workflow_unreadable" };
  const root = parseBoundedYaml(bytes);
  if (!isMap(root) || !isMap(root.jobs)) {
    return { ok: false, reason: "workflow_unreadable" };
  }
  if (Object.keys(root).some((key) => !WORKFLOW_KEYS.has(key))) {
    return { ok: false, reason: "workflow_unreadable" };
  }
  const name = root.name === undefined ? path : root.name;
  if (typeof name !== "string" || !PRINTABLE_RE.test(name)) {
    return { ok: false, reason: "workflow_unreadable" };
  }
  const level = envRefusal(root.env) ?? defaultsRefusal(root.defaults);
  if (level !== null) return { ok: false, reason: level };
  const jobs: Record<string, Obj> = {};
  const entries = Object.entries(root.jobs);
  if (entries.length === 0) return { ok: false, reason: "workflow_unreadable" };
  for (const [key, job] of entries) {
    if (!JOB_KEY_RE.test(key) || !isMap(job)) {
      return { ok: false, reason: "workflow_unreadable" };
    }
    if ("needs" in job || "if" in job) {
      return { ok: false, reason: "needs_or_job_if" };
    }
    if ("uses" in job) return { ok: false, reason: "reusable" };
    jobs[key] = job;
  }
  const rendered: BackupCiRenderedNameV1[] = [];
  for (const [key, job] of Object.entries(jobs)) {
    const combos = combinations(job.strategy);
    if (typeof combos === "string") return { ok: false, reason: combos };
    for (const combo of combos ?? [null]) {
      const checkName = renderName(key, job.name, combo);
      if (checkName === null) return { ok: false, reason: "job_name" };
      rendered.push({ jobKey: key, matrix: matrixRecord(combo), checkName });
    }
  }
  if (new Set(rendered.map((r) => r.checkName)).size > BACKUP_CI_MAX_EXPECTED) {
    return { ok: false, reason: "coverage" };
  }
  return { ok: true, path, name, jobs, rendered };
}

/** Every distinct rendered name of a readable workflow (coverage). */
export function backupCiExpected(workflow: BackupCiWorkflowV1): string[] {
  return workflow.ok
    ? [...new Set(workflow.rendered.map((r) => r.checkName))]
    : [];
}

/** Whether the tree root holds a file act would read as configuration. */
export function rootConfigFile(rootNames: readonly string[]): boolean {
  return rootNames.some((name) =>
    (BACKUP_CI_ROOT_CONFIG_FILES as readonly string[]).includes(name)
  );
}

export interface BackupCiJobPlanV1 {
  job: {
    key: string;
    matrix: BackupCiMatrixV1;
    checkName: string;
    runsOn: BackupCiRunsOnV1;
    capMinutes: number;
    targetTimeoutMinutes: number | null;
  };
  steps: BackupCiPlannedStepV1[];
  /** Actions to resolve before planning (`backup-ci-actions.ts`). */
  uses: { remote: string[]; local: string[] };
}

function checkoutRefusal(withInputs: Obj | undefined): Reason | null {
  for (const [key, value] of Object.entries(withInputs ?? {})) {
    if (!CHECKOUT_KEYS.has(key)) return "checkout_inputs";
    if (key === "fetch-depth" && value !== 1 && value !== "1") {
      return "checkout_inputs";
    }
    if (
      (key === "submodules" || key === "lfs") && value !== false &&
      value !== "false"
    ) return "checkout_inputs";
  }
  return null;
}

function stepRefusal(
  step: unknown,
  index: number,
): Reason | {
  planned: BackupCiPlannedStepV1;
  remote?: string;
  local?: string;
} {
  if (!isMap(step) || Object.keys(step).some((k) => !STEP_KEYS.has(k))) {
    return "step_shape";
  }
  if (("run" in step) === ("uses" in step)) return "step_shape";
  if (
    step.id !== undefined &&
    (typeof step.id !== "string" || !STEP_ID_RE.test(step.id))
  ) return "step_shape";
  for (const field of ["name", "shell", "working-directory"]) {
    const value = step[field];
    if (value === undefined) continue;
    if (typeof value !== "string") return "step_shape";
    const refusal = checkTemplate(value);
    if (refusal !== null) return refusal;
  }
  const envReason = envRefusal(step.env);
  if (envReason !== null) return envReason;
  const condition = stepCondition(step.if);
  if (condition === null) return "step_condition";
  const coe = step["continue-on-error"];
  if (coe !== undefined && typeof coe !== "boolean") return "step_shape";
  const timeout = step["timeout-minutes"];
  if (
    timeout !== undefined &&
    (typeof timeout !== "number" || !Number.isSafeInteger(timeout) ||
      timeout < 1 || timeout > 360)
  ) return "timeout";
  const withInputs = step.with;
  if (withInputs !== undefined) {
    if (!isMap(withInputs) || "run" in step) return "step_shape";
    for (const value of Object.values(withInputs)) {
      if (!(isScalar(value) || value === null)) return "step_shape";
      const refusal = checkTemplate(value);
      if (refusal !== null) return refusal;
    }
  }
  const base = {
    index,
    actStepId: typeof step.id === "string" ? step.id : String(index),
    condition,
    continueOnError: coe === true,
  };
  if ("run" in step) {
    if (typeof step.run !== "string" || step.run.length === 0) {
      return "step_shape";
    }
    const refusal = checkTemplate(step.run);
    if (refusal !== null) return refusal;
    if (runTextReference(step.run)) return "context_reference";
    return { planned: { ...base, kind: "run", uses: null } };
  }
  const uses = step.uses;
  if (typeof uses !== "string") return "step_shape";
  if (uses.startsWith("docker://")) return "docker_action";
  if (uses.includes("${{")) return "expression_context";
  if (uses.startsWith("./")) {
    if (!USES_LOCAL_RE.test(uses) || uses.split("/").includes("..")) {
      return "step_shape";
    }
    return {
      planned: { ...base, kind: "uses_local", uses },
      local: uses,
    };
  }
  if (!USES_REMOTE_RE.test(uses)) return "step_shape";
  if (/^actions\/checkout@/i.test(uses)) {
    const refusal = checkoutRefusal(withInputs as Obj | undefined);
    if (refusal !== null) return refusal;
  }
  return { planned: { ...base, kind: "uses_remote", uses }, remote: uses };
}

/**
 * The (job, combination) whose rendered name is `checkName` and its planned
 * main steps, or the refusal. Exactly one rendering may match.
 */
export function planBackupCiJob(
  workflow: BackupCiWorkflowV1,
  checkName: string,
): { ok: true; plan: BackupCiJobPlanV1 } | { ok: false; reason: Reason } {
  if (!workflow.ok) return workflow;
  const matches = workflow.rendered.filter((r) => r.checkName === checkName);
  if (matches.length !== 1 || !BACKUP_CI_CHECK_NAME_PATTERN.test(checkName)) {
    return { ok: false, reason: "name_unmapped" };
  }
  const target = matches[0];
  const job = workflow.jobs[target.jobKey];
  if ("services" in job) return { ok: false, reason: "services" };
  if ("container" in job) return { ok: false, reason: "container" };
  if ("environment" in job) return { ok: false, reason: "environment" };
  if (Object.keys(job).some((key) => !JOB_KEYS.has(key))) {
    return { ok: false, reason: "step_shape" };
  }
  const runsOn = job["runs-on"];
  if (
    typeof runsOn !== "string" ||
    !(BACKUP_CI_RUNS_ON as readonly string[]).includes(runsOn)
  ) return { ok: false, reason: "runs_on" };
  const timeout = job["timeout-minutes"];
  if (
    timeout !== undefined &&
    (typeof timeout !== "number" || !Number.isSafeInteger(timeout) ||
      timeout < 1 || timeout > 360)
  ) return { ok: false, reason: "timeout" };
  const coe = job["continue-on-error"];
  if (coe !== undefined && coe !== false) {
    return { ok: false, reason: "step_shape" };
  }
  const jobLevel = envRefusal(job.env) ?? defaultsRefusal(job.defaults);
  if (jobLevel !== null) return { ok: false, reason: jobLevel };
  if (job.outputs !== undefined) {
    if (!isMap(job.outputs)) return { ok: false, reason: "step_shape" };
    for (const value of Object.values(job.outputs)) {
      if (typeof value !== "string") return { ok: false, reason: "step_shape" };
      const refusal = checkTemplate(value);
      if (refusal !== null) return { ok: false, reason: refusal };
    }
  }
  const steps = job.steps;
  if (
    !Array.isArray(steps) || steps.length === 0 ||
    steps.length > BACKUP_CI_MAX_STEPS
  ) return { ok: false, reason: "step_shape" };
  const planned: BackupCiPlannedStepV1[] = [];
  const remote = new Set<string>();
  const local = new Set<string>();
  for (let index = 0; index < steps.length; index++) {
    const step = stepRefusal(steps[index], index);
    if (typeof step === "string") return { ok: false, reason: step };
    planned.push(step.planned);
    if (step.remote !== undefined) remote.add(step.remote);
    if (step.local !== undefined) local.add(step.local);
  }
  if (new Set(planned.map((s) => s.actStepId)).size !== planned.length) {
    return { ok: false, reason: "step_shape" };
  }
  const targetTimeoutMinutes = typeof timeout === "number" ? timeout : null;
  return {
    ok: true,
    plan: {
      job: {
        key: target.jobKey,
        matrix: target.matrix,
        checkName,
        runsOn: runsOn as BackupCiRunsOnV1,
        capMinutes: Math.min(
          targetTimeoutMinutes ?? 360,
          BACKUP_CI_MAX_JOB_MINUTES,
        ),
        targetTimeoutMinutes,
      },
      steps: planned,
      uses: { remote: [...remote].sort(), local: [...local].sort() },
    },
  };
}
