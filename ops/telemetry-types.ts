/** Local advisory evidence; none of these records grants runtime authority. */
export const CONTROLLER = "ubiquity-sentinel/sentinel";
export const TARGETS = [
  CONTROLLER,
  "ubiquity/ai.ubq.fi",
  "ubiquity/passport.ubq.fi",
];
export const POINTER_PATH =
  "hostedRuntimes/809c890bfd1b1f59e335e3f4e39c6522f09ca11bfa9e9e066ee5127822a5af27.json";
export type ObjectValue = Record<string, unknown>;
export function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectValue
    : {};
}
export function list(value: unknown): ObjectValue[] {
  return Array.isArray(value) ? value.map(object) : [];
}
export function sha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}
export function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
export function time(value: unknown): number | null {
  const n = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}
export function iso(value: number): string {
  return new Date(value).toISOString();
}
export const encoder = new TextEncoder();
export const decoder = new TextDecoder("utf-8", { fatal: true });
export async function digest(
  bytes: Uint8Array,
  algorithm = "SHA-256",
): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(algorithm, new Uint8Array(bytes).buffer),
    ),
  )
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}
export type Observation = {
  schema: 1;
  collection?: string;
  endpoint: string;
  observedAt: string;
  status: number;
  blob: string | null;
  bytes: number;
  error: string | null;
  transport: "gh" | "capture";
  source?: {
    manifest: string;
    receipt: string;
    original: string;
    sha256: string;
  };
};
export type Evidence = {
  id: string;
  observation: Observation;
  body: Uint8Array | null;
};
export type ApiResult = { status: number; body: Uint8Array; error?: string };
export type Api = (endpoint: string, timeoutMs: number) => Promise<ApiResult>;
export type SyncOptions = {
  since: number;
  cutoff: number;
  maxReads: number;
  deadlineMs: number;
};
export type Coverage = {
  schema: 1;
  collection?: string;
  observedAt: string;
  since: string;
  cutoff: string;
  reads: number;
  maxReads: number;
  stopped: "complete" | "read_budget" | "deadline";
  runsComplete: boolean;
  mergesComplete: Record<string, boolean>;
  attemptLogArchives?: {
    captured: number;
    reused: number;
    missing: number;
    deferred: number;
  };
  notes: string[];
};
export type Execution = {
  id: string;
  runId: number;
  runAttempt: number;
  revision: string;
  launcherSha: string;
  generation: number;
  purpose: string;
  createdAt: number;
};
export function execution(value: unknown): Execution | null {
  const v = object(value);
  return positive(v.runId) && positive(v.runAttempt) && sha(v.revision) &&
      sha(v.launcherSha) && positive(v.generation) && time(v.createdAt) &&
      v.id === `${v.runId}:${v.runAttempt}:repair` &&
      typeof v.purpose === "string"
    ? {
      id: String(v.id),
      runId: v.runId,
      runAttempt: v.runAttempt,
      revision: v.revision,
      launcherSha: v.launcherSha,
      generation: v.generation,
      purpose: v.purpose,
      createdAt: Number(v.createdAt),
    }
    : null;
}
export type Attempt = {
  runId: number;
  attempt: number;
  status: string;
  conclusion: string | null;
  createdAt: number | null;
  workflowHeadSha: string | null;
  execution: Execution | null;
  health: "healthy" | "failed" | "canceled" | "unstarted" | "unknown";
  native: boolean;
  evidence: string[];
  productivity: "idle" | "active" | "unknown";
};
export type Transition = {
  revision: string;
  generation: number;
  start: number;
  priorRevision: string;
  priorGeneration: number;
  kind: "installation" | "rollback";
  evidence: string;
};
export type Interval = Transition & {
  end: number | null;
  clippedStart: number;
  clippedEnd: number | null;
  hours: number | null;
  open: boolean;
  endEvidence: string | null;
};
