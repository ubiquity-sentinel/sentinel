/** CI accounting is independent of model-start accounting. No live policy is enabled here. */
import { createHash } from "node:crypto";
import { canonicalStringify } from "./canonical.ts";
import type { GitSha } from "./brands.ts";
import type { RepositoryIdentityV1 } from "./shared.ts";
import type { PortResultV1 } from "./ports.ts";

export const CI_MINUTE_REF = "refs/heads/sentinel-state/ci-minutes";
export const CI_MINUTE_PRIVATE_REMOTE =
  "https://github.com/ubiquity/prospector.git";
export const CI_MINUTE_MAX_RECORDS = 4096;
export const CI_MINUTE_MAX_BYTES = 2 ** 20;

export interface CiMinutePolicyV1 {
  version: 1;
  activated: boolean;
  monthlyLimit: number;
  managedLimit: number;
  securityReserve: number;
  unmanagedReserve: number;
  targets: readonly {
    owner: string;
    name: string;
    repositoryId: number;
    ceilingMinutes: number;
  }[];
  /** Separately accepted disclosure/storage and measured billing-ceiling proofs. */
  storageAcceptance: string | null;
  ceilingQualification: string | null;
}

export const INACTIVE_CI_MINUTE_POLICY: Readonly<CiMinutePolicyV1> = Object
  .freeze({
    version: 1,
    activated: false,
    monthlyLimit: 2000,
    managedLimit: 1450,
    securityReserve: 150,
    unmanagedReserve: 400,
    targets: [
      {
        owner: "ubiquity",
        name: "prospector",
        repositoryId: 1337190500,
        ceilingMinutes: 25,
      },
      {
        owner: "ubiquity",
        name: "passport.ubq.fi",
        repositoryId: 1254699258,
        ceilingMinutes: 35,
      },
    ],
    storageAcceptance: null,
    ceilingQualification: null,
  });

/** Accepted protected-source scheduling basis, not an invoice-perfect ceiling claim. */
export interface CiMinuteSourcePolicyV1 extends CiMinutePolicyV1 {
  calendar: "utc_month";
  accounting: "retained_estimates";
  meterRefunds: false;
  bootstrap: "unknown_month_floor";
  privateRemote: typeof CI_MINUTE_PRIVATE_REMOTE;
  stateRef: typeof CI_MINUTE_REF;
  targets: readonly {
    owner: string;
    name: string;
    repositoryId: number;
    ceilingMinutes: number;
    workflowBlob: string;
    job: string;
    runner: "ubuntu-latest";
    timeoutMinutes: number;
  }[];
}

/** Consumers stay on INACTIVE until the dependent modules are integrated. */
export const ACCEPTED_CI_MINUTE_POLICY: Readonly<CiMinuteSourcePolicyV1> =
  Object.freeze({
    ...INACTIVE_CI_MINUTE_POLICY,
    activated: true,
    calendar: "utc_month",
    accounting: "retained_estimates",
    meterRefunds: false,
    bootstrap: "unknown_month_floor",
    privateRemote: CI_MINUTE_PRIVATE_REMOTE,
    stateRef: CI_MINUTE_REF,
    ceilingQualification:
      "b0134c1921657e336834a67d4ae52ae9aa491f5ff8f39f5d123148587919b0e4",
    storageAcceptance: ciMinuteDigest({
      domain: "ci-private-state-v1",
      remote: CI_MINUTE_PRIVATE_REMOTE,
      ref: CI_MINUTE_REF,
    }),
    targets: Object.freeze([
      Object.freeze({
        owner: "ubiquity",
        name: "prospector",
        repositoryId: 1337190500,
        ceilingMinutes: 25,
        workflowBlob: "bacb73da71714a27d76918771d06ff4ce1f45b82",
        job: "validation",
        runner: "ubuntu-latest" as const,
        timeoutMinutes: 20,
      }),
      Object.freeze({
        owner: "ubiquity",
        name: "passport.ubq.fi",
        repositoryId: 1254699258,
        ceilingMinutes: 35,
        workflowBlob: "f2c61d693d8439a7f42b47d35ebaedb37173b1c7",
        job: "deno",
        runner: "ubuntu-latest" as const,
        timeoutMinutes: 30,
      }),
    ]),
  });

