/** Strict matrix artifact primitives and fail-closed refusal. */
import type { MatrixRunIdentityV1 } from "../contracts/matrix.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";

export type Json = Record<string, unknown>;
export function refuse(): never {
  throw new Error("matrix artifact provenance unavailable or conflicting");
}
export function record(value: unknown): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    refuse();
  }
  return value as Json;
}
export function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) refuse();
  return value as number;
}
export function sha(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) refuse();
  return value;
}
export function instant(value: unknown): number {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    refuse();
  }
  return Date.parse(value);
}
export function sameRepo(
  a: RepositoryIdentityV1,
  b: RepositoryIdentityV1,
): boolean {
  return a.owner === b.owner && a.name === b.name &&
    a.installationId === b.installationId;
}
export function sameRun(
  a: MatrixRunIdentityV1,
  b: Json | MatrixRunIdentityV1,
): boolean {
  return a.runId === b.runId && a.runAttempt === b.runAttempt &&
    a.launcherSha === b.launcherSha;
}
export async function bytesDigest(bytes: Uint8Array): Promise<string> {
  return [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())),
  ].map((b) => b.toString(16).padStart(2, "0")).join("");
}
