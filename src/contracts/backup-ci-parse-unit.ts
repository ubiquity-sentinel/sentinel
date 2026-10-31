/**
 * Fail-closed parsers of the backup CI unit and leg result
 * (docs/backup-ci-spec.md §6.1), and the field parsers the store parsers
 * (`backup-ci-parse.ts`) share: closed keys, bounded arrays and strings, and
 * the cross-field bindings each record must satisfy. Every parser throws
 * `RecordParseError` on the first violation; messages never echo input
 * values. The exported field parsers are internal to the backup CI contract.
 *
 * Module-cycle note: `backup-ci.ts` re-exports these parsers, so this module
 * reads that module's values only inside functions, never at load time.
 */
import { canonicalStringify } from "./canonical.ts";
import {
  BACKUP_CI_CHECK_NAME_PATTERN,
  BACKUP_CI_LEG_RAN_REASONS,
  BACKUP_CI_MAX_EVENT_BYTES,
  BACKUP_CI_MAX_JOB_MINUTES,
  BACKUP_CI_NO_LEG_REASONS,
  BACKUP_CI_UNSUPPORTED,
  type BackupCiConclusionV1,
  type BackupCiEntryKeyV1,
  type BackupCiMatrixV1,
  type BackupCiNoEvidenceReasonV1,
  type BackupCiPlannedStepV1,
  type BackupCiResultV1,
  backupCiUnitId,
  type BackupCiUnitV1,
  noEvidenceLegRan,
} from "./backup-ci.ts";
import {
  expectArray,
  expectBoolean,
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNullable,
  expectPattern,
  expectRecord,
  expectSha256Hex,
  expectString,
  fail,
} from "./validation.ts";

export type Obj = Record<string, unknown>;

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
export const REPO_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
export const WORKFLOW_PATH_RE =
  /^\.github\/workflows\/[A-Za-z0-9._-]{1,64}\.ya?ml$/;
export const HEX16_RE = /^[0-9a-f]{16}$/;
const HEX24_RE = /^[0-9a-f]{24}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/+-]{0,254}$/;
export const JOB_KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/;
const STEP_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const AXIS_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const IMAGE_RE = /^[A-Za-z0-9._-]{1,32}$/;
const USES_LOCAL_RE = /^\.\/[A-Za-z0-9._/-]{0,254}$/;
const USES_REMOTE_RE =
  /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}(?:\/[A-Za-z0-9._/-]{1,200})?@[A-Za-z0-9._/-]{1,128}$/;
export const RECEIPT_RE = /^bci1:[\x20-\x7e]{1,1019}$/;
const PRINTABLE_RE = /^[\x20-\x7e]{1,256}$/;
export const NATIVE_CONCLUSIONS = [
  "success",
  "failure",
  "cancelled",
  "skipped",
  "timed_out",
  "neutral",
  "action_required",
  "stale",
] as const;
const CONCLUSIONS: readonly BackupCiConclusionV1[] = [
  "success",
  "failure",
  "timed_out",
];
const EVENT_KEYS = {
  pull_request: ["action", "number", "pull_request", "repository", "sender"],
  push: [
    "ref",
    "before",
    "after",
    "repository",
    "pusher",
    "sender",
    "head_commit",
  ],
} as const;

/** A plain object with exactly `keys` (space-separated). */
export function obj(value: unknown, path: string, keys: string): Obj {
  const record = expectRecord(value, path);
  expectExactKeys(record, keys.split(" "), path);
  return record;
}

export function text(
  value: unknown,
  path: string,
  re: RegExp,
  max = 256,
): string {
  return expectPattern(value, path, re, "invalid_pattern", "unexpected", max);
}

export function int(
  value: unknown,
  path: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < min ||
    value > max
  ) fail(path, "invalid_count", `expected integer in [${min}, ${max}]`);
  return value;
}

export const id = (value: unknown, path: string) =>
  int(value, path, 1, Number.MAX_SAFE_INTEGER);
export const count = (value: unknown, path: string) =>
  int(value, path, 0, Number.MAX_SAFE_INTEGER);
export const shas = (value: unknown, path: string, max: number) =>
  expectArray(value, path, max, expectGitSha);
export const checkName = (value: unknown, path: string) =>
  text(value, path, BACKUP_CI_CHECK_NAME_PATTERN, 64);

export function literal<T>(value: unknown, path: string, expected: T): T {
  if (value !== expected) fail(path, "invalid_value", "unexpected literal");
  return expected;
}

export function check(ok: boolean, path: string, message: string): void {
  if (!ok) fail(path, "invalid_value", message);
}

export function conclusion(value: unknown, path: string): BackupCiConclusionV1 {
  return expectEnum(value, CONCLUSIONS, path);
}