export function acceptedCiMinutePolicy(): CiMinuteSourcePolicyV1 {
  return structuredClone(ACCEPTED_CI_MINUTE_POLICY);
}

export type CiEffectKindV1 =
  | "head_push"
  | "pr_open"
  | "base_refresh"
  | "merge"
  | "rerun"
  | "train_push"
  | "train_dispatch";

/** Private inputs: only their digest, never these fields, enters the ledger. */
export interface CiEffectV1 {
  repository: RepositoryIdentityV1;
  kind: CiEffectKindV1;
  head: string | null;
  base: string | null;
  ref: string;
  pr: number | null;
  runId?: number;
  attempt?: number;
}

export interface CiEffectFactsV1 {
  repositoryId: number;
  workflowBlob: string;
  job: string;
  jobs: number;
  runner: string;
  timeoutMinutes: number;
  /** Bound includes billable setup/post-job time; it is not an observed average. */
  ceilingMinutes: number;
  qualificationDigest: string;
  triggered: boolean;
  effectState: "not_applied" | "applied" | "unknown";
}

export interface CiMinuteReservationV1 {
  effectDigest: string;
  policyDigest: string;
  ceilingMinutes: number;
  state:
    | "reserved"
    | "submitted"
    | "ambiguous"
    | "settled"
    | "terminal_estimated"
    | "confirmed_not_submitted";
  createdAt: number;
  settledAt: number | null;
  chargedMinutes: number;
  proofDigest: string | null;
  /** Quantity provenance; timestamps close execution exposure, never measure invoices. */
  accounting?: {
    kind: "retained_estimate" | "provider_actual" | "never_started";
    executionMonth: string | null;
    terminalProofDigest: string;
    startedAt: number | null;
    completedAt: number | null;
  };
  binding?: {
    effect: CiEffectV1;
    repositoryId: number;
    workflowBlob: string;
    job: string;
  };
}

/** Private positional continuation; no source, logs, credentials or arbitrary payload. */
export interface CiMinuteReadCursorV1 {
  queryDigest: string;
  runPage: number;
  runOffset: number;
  attempt: number;
  jobPage: number;
  jobsSeen: number;
  runDigest: string | null;
  pageDigest?: string | null;
}

export interface CiMinuteProgressV1 {
  month: string;
  through: number;
  windowFrom: number;
  windowThrough: number;
  targetIndex: number;
  cursor: CiMinuteReadCursorV1 | null;
  jobs: CiMinuteJobProofV1[];
  completedAttempts: string[];
  bindingIndex?: number;
  aliases?: { effectDigest: string; head: string }[];
}

/** Job receipts are produced by an authenticated, complete attempt reader. */
export interface CiMinuteJobProofV1 {
  digest: string;
  effectDigest: string | null;
  startedAt: number | null;
  completedAt: number | null;
  neverStarted: boolean;
  terminal: boolean;
  /** Provider /timing job duration, not a subtraction of job timestamps. */
  billedDurationMs: number | null;
  identity?: {
    repositoryId: number;
    runId: number;
    attempt: number;
    jobId: number;
  };
  /** Explicit conservative quantity; a zero/missing provider meter never becomes actual usage. */
  estimate?: {
    kind: "retained_estimate";
    minutes: number;
    executionMonth: string | null;
    terminalProofDigest: string;
  };
}

export interface CiMinuteObservationV1 {
  month: string;
  complete: boolean;
  watermark: number;
  jobs: readonly CiMinuteJobProofV1[];
  progress?: CiMinuteProgressV1 | null;
  completedAttempts?: readonly string[];
  observedAt?: number;
  catalog?: CiMinuteRunCatalogV1;
}

