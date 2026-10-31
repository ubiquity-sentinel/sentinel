/**
 * Fail-closed parsers of the backup CI store files and the targets file
 * (docs/backup-ci-spec.md §6.1, §7): closed keys, bounds, strict entry order
 * and every entry bound to its file's repository and commit. Every parser
 * throws `RecordParseError` on the first violation.
 *
 * Module-cycle note: `backup-ci.ts` re-exports these parsers, so this module
 * reads that module's values only inside functions, never at load time.
 */
import type { GitSha } from "./brands.ts";
import { canonicalStringify } from "./canonical.ts";
import {
  BACKUP_CI_MAX_EXCERPT_BYTES,
  BACKUP_CI_UNSUPPORTED,
  type BackupCiCalibrationV1,
  type BackupCiCommitFileV1,
  type BackupCiDispatchedEntryV1,
  backupCiEntrySortKey,
  type BackupCiEntryV1,
  type BackupCiNoEvidenceEntryV1,
  type BackupCiResultEntryV1,
  type BackupCiSuspensionV1,
  type BackupCiTargetV1,
  backupCiUnitDigest,
  type BackupCiWorkflowCoverageV1,
} from "./backup-ci.ts";
import {
  check,
  checkName,
  conclusion,
  count,
  HEX16_RE,
  id,
  int,
  JOB_KEY_RE,
  literal,
  matrix,
  NATIVE_CONCLUSIONS,
  nativeRun,
  type Obj,
  obj,
  parseKey,
  parseNoEvidenceReason,
  parseUnitAt,
  RECEIPT_RE,
  REPO_RE,
  repository,
  shas,
  text,
  WORKFLOW_PATH_RE,
} from "./backup-ci-parse-unit.ts";
import {
  expectArray,
  expectBoolean,
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNullable,
  expectRecord,
  expectSha256Hex,
  expectString,
  fail,
} from "./validation.ts";

function parseDispatched(o: Obj, path: string): BackupCiDispatchedEntryV1 {
  expectExactKeys(
    o,
    "state key mode runnerId unit unitDigest tree dispatchedAt".split(" "),
    path,
  );
  const t = obj(o.tree, `${path}.tree`, "artifactId sha256");
  const entry: BackupCiDispatchedEntryV1 = {
    state: "dispatched",
    key: parseKey(o.key, `${path}.key`),
    mode: expectEnum(o.mode, ["shadow", "on"], `${path}.mode`),
    runnerId: text(o.runnerId, `${path}.runnerId`, HEX16_RE),
    unit: parseUnitAt(o.unit, `${path}.unit`),
    unitDigest: expectSha256Hex(o.unitDigest, `${path}.unitDigest`),
    tree: {
      artifactId: id(t.artifactId, `${path}.tree.artifactId`),
      sha256: expectSha256Hex(t.sha256, `${path}.tree.sha256`),
    },
    dispatchedAt: count(o.dispatchedAt, `${path}.dispatchedAt`),
  };
  check(
    canonicalStringify(entry.unit.key) === canonicalStringify(entry.key) &&
      entry.unit.plan.mode === entry.mode &&
      entry.unit.plan.runnerId === entry.runnerId &&
      entry.unitDigest === backupCiUnitDigest(entry.unit),
    path,
    "dispatched unit binding",
  );
  return entry;
}

function parseResultEntry(o: Obj, path: string): BackupCiResultEntryV1 {
  expectExactKeys(
    o,
    "state key mode runnerId purpose conclusion unitDigest resultDigest startedAt completedAt binding leg native failure ingestedAt"
      .split(" "),
    path,
  );
  const b = obj(
    o.binding,
    `${path}.binding`,
    "execCommit parents tree workflowBlob jobKey matrix",
  );
  const l = obj(o.leg, `${path}.leg`, "runId jobId artifactId launcherSha");
  const entry: BackupCiResultEntryV1 = {
    state: "result",
    key: parseKey(o.key, `${path}.key`),
    mode: expectEnum(o.mode, ["shadow", "evidence"], `${path}.mode`),
    runnerId: text(o.runnerId, `${path}.runnerId`, HEX16_RE),
    purpose: expectEnum(
      o.purpose,
      ["stand_in", "confirm", "peer", "calibration"],
      `${path}.purpose`,
    ),
    conclusion: conclusion(o.conclusion, `${path}.conclusion`),
    unitDigest: expectSha256Hex(o.unitDigest, `${path}.unitDigest`),
    resultDigest: expectSha256Hex(o.resultDigest, `${path}.resultDigest`),
    startedAt: count(o.startedAt, `${path}.startedAt`),
    completedAt: count(o.completedAt, `${path}.completedAt`),
    binding: {
      execCommit: expectGitSha(b.execCommit, `${path}.binding.execCommit`),
      parents: shas(b.parents, `${path}.binding.parents`, 8),
      tree: expectGitSha(b.tree, `${path}.binding.tree`),
      workflowBlob: expectGitSha(b.workflowBlob, `${path}.binding.blob`),
      jobKey: text(b.jobKey, `${path}.binding.jobKey`, JOB_KEY_RE),
      matrix: matrix(b.matrix, `${path}.binding.matrix`),
    },
    leg: {
      runId: id(l.runId, `${path}.leg.runId`),
      jobId: id(l.jobId, `${path}.leg.jobId`),
      artifactId: id(l.artifactId, `${path}.leg.artifactId`),
      launcherSha: expectGitSha(l.launcherSha, `${path}.leg.launcherSha`),
    },
    native: nativeRun(o.native, `${path}.native`),
    failure: expectNullable(o.failure, `${path}.failure`, (v, at) => {
      const f = obj(v, at, "stepIndex excerpt");
      const excerpt = expectString(f.excerpt, `${at}.excerpt`, 8192);
      check(
        new TextEncoder().encode(excerpt).length <= BACKUP_CI_MAX_EXCERPT_BYTES,
        at,
        "excerpt bound",
      );
      return {
        stepIndex: int(f.stepIndex, `${at}.stepIndex`, 0, 999),
        excerpt,
      };
    }),
    ingestedAt: count(o.ingestedAt, `${path}.ingestedAt`),
  };
  check(entry.startedAt <= entry.completedAt, path, "time order");
  check(
    entry.conclusion !== "success" || entry.failure === null,
    path,
    "success has no failure",
  );
  return entry;
}