export function nativeRun(value: unknown, path: string) {
  return expectNullable(value, path, (item, at) => {
    const o = obj(item, at, "checkRunId conclusion");
    return {
      checkRunId: id(o.checkRunId, `${at}.checkRunId`),
      conclusion: expectEnum(
        o.conclusion,
        NATIVE_CONCLUSIONS,
        `${at}.conclusion`,
      ) as string,
    };
  });
}

export function repository(value: unknown, path: string) {
  const o = obj(value, path, "owner name id");
  return {
    owner: text(o.owner, `${path}.owner`, OWNER_RE),
    name: text(o.name, `${path}.name`, NAME_RE),
    id: id(o.id, `${path}.id`),
  };
}

export function matrix(value: unknown, path: string): BackupCiMatrixV1 {
  return expectNullable(value, path, (item, at) => {
    const o = expectRecord(item, at);
    const keys = Object.keys(o);
    check(keys.length >= 1 && keys.length <= 8, at, "matrix axis bound");
    const out: Record<string, string | number | boolean> = {};
    for (const axis of keys) {
      text(axis, `${at}.<axis>`, AXIS_RE, 64);
      const v = o[axis];
      if (typeof v === "string") expectString(v, `${at}.${axis}`, 256);
      else if (typeof v === "number") check(Number.isFinite(v), at, "finite");
      else if (typeof v !== "boolean") fail(at, "wrong_type", "scalar axis");
      out[axis] = v as string | number | boolean;
    }
    return out;
  });
}

/** A JSON-only copy of the event payload, bounded in canonical bytes. */
function copyEvent(event: Obj, path: string): Record<string, unknown> {
  let canonical: string;
  try {
    canonical = canonicalStringify(event);
  } catch {
    return fail(path, "wrong_type", "event is not plain JSON");
  }
  check(
    new TextEncoder().encode(canonical).length <= BACKUP_CI_MAX_EVENT_BYTES,
    path,
    "event bound",
  );
  return JSON.parse(canonical);
}

export function parseKey(value: unknown, path: string): BackupCiEntryKeyV1 {
  const o = obj(value, path, "context workflowPath checkName base attempt");
  const context = expectEnum(o.context, ["push", "pull_request"], path);
  const base = expectNullable(o.base, `${path}.base`, expectGitSha);
  check((context === "pull_request") === (base !== null), path, "base");
  if (o.attempt !== 1 && o.attempt !== 2) {
    fail(`${path}.attempt`, "invalid_value", "attempt is 1 or 2");
  }
  return {
    context,
    workflowPath: text(
      o.workflowPath,
      `${path}.workflowPath`,
      WORKFLOW_PATH_RE,
    ),
    checkName: checkName(o.checkName, `${path}.checkName`),
    base,
    attempt: o.attempt,
  };
}

export function parseNoEvidenceReason(
  value: unknown,
  path: string,
): BackupCiNoEvidenceReasonV1 {
  const raw = expectString(value, path, 64);
  const ok = raw.startsWith("unsupported:")
    ? (BACKUP_CI_UNSUPPORTED as readonly string[]).includes(raw.slice(12))
    : (BACKUP_CI_NO_LEG_REASONS as readonly string[]).includes(raw) ||
      (BACKUP_CI_LEG_RAN_REASONS as readonly string[]).includes(raw);
  if (!ok) fail(path, "invalid_enum", "unknown no-evidence reason");
  return raw as BackupCiNoEvidenceReasonV1;
}

function parseStep(value: unknown, path: string): BackupCiPlannedStepV1 {
  const o = obj(
    value,
    path,
    "index actStepId kind uses condition continueOnError",
  );
  const kind = expectEnum(o.kind, ["run", "uses_local", "uses_remote"], path);
  const uses = kind === "run" ? literal(o.uses, `${path}.uses`, null) : text(
    o.uses,
    `${path}.uses`,
    kind === "uses_local" ? USES_LOCAL_RE : USES_REMOTE_RE,
  );
  return {
    index: int(o.index, `${path}.index`, 0, 999),
    actStepId: text(o.actStepId, `${path}.actStepId`, STEP_ID_RE),
    kind,
    uses,
    condition: expectEnum(o.condition, ["none", "status_only"], path),
    continueOnError: expectBoolean(
      o.continueOnError,
      `${path}.continueOnError`,
    ),
  };
}