export interface CiMinuteLedgerV1 {
  version: 1;
  month: string;
  policyDigest: string;
  updatedAt: number;
  sequence: number;
  /** Explicit import; absent or incomplete history never means unused allowance. */
  baselineMinutes: number;
  watermark: number | null;
  reservations: CiMinuteReservationV1[];
  /** Opaque job identity -> rounded debit, retained across repeated observations. */
  observed: { digest: string; effectDigest: string | null; minutes: number }[];
  progress?: CiMinuteProgressV1 | null;
  completedAttempts?: string[];
  proofs?: CiMinuteJobProofV1[];
  /** Conservative floor, not an additive invented actual-usage receipt. */
  bootstrap?: CiMinuteBootstrapV1;
  catalog?: CiMinuteRunCatalogV1;
}

export interface CiMinuteBootstrapV1 {
  kind: "conservative_unknown_history";
  month: string;
  floorMinutes: number;
  createdAt: number;
  policyDigest: string;
}

export interface CiMinuteKnownRunV1 {
  repositoryId: number;
  runId: number;
  head: string;
  createdAt: number | null;
  updatedAt: number | null;
  runAttempt: number;
  checkedAttempt: number;
  status:
    | "queued"
    | "in_progress"
    | "waiting"
    | "requested"
    | "pending"
    | "completed"
    | "unknown";
  terminalProofDigest: string | null;
  refreshRequired: boolean;
}

/** Finite private catalog; capacity exhaustion holds rather than retiring by age. */
export interface CiMinuteRunCatalogV1 {
  runs: CiMinuteKnownRunV1[];
  cursor: number;
  passThrough: number | null;
  complete: boolean;
}

export interface CiMinuteStoreV1 {
  read(
    month: string,
  ): Promise<
    PortResultV1<{ head: GitSha | null; ledger: CiMinuteLedgerV1 | null }>
  >;
  write(
    input: { expectedHead: GitSha | null; ledger: CiMinuteLedgerV1 },
  ): Promise<
    PortResultV1<
      { status: "applied" | "conflict" | "ambiguous"; head: GitSha | null }
    >
  >;
}

export type CiMinuteDecisionV1 =
  | { kind: "inactive" }
  | { kind: "admitted"; reservationDigest: string }
  | { kind: "reconciled"; reservationDigest: string }
  | { kind: "held"; retryAt: number; reason: string }
  | { kind: "unavailable"; reason: string };

export interface CiMinuteControllerV1 {
  readonly active: boolean;
  reserve(effect: CiEffectV1, deadline: number): Promise<CiMinuteDecisionV1>;
}

/** Native-turn driver is separate so effect-only ports and fixtures remain unchanged. */
export interface CiMinuteCoordinatorV1 extends CiMinuteControllerV1 {
  reconcile(deadline: number): Promise<CiMinuteReconcileDecisionV1>;
}

export type CiMinuteReconcileDecisionV1 =
  | { kind: "inactive" }
  | { kind: "ready"; month: string; watermark: number }
  | { kind: "pending"; retryAt: number; reason: string }
  | { kind: "unavailable"; reason: string };

/** Reader returns normalized evidence/state only; the controller owns every CAS write. */
export type CiMinuteObserverV1 = (
  month: string,
  deadline: number,
  ledger: Readonly<CiMinuteLedgerV1>,
) => Promise<CiMinuteObservationV1 | null>;

export interface CiMinuteReconcilerInputV1 {
  policy: Readonly<CiMinutePolicyV1>;
  request(path: string, deadline: number): Promise<unknown | null>;
  clock: { now(): number };
}

export type CiMinuteReconcilerFactoryV1 = (
  input: CiMinuteReconcilerInputV1,
) => CiMinuteObserverV1;

export function ciMinuteDigest(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value), "utf8").digest(
    "hex",
  );
}

export function ciMonth(
  now: number,
): { month: string; start: number; end: number; previous: string } {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("invalid CI clock");
  }
  const date = new Date(now);
  const y = date.getUTCFullYear(), m = date.getUTCMonth();
  const start = Date.UTC(y, m, 1), end = Date.UTC(y, m + 1, 1);
  if (![start, end].every(Number.isSafeInteger)) {
    throw new Error("invalid CI month");
  }
  return {
    month: new Date(start).toISOString().slice(0, 7),
    start,
    end,
    previous: new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 7),
  };
}