function parseNoEvidence(o: Obj, path: string): BackupCiNoEvidenceEntryV1 {
  expectExactKeys(
    o,
    "state key mode runnerId reason legRuns firstAt lastAt nextAt final".split(
      " ",
    ),
    path,
  );
  const entry: BackupCiNoEvidenceEntryV1 = {
    state: "no_evidence",
    key: parseKey(o.key, `${path}.key`),
    mode: expectEnum(o.mode, ["shadow", "evidence"], `${path}.mode`),
    runnerId: text(o.runnerId, `${path}.runnerId`, HEX16_RE),
    reason: parseNoEvidenceReason(o.reason, `${path}.reason`),
    legRuns: int(o.legRuns, `${path}.legRuns`, 0, 1_000_000),
    firstAt: count(o.firstAt, `${path}.firstAt`),
    lastAt: count(o.lastAt, `${path}.lastAt`),
    nextAt: expectNullable(o.nextAt, `${path}.nextAt`, count),
    final: expectBoolean(o.final, `${path}.final`),
  };
  check(entry.firstAt <= entry.lastAt, path, "time order");
  check(
    entry.final === entry.reason.startsWith("unsupported:") &&
      entry.final === (entry.nextAt === null),
    path,
    "only unsupported is final, without nextAt",
  );
  return entry;
}

function parseEntry(value: unknown, path: string): BackupCiEntryV1 {
  const o = expectRecord(value, path);
  switch (o.state) {
    case "dispatched":
      return parseDispatched(o, path);
    case "result":
      return parseResultEntry(o, path);
    case "no_evidence":
      return parseNoEvidence(o, path);
    default:
      return fail(`${path}.state`, "invalid_enum", "unknown entry state");
  }
}

function parseCoverage(
  value: unknown,
  path: string,
): BackupCiWorkflowCoverageV1 {
  const o = obj(
    value,
    path,
    "path blob event observedAt supported reason expected",
  );
  const coverage: BackupCiWorkflowCoverageV1 = {
    path: text(o.path, `${path}.path`, WORKFLOW_PATH_RE),
    blob: expectGitSha(o.blob, `${path}.blob`),
    event: expectEnum(o.event, ["push", "pull_request"], `${path}.event`),
    observedAt: count(o.observedAt, `${path}.observedAt`),
    supported: expectBoolean(o.supported, `${path}.supported`),
    reason: expectNullable(
      o.reason,
      `${path}.reason`,
      (v, at) => expectEnum(v, BACKUP_CI_UNSUPPORTED, at),
    ),
    expected: expectArray(o.expected, `${path}.expected`, 64, checkName),
  };
  check(coverage.supported === (coverage.reason === null), path, "reason");
  check(
    new Set(coverage.expected).size === coverage.expected.length,
    path,
    "expected names are unique",
  );
  return coverage;
}

/** Whether a result's binding is exactly this commit's execution shape. */
function bindsCommit(entry: BackupCiResultEntryV1, commit: GitSha): boolean {
  const { binding, key } = entry;
  return key.context === "push"
    ? binding.execCommit === commit
    : binding.parents.length === 2 && binding.parents[0] === key.base &&
      binding.parents[1] === commit;
}