export function parseUnitAt(value: unknown, path: string): BackupCiUnitV1 {
  const o = obj(
    value,
    path,
    "version kind unitId purpose key repository commit exec pullRequest ref workflow job steps event neverStarted native plan",
  );
  literal(o.version, `${path}.version`, 1);
  literal(o.kind, `${path}.kind`, "sentinel_backup_ci_unit");
  const key = parseKey(o.key, `${path}.key`);
  const purpose = expectEnum(
    o.purpose,
    ["stand_in", "confirm", "peer", "calibration"],
    `${path}.purpose`,
  );
  check((purpose === "confirm") === (key.attempt === 2), path, "attempt");
  const r = obj(
    o.repository,
    `${path}.repository`,
    "owner name id defaultBranch private",
  );
  const repo = {
    ...repository(
      { owner: r.owner, name: r.name, id: r.id },
      `${path}.repository`,
    ),
    defaultBranch: text(r.defaultBranch, `${path}.defaultBranch`, BRANCH_RE),
    private: expectBoolean(r.private, `${path}.private`),
  };
  const commit = expectGitSha(o.commit, `${path}.commit`);
  const e = obj(o.exec, `${path}.exec`, "commit parents tree synthetic");
  const exec = {
    commit: expectGitSha(e.commit, `${path}.exec.commit`),
    parents: shas(e.parents, `${path}.exec.parents`, 8),
    tree: expectGitSha(e.tree, `${path}.exec.tree`),
    synthetic: expectBoolean(e.synthetic, `${path}.exec.synthetic`),
  };
  const pullRequest = expectNullable(o.pullRequest, `${path}.pr`, (v, at) => {
    const p = obj(v, at, "number base baseRef headRef");
    return {
      number: id(p.number, `${at}.number`),
      base: expectGitSha(p.base, `${at}.base`),
      baseRef: text(p.baseRef, `${at}.baseRef`, BRANCH_RE),
      headRef: text(p.headRef, `${at}.headRef`, BRANCH_RE),
    };
  });
  const ref = expectString(o.ref, `${path}.ref`, 266);
  if (key.context === "pull_request") {
    check(pullRequest !== null && pullRequest.base === key.base, path, "pr");
    check(ref === `refs/pull/${pullRequest?.number}/merge`, path, "ref");
    check(
      exec.synthetic && exec.parents.length === 2 &&
        exec.parents[0] === key.base && exec.parents[1] === commit,
      path,
      "pull_request exec is M = [B, H]",
    );
  } else {
    check(pullRequest === null && !exec.synthetic, path, "push exec");
    check(exec.commit === commit, path, "push exec is the commit");
    check(
      /^refs\/heads\//.test(ref) && BRANCH_RE.test(ref.slice(11)),
      path,
      "ref",
    );
  }
  const w = obj(o.workflow, `${path}.workflow`, "path blob name");
  const workflow = {
    path: text(w.path, `${path}.workflow.path`, WORKFLOW_PATH_RE),
    blob: expectGitSha(w.blob, `${path}.workflow.blob`),
    name: text(w.name, `${path}.workflow.name`, PRINTABLE_RE),
  };
  check(workflow.path === key.workflowPath, path, "workflow path");
  const j = obj(
    o.job,
    `${path}.job`,
    "key matrix checkName runsOn capMinutes targetTimeoutMinutes",
  );
  const job = {
    key: text(j.key, `${path}.job.key`, JOB_KEY_RE),
    matrix: matrix(j.matrix, `${path}.job.matrix`),
    checkName: checkName(j.checkName, `${path}.job.checkName`),
    runsOn: expectEnum(
      j.runsOn,
      ["ubuntu-latest", "ubuntu-24.04", "ubuntu-22.04"],
      `${path}.job.runsOn`,
    ),
    capMinutes: int(j.capMinutes, `${path}.job.capMinutes`, 1, 60),
    targetTimeoutMinutes: expectNullable(
      j.targetTimeoutMinutes,
      `${path}.job.targetTimeoutMinutes`,
      (v, at) => int(v, at, 1, 360),
    ),
  };
  check(job.checkName === key.checkName, path, "job check name");
  check(
    job.capMinutes ===
      Math.min(job.targetTimeoutMinutes ?? 360, BACKUP_CI_MAX_JOB_MINUTES),
    path,
    "cap minutes",
  );
  const steps = expectArray(o.steps, `${path}.steps`, 100, parseStep);
  check(steps.length > 0, path, "steps");
  steps.forEach((step, i) =>
    check(i === 0 || step.index > steps[i - 1].index, path, "step order")
  );
  const event = expectRecord(o.event, `${path}.event`);
  expectExactKeys(event, EVENT_KEYS[key.context], `${path}.event`);
  const neverStarted = expectNullable(o.neverStarted, `${path}.ns`, (v, at) => {
    const n = obj(v, at, "checkRunIds runIds cause");
    return {
      checkRunIds: expectArray(n.checkRunIds, `${at}.checkRunIds`, 16, id),
      runIds: expectArray(n.runIds, `${at}.runIds`, 16, id),
      cause: literal(n.cause, `${at}.cause`, "account_billing" as const),
    };
  });
  const p = obj(
    o.plan,
    `${path}.plan`,
    "runId launcherSha plannedAt mode runnerId",
  );
  const unit: BackupCiUnitV1 = {
    version: 1,
    kind: "sentinel_backup_ci_unit",
    unitId: text(o.unitId, `${path}.unitId`, HEX24_RE),
    purpose,
    key,
    repository: repo,
    commit,
    exec,
    pullRequest,
    ref,
    workflow,
    job,
    steps,
    event: copyEvent(event, `${path}.event`),
    neverStarted,
    native: nativeRun(o.native, `${path}.native`),
    plan: {
      runId: id(p.runId, `${path}.plan.runId`),
      launcherSha: expectGitSha(p.launcherSha, `${path}.plan.launcherSha`),
      plannedAt: count(p.plannedAt, `${path}.plan.plannedAt`),
      mode: expectEnum(p.mode, ["shadow", "on"], `${path}.plan.mode`),
      runnerId: text(p.runnerId, `${path}.plan.runnerId`, HEX16_RE),
    },
  };
  check(unit.unitId === backupCiUnitId(unit), path, "unit id");
  return unit;
}