export function ciPolicyDigest(policy: CiMinutePolicyV1): string {
  if (
    policy.version !== 1 || typeof policy.activated !== "boolean" ||
    ![
      policy.monthlyLimit,
      policy.managedLimit,
      policy.securityReserve,
      policy.unmanagedReserve,
    ]
      .every((n) => Number.isSafeInteger(n) && n >= 0) ||
    policy.managedLimit < 1 ||
    policy.monthlyLimit > 2000 ||
    policy.managedLimit + policy.securityReserve + policy.unmanagedReserve >
      policy.monthlyLimit ||
    !Array.isArray(policy.targets) || policy.targets.length < 1 ||
    policy.targets.length > 16 ||
    policy.targets.some((t) =>
      !/^[A-Za-z0-9._-]{1,100}$/.test(t.owner) ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(t.name) ||
      !Number.isSafeInteger(t.repositoryId) ||
      t.repositoryId < 1 || !Number.isSafeInteger(t.ceilingMinutes) ||
      t.ceilingMinutes < 1
    ) ||
    (policy.activated &&
      (!digest(policy.storageAcceptance) ||
        !digest(policy.ceilingQualification)))
  ) {
    throw new Error("invalid CI minute policy");
  }
  return ciMinuteDigest(policy);
}

export function ciJobMinutes(job: CiMinuteJobProofV1): number {
  if (
    typeof job.neverStarted !== "boolean" ||
    typeof job.terminal !== "boolean" ||
    !digest(job.digest) ||
    (job.effectDigest !== null && !digest(job.effectDigest)) ||
    !job.terminal
  ) throw new Error("incomplete CI job proof");
  if (job.neverStarted) {
    if (
      job.startedAt !== null || job.completedAt !== null ||
      !Number.isSafeInteger(job.billedDurationMs) ||
      job.billedDurationMs === null || job.billedDurationMs < 0
    ) {
      throw new Error("invalid no-start proof");
    }
    return job.billedDurationMs === 0
      ? 0
      : Math.ceil(job.billedDurationMs / 60_000);
  }
  if (
    !Number.isSafeInteger(job.billedDurationMs) ||
    job.billedDurationMs === null || job.billedDurationMs <= 0 ||
    !Number.isSafeInteger(job.startedAt) ||
    !Number.isSafeInteger(job.completedAt) ||
    job.startedAt === null || job.completedAt === null || job.startedAt < 0 ||
    job.completedAt < job.startedAt
  ) throw new Error("invalid CI job timing");
  return Math.max(1, Math.ceil(job.billedDurationMs / 60_000));
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function keys(
  value: unknown,
  names: string,
  optional = "",
): asserts value is Record<string, unknown> {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    names.split(" ").some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) =>
      ![...names.split(" "), ...optional.split(" ").filter(Boolean)].includes(
        key,
      )
    )
  ) {
    throw new Error("invalid CI ledger shape");
  }
}