export function parseBackupCiCommitFile(input: unknown): BackupCiCommitFileV1 {
  const o = obj(
    input,
    "$",
    "version kind repository commit workflows entries updatedAt",
  );
  literal(o.version, "$.version", 1);
  literal(o.kind, "$.kind", "sentinel_backup_ci_commit");
  const file: BackupCiCommitFileV1 = {
    version: 1,
    kind: "sentinel_backup_ci_commit",
    repository: repository(o.repository, "$.repository"),
    commit: expectGitSha(o.commit, "$.commit"),
    workflows: expectArray(o.workflows, "$.workflows", 16, parseCoverage),
    entries: expectArray(o.entries, "$.entries", 128, parseEntry),
    updatedAt: count(o.updatedAt, "$.updatedAt"),
  };
  const coverage = file.workflows.map((w) => `${w.path}\n${w.event}`);
  check(new Set(coverage).size === coverage.length, "$", "coverage unique");
  const keys = file.entries.map(backupCiEntrySortKey);
  keys.forEach((key, i) =>
    check(i === 0 || keys[i - 1] < key, `$.entries[${i}]`, "entry order")
  );
  file.entries.forEach((entry, i) => {
    const at = `$.entries[${i}]`;
    if (entry.state === "dispatched") {
      const r = entry.unit.repository;
      check(
        entry.unit.commit === file.commit && r.id === file.repository.id &&
          r.owner === file.repository.owner && r.name === file.repository.name,
        at,
        "unit binds the file",
      );
    } else if (entry.state === "result") {
      check(bindsCommit(entry, file.commit), at, "result binds the commit");
    }
  });
  return file;
}

export function parseBackupCiSuspension(input: unknown): BackupCiSuspensionV1 {
  const o = obj(
    input,
    "$",
    "version kind scope runnerIds reason since evidence",
  );
  literal(o.version, "$.version", 1);
  literal(o.kind, "$.kind", "sentinel_backup_ci_suspension");
  const scope = o.scope === "all" ? "all" : text(o.scope, "$.scope", REPO_RE);
  const runnerIds = o.runnerIds === "all" ? "all" : expectArray(
    o.runnerIds,
    "$.runnerIds",
    64,
    (v, at) => text(v, at, HEX16_RE),
  );
  return {
    version: 1,
    kind: "sentinel_backup_ci_suspension",
    scope: scope as BackupCiSuspensionV1["scope"],
    runnerIds,
    reason: expectEnum(
      o.reason,
      ["false_green", "false_red", "operator"],
      "$.reason",
    ),
    since: count(o.since, "$.since"),
    evidence: expectNullable(o.evidence, "$.evidence", (v, at) => {
      const e = obj(v, at, "commit checkName nativeCheckRunId receipt");
      return {
        commit: expectGitSha(e.commit, `${at}.commit`),
        checkName: checkName(e.checkName, `${at}.checkName`),
        nativeCheckRunId: id(e.nativeCheckRunId, `${at}.nativeCheckRunId`),
        receipt: text(e.receipt, `${at}.receipt`, RECEIPT_RE, 1024),
      };
    }),
  };
}

export function parseBackupCiCalibration(
  input: unknown,
): BackupCiCalibrationV1 {
  const o = obj(input, "$", "version kind repository runners updatedAt");
  literal(o.version, "$.version", 1);
  literal(o.kind, "$.kind", "sentinel_backup_ci_calibration");
  const runners = expectArray(o.runners, "$.runners", 16, (v, at) => {
    const r = obj(
      v,
      at,
      "runnerId agreements failureAgreements falseGreens falseReds samples",
    );
    const row = {
      runnerId: text(r.runnerId, `${at}.runnerId`, HEX16_RE),
      agreements: count(r.agreements, `${at}.agreements`),
      failureAgreements: count(r.failureAgreements, `${at}.failureAgreements`),
      falseGreens: count(r.falseGreens, `${at}.falseGreens`),
      falseReds: count(r.falseReds, `${at}.falseReds`),
      samples: expectArray(r.samples, `${at}.samples`, 64, (s, sat) => {
        const x = obj(s, sat, "commit checkName native backup");
        return {
          commit: expectGitSha(x.commit, `${sat}.commit`),
          checkName: checkName(x.checkName, `${sat}.checkName`),
          native: expectEnum(x.native, NATIVE_CONCLUSIONS, `${sat}.native`),
          backup: conclusion(x.backup, `${sat}.backup`),
        };
      }),
    };
    check(row.failureAgreements <= row.agreements, at, "failure agreements");
    return row;
  });
  const ids = runners.map((row) => row.runnerId);
  check(new Set(ids).size === ids.length, "$.runners", "runner ids unique");
  return {
    version: 1,
    kind: "sentinel_backup_ci_calibration",
    repository: repository(o.repository, "$.repository"),
    runners,
    updatedAt: count(o.updatedAt, "$.updatedAt"),
  };
}

/** `sentinel.backup-ci-targets.json`: every row names its repository id. */
export function parseBackupCiTargets(input: unknown): BackupCiTargetV1[] {
  const targets = expectArray(input, "$", 16, (v, at) => {
    const o = obj(v, at, "repository id");
    return {
      repository: text(o.repository, `${at}.repository`, REPO_RE, 140),
      id: id(o.id, `${at}.id`),
    } as BackupCiTargetV1;
  });
  const names = targets.map((t) => t.repository);
  check(new Set(names).size === names.length, "$", "targets unique");
  return targets;
}