export function parseBackupCiUnit(input: unknown): BackupCiUnitV1 {
  return parseUnitAt(input, "$");
}

export function parseBackupCiResult(input: unknown): BackupCiResultV1 {
  const o = obj(
    input,
    "$",
    "version kind unitId unitDigest observed selftest outcome reason act steps failingStep startedAt completedAt runner",
  );
  literal(o.version, "$.version", 1);
  literal(o.kind, "$.kind", "sentinel_backup_ci_result");
  const ob = obj(
    o.observed,
    "$.observed",
    "head tree parents workflowBlob clean",
  );
  const outcome = expectEnum(
    o.outcome,
    ["success", "failure", "timed_out", "no_evidence"],
    "$.outcome",
  );
  const reason = expectNullable(o.reason, "$.reason", parseNoEvidenceReason);
  check((outcome === "no_evidence") === (reason !== null), "$", "reason");
  check(reason === null || noEvidenceLegRan(reason), "$", "leg reason only");
  const a = obj(o.act, "$.act", "exitCode jobResults");
  const r = obj(o.runner, "$.runner", "runnerId imageOs imageVersion");
  const result: BackupCiResultV1 = {
    version: 1,
    kind: "sentinel_backup_ci_result",
    unitId: text(o.unitId, "$.unitId", HEX24_RE),
    unitDigest: expectSha256Hex(o.unitDigest, "$.unitDigest"),
    observed: {
      head: expectGitSha(ob.head, "$.observed.head"),
      tree: expectGitSha(ob.tree, "$.observed.tree"),
      parents: shas(ob.parents, "$.observed.parents", 8),
      workflowBlob: expectGitSha(ob.workflowBlob, "$.observed.workflowBlob"),
      clean: literal(ob.clean, "$.observed.clean", true as const),
    },
    selftest: literal(o.selftest, "$.selftest", "passed" as const),
    outcome,
    reason,
    act: {
      exitCode: expectNullable(
        a.exitCode,
        "$.act.exitCode",
        (v, at) => int(v, at, -1, 255),
      ),
      jobResults: int(a.jobResults, "$.act.jobResults", 0, 1000),
    },
    steps: expectArray(o.steps, "$.steps", 100, (v, at) => {
      const s = obj(v, at, "index result");
      return {
        index: int(s.index, `${at}.index`, 0, 999),
        result: expectEnum(
          s.result,
          ["success", "failure", "skipped", "cancelled", "missing"],
          `${at}.result`,
        ),
      };
    }),
    failingStep: expectNullable(
      o.failingStep,
      "$.failingStep",
      (v, at) => int(v, at, 0, 999),
    ),
    startedAt: count(o.startedAt, "$.startedAt"),
    completedAt: count(o.completedAt, "$.completedAt"),
    runner: {
      runnerId: text(r.runnerId, "$.runner.runnerId", HEX16_RE),
      imageOs: text(r.imageOs, "$.runner.imageOs", IMAGE_RE, 32),
      imageVersion: text(r.imageVersion, "$.runner.imageVersion", IMAGE_RE, 32),
    },
  };
  check(result.startedAt <= result.completedAt, "$", "time order");
  check(
    outcome !== "success" || result.failingStep === null,
    "$",
    "success has no failing step",
  );
  return result;
}