/** Closed private-state parser rejects source, workflow text and raw diagnostics. */
export function parseCiMinuteLedger(value: unknown): CiMinuteLedgerV1 {
  keys(
    value,
    "version month policyDigest updatedAt sequence baselineMinutes watermark reservations observed",
    "progress completedAttempts proofs bootstrap catalog",
  );
  if (
    value.version !== 1 || typeof value.month !== "string" ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(value.month) ||
    !digest(value.policyDigest) ||
    ![value.updatedAt, value.sequence, value.baselineMinutes].every((n) =>
      Number.isSafeInteger(n) && Number(n) >= 0
    ) ||
    (value.watermark !== null &&
      (!Number.isSafeInteger(value.watermark) ||
        Number(value.watermark) < 0)) ||
    !Array.isArray(value.reservations) || !Array.isArray(value.observed) ||
    value.reservations.length + value.observed.length > CI_MINUTE_MAX_RECORDS
  ) throw new Error("invalid CI ledger");
  const ids = new Set<string>();
  for (const item of value.reservations) {
    keys(
      item,
      "effectDigest policyDigest ceilingMinutes state createdAt settledAt chargedMinutes proofDigest",
      "binding accounting",
    );
    if (
      !digest(item.effectDigest) || ids.has(item.effectDigest) ||
      !digest(item.policyDigest) ||
      ![item.ceilingMinutes, item.createdAt, item.chargedMinutes].every((n) =>
        Number.isSafeInteger(n) && Number(n) >= 0
      ) ||
      Number(item.ceilingMinutes) < 1 ||
      ![
        "reserved",
        "submitted",
        "ambiguous",
        "settled",
        "terminal_estimated",
        "confirmed_not_submitted",
      ].includes(String(item.state)) ||
      (item.settledAt !== null &&
        (!Number.isSafeInteger(item.settledAt) ||
          Number(item.settledAt) < Number(item.createdAt))) ||
      (item.proofDigest !== null && !digest(item.proofDigest))
    ) throw new Error("invalid CI reservation");
    const terminal = item.state === "settled" ||
      item.state === "terminal_estimated" ||
      item.state === "confirmed_not_submitted";
    if (
      terminal !== (item.settledAt !== null && item.proofDigest !== null) ||
      (!terminal &&
        Number(item.chargedMinutes) < Number(item.ceilingMinutes)) ||
      (item.state === "confirmed_not_submitted" && item.chargedMinutes !== 0)
    ) throw new Error("invalid CI charge");
    ids.add(item.effectDigest);
    if (item.binding !== undefined) validateCiMinuteBinding(item.binding);
    if (item.accounting !== undefined) {
      validateCiMinuteAccounting(item.accounting);
    }
    if (item.state === "terminal_estimated") {
      const accounting = item.accounting as Record<string, unknown> | undefined;
      if (
        accounting?.kind !== "retained_estimate" ||
        accounting.executionMonth === null ||
        Number(item.chargedMinutes) < Number(item.ceilingMinutes) ||
        accounting.terminalProofDigest !== item.proofDigest
      ) {
        throw new Error("invalid terminal CI estimate");
      }
    }
  }
  ids.clear();
  for (const item of value.observed) {
    keys(item, "digest effectDigest minutes");
    if (
      !digest(item.digest) || ids.has(item.digest) ||
      (item.effectDigest !== null && !digest(item.effectDigest)) ||
      !Number.isSafeInteger(item.minutes) || Number(item.minutes) < 0
    ) throw new Error("invalid CI observation");
    ids.add(item.digest);
  }
  if (value.completedAttempts !== undefined) {
    validateCiMinuteAttempts(value.completedAttempts);
  }
  if (value.progress !== undefined && value.progress !== null) {
    validateCiMinuteProgress(value.progress, String(value.month));
  }
  if (value.proofs !== undefined) validateCiMinuteProofs(value.proofs);
  if (value.bootstrap !== undefined) {
    keys(value.bootstrap, "kind month floorMinutes createdAt policyDigest");
    const bootstrap = value.bootstrap;
    if (
      bootstrap.kind !== "conservative_unknown_history" ||
      bootstrap.month !== value.month ||
      bootstrap.policyDigest !== value.policyDigest ||
      bootstrap.floorMinutes !== value.baselineMinutes ||
      !Number.isSafeInteger(bootstrap.createdAt) ||
      Number(bootstrap.createdAt) < 0 ||
      Number(bootstrap.createdAt) > Number(value.updatedAt)
    ) throw new Error("invalid conservative CI bootstrap");
  }
  if (value.catalog !== undefined) validateCiMinuteCatalog(value.catalog);
  const text = canonicalStringify(value);
  if (new TextEncoder().encode(text).length > CI_MINUTE_MAX_BYTES) {
    throw new Error("CI ledger bound");
  }
  return structuredClone(value) as unknown as CiMinuteLedgerV1;
}

function validateCiMinuteAccounting(value: unknown): void {
  keys(value, "kind executionMonth terminalProofDigest startedAt completedAt");
  if (
    !["retained_estimate", "provider_actual", "never_started"].includes(
      String(value.kind),
    ) ||
    !digest(value.terminalProofDigest) ||
    (value.executionMonth !== null &&
      (typeof value.executionMonth !== "string" ||
        !/^\d{4}-(0[1-9]|1[0-2])$/.test(value.executionMonth)))
  ) {
    throw new Error("invalid CI accounting provenance");
  }
  if (value.kind === "never_started") {
    if (value.startedAt !== null || value.completedAt !== null) {
      throw new Error("invalid no-start provenance");
    }
  } else {
    if (
      ![value.startedAt, value.completedAt].every((n) =>
        Number.isSafeInteger(n) && Number(n) >= 0
      ) ||
      Number(value.completedAt) < Number(value.startedAt)
    ) throw new Error("invalid terminal CI timestamps");
    if (
      value.executionMonth !== null &&
      (ciMonth(Number(value.startedAt)).month !== value.executionMonth ||
        ciMonth(Number(value.completedAt)).month !== value.executionMonth)
    ) throw new Error("unproved CI execution month");
  }
}

function validateCiMinuteCatalog(value: unknown): void {
  keys(value, "runs cursor passThrough complete");
  if (
    !Array.isArray(value.runs) || value.runs.length > CI_MINUTE_MAX_RECORDS ||
    !Number.isSafeInteger(value.cursor) || Number(value.cursor) < 0 ||
    Number(value.cursor) > value.runs.length ||
    typeof value.complete !== "boolean" ||
    (value.passThrough !== null &&
      (!Number.isSafeInteger(value.passThrough) ||
        Number(value.passThrough) < 0)) ||
    (value.complete &&
      (value.cursor !== value.runs.length || value.passThrough === null))
  ) throw new Error("invalid CI catalog cursor");
  const ids = new Set<string>();
  for (const run of value.runs) {
    keys(
      run,
      "repositoryId runId head createdAt updatedAt runAttempt checkedAttempt status terminalProofDigest refreshRequired",
    );
    const id = `${run.repositoryId}:${run.runId}`;
    if (
      ids.has(id) || (value.complete && run.refreshRequired === true) ||
      ![run.repositoryId, run.runId, run.runAttempt].every((n) =>
        Number.isSafeInteger(n) && Number(n) > 0
      ) ||
      !/^[0-9a-f]{40}$/.test(String(run.head)) ||
      !Number.isSafeInteger(run.checkedAttempt) ||
      Number(run.checkedAttempt) < 0 ||
      Number(run.checkedAttempt) > Number(run.runAttempt) ||
      [run.createdAt, run.updatedAt].some((n) =>
        n !== null && (!Number.isSafeInteger(n) || Number(n) < 0)
      ) ||
      ![
        "queued",
        "in_progress",
        "waiting",
        "requested",
        "pending",
        "completed",
        "unknown",
      ].includes(String(run.status)) ||
      typeof run.refreshRequired !== "boolean" ||
      (run.terminalProofDigest !== null && (!digest(run.terminalProofDigest) ||
        run.status !== "completed" || run.checkedAttempt !== run.runAttempt))
    ) throw new Error("invalid known CI run");
    ids.add(id);
  }
}

function validateCiMinuteAttempts(value: unknown): void {
  if (
    !Array.isArray(value) || value.length > CI_MINUTE_MAX_RECORDS ||
    value.some((id) => !digest(id)) || new Set(value).size !== value.length
  ) throw new Error("invalid CI attempts");
}

function validateCiMinuteBinding(value: unknown): void {
  keys(value, "effect repositoryId workflowBlob job");
  if (
    !Number.isSafeInteger(value.repositoryId) ||
    Number(value.repositoryId) < 1 ||
    !/^[0-9a-f]{40}$/.test(String(value.workflowBlob)) ||
    !/^[A-Za-z0-9._-]{1,100}$/.test(String(value.job))
  ) {
    throw new Error("invalid private CI binding");
  }
  keys(value.effect, "repository kind head base ref pr", "runId attempt");
  const effect = value.effect;
  keys(effect.repository, "owner name installationId");
  if (
    ![effect.repository.owner, effect.repository.name].every((s) =>
      typeof s === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(s)
    ) ||
    !Number.isSafeInteger(effect.repository.installationId) ||
    Number(effect.repository.installationId) < 0 ||
    ![
      "head_push",
      "pr_open",
      "base_refresh",
      "merge",
      "rerun",
      "train_push",
      "train_dispatch",
    ].includes(String(effect.kind)) ||
    ![effect.head, effect.base].every((s) =>
      s === null || /^[0-9a-f]{40}$/.test(String(s))
    ) ||
    typeof effect.ref !== "string" || effect.ref.length > 240 ||
    /[\r\n\0]/.test(effect.ref) ||
    (effect.pr !== null &&
      (!Number.isSafeInteger(effect.pr) || Number(effect.pr) < 1)) ||
    [effect.runId, effect.attempt].some((n) =>
      n !== undefined && (!Number.isSafeInteger(n) || Number(n) < 1)
    )
  ) {
    throw new Error("invalid private CI effect");
  }
}

function validateCiMinuteProgress(value: unknown, month: string): void {
  keys(
    value,
    "month through windowFrom windowThrough targetIndex cursor jobs completedAttempts",
    "bindingIndex aliases",
  );
  if (
    value.month !== month ||
    ![value.through, value.windowFrom, value.windowThrough, value.targetIndex]
      .every((n) => Number.isSafeInteger(n) && Number(n) >= 0) ||
    Number(value.windowFrom) > Number(value.windowThrough) ||
    Number(value.windowThrough) > Number(value.through) ||
    Number(value.targetIndex) > 15 ||
    !Array.isArray(value.jobs) || value.jobs.length > CI_MINUTE_MAX_RECORDS
  ) throw new Error("invalid private CI progress");
  validateCiMinuteProofs(value.jobs);
  validateCiMinuteAttempts(value.completedAttempts);
  if (
    value.bindingIndex !== undefined &&
    (!Number.isSafeInteger(value.bindingIndex) ||
      Number(value.bindingIndex) < 0 ||
      Number(value.bindingIndex) > CI_MINUTE_MAX_RECORDS)
  ) throw new Error("invalid CI binding cursor");
  if (value.aliases !== undefined) {
    if (
      !Array.isArray(value.aliases) ||
      value.aliases.length > CI_MINUTE_MAX_RECORDS
    ) throw new Error("invalid CI aliases");
    for (const alias of value.aliases) {
      keys(alias, "effectDigest head");
      if (
        !digest(alias.effectDigest) ||
        !/^[0-9a-f]{40}$/.test(String(alias.head))
      ) throw new Error("invalid CI alias");
    }
  }
  if (value.cursor !== null) {
    keys(
      value.cursor,
      "queryDigest runPage runOffset attempt jobPage jobsSeen runDigest",
      "pageDigest",
    );
    const cursor = value.cursor;
    if (
      !digest(cursor.queryDigest) ||
      (cursor.runDigest !== null && !digest(cursor.runDigest)) ||
      (cursor.pageDigest !== undefined && cursor.pageDigest !== null &&
        !digest(cursor.pageDigest)) ||
      ![
        cursor.runPage,
        cursor.runOffset,
        cursor.attempt,
        cursor.jobPage,
        cursor.jobsSeen,
      ]
        .every((n) => Number.isSafeInteger(n) && Number(n) >= 0) ||
      Number(cursor.runPage) < 1 ||
      Number(cursor.jobPage) < 1 || Number(cursor.attempt) < 1
    ) throw new Error("invalid private CI cursor");
  }
}

function validateCiMinuteProofs(value: unknown): void {
  if (!Array.isArray(value) || value.length > CI_MINUTE_MAX_RECORDS) {
    throw new Error("invalid private CI proofs");
  }
  for (const job of value) {
    keys(
      job,
      "digest effectDigest startedAt completedAt neverStarted terminal billedDurationMs",
      "identity estimate",
    );
    if (job.estimate === undefined) {
      ciJobMinutes(job as unknown as CiMinuteJobProofV1);
    } else {
      keys(job.estimate, "kind minutes executionMonth terminalProofDigest");
      const estimate = job.estimate;
      if (
        estimate.kind !== "retained_estimate" ||
        !Number.isSafeInteger(estimate.minutes) ||
        Number(estimate.minutes) < 1 ||
        job.neverStarted !== false || job.terminal !== true
      ) throw new Error("invalid CI proof estimate");
      validateCiMinuteAccounting({
        kind: estimate.kind,
        executionMonth: estimate.executionMonth,
        terminalProofDigest: estimate.terminalProofDigest,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
      });
    }
    if (job.identity !== undefined) {
      keys(job.identity, "repositoryId runId attempt jobId");
      if (
        !Object.values(job.identity).every((n) =>
          Number.isSafeInteger(n) && Number(n) > 0
        ) ||
        ciMinuteDigest(job.identity) !== job.digest
      ) throw new Error("invalid private CI job identity");
    }
  }
}

/** Shared writer cannot erase old reservations, receipts, imports or terminal charges. */
export function validateCiMinuteTransition(
  prior: CiMinuteLedgerV1,
  next: CiMinuteLedgerV1,
): void {
  if (
    next.month !== prior.month || next.sequence <= prior.sequence ||
    next.updatedAt < prior.updatedAt ||
    next.policyDigest !== prior.policyDigest ||
    next.baselineMinutes !== prior.baselineMinutes ||
    (prior.watermark !== null &&
      (next.watermark === null || next.watermark < prior.watermark))
  ) {
    throw new Error("CI ledger transition refused");
  }
  for (const old of prior.reservations) {
    const row = next.reservations.find((r) =>
      r.effectDigest === old.effectDigest
    );
    if (
      row === undefined || row.policyDigest !== old.policyDigest ||
      row.ceilingMinutes !== old.ceilingMinutes ||
      row.createdAt !== old.createdAt ||
      canonicalStringify(row.binding ?? null) !==
        canonicalStringify(old.binding ?? null) ||
      (["settled", "terminal_estimated", "confirmed_not_submitted"].includes(
        old.state,
      ) &&
        canonicalStringify(row) !== canonicalStringify(old) &&
        !(["settled", "terminal_estimated"].includes(old.state) &&
          row.state === old.state &&
          row.chargedMinutes > old.chargedMinutes &&
          row.settledAt === old.settledAt &&
          row.proofDigest === old.proofDigest &&
          canonicalStringify(row.accounting ?? null) ===
            canonicalStringify(old.accounting ?? null)))
    ) {
      throw new Error("CI reservation history changed");
    }
  }
  for (const old of prior.observed) {
    if (
      !next.observed.some((row) =>
        row.digest === old.digest && row.minutes >= old.minutes &&
        (row.effectDigest === old.effectDigest ||
          (old.effectDigest === null && row.effectDigest !== null))
      )
    ) {
      throw new Error("CI observation history changed");
    }
  }
  for (const id of prior.completedAttempts ?? []) {
    if (!(next.completedAttempts ?? []).includes(id)) {
      throw new Error("CI attempt history changed");
    }
  }
  if (
    prior.bootstrap !== undefined &&
    canonicalStringify(prior.bootstrap) !==
      canonicalStringify(next.bootstrap ?? null)
  ) {
    throw new Error("CI bootstrap provenance changed");
  }
  for (const old of prior.catalog?.runs ?? []) {
    const run = next.catalog?.runs.find((r) =>
      r.repositoryId === old.repositoryId && r.runId === old.runId
    );
    if (
      run === undefined || run.head !== old.head ||
      (old.createdAt !== null && run.createdAt !== old.createdAt) ||
      run.runAttempt < old.runAttempt || run.checkedAttempt < old.checkedAttempt
    ) throw new Error("CI catalog history changed");
  }
}
