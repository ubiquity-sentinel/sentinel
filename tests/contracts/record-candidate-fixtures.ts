/** Shared fixtures only; this module registers no tests. */
import assert from "node:assert/strict";
import { parseWorkRecordV1 } from "../../src/contracts/mod.ts";
import { tryParse } from "../../src/contracts/validation.ts";
import { readFixture } from "./record-fixtures.ts";

export const CANDIDATE_BASE = "aafb7ee0598699bb7fb8a72ea133693ed64462da";
export const CANDIDATE_HEAD = "1111111111111111111111111111111111111111";
export const CANDIDATE_BRANCH = "sentinel/inc-2026-09-07-0001";
export const CANDIDATE_REF = `refs/heads/sentinel-candidates/${
  "ab".repeat(32)
}`;
export const PRODUCING_RESERVATION = "cd".repeat(32);
export const OTHER_CANDIDATE_SHA = "2222222222222222222222222222222222222222";
/** The other admitted descriptor key form: exact base-refresh identity. */
export const CANDIDATE_BASE_REFRESH_KEY =
  `base_refresh:7:${CANDIDATE_HEAD}:${CANDIDATE_BASE}`;

export async function rawLegacyWork(): Promise<Record<string, unknown>> {
  return (await readFixture("valid", "work-record-v1.json")) as Record<
    string,
    unknown
  >;
}

export function preservedDescriptor(): Record<string, unknown> {
  return {
    operationKey: `impl:${PRODUCING_RESERVATION}`,
    base: CANDIDATE_BASE,
    head: CANDIDATE_HEAD,
    ref: CANDIDATE_REF,
  };
}

/** The legacy fixture with one coherent V1 candidateState group. */
export async function candidateWorkRaw(
  mutate?: (
    target: Record<string, unknown>,
    candidateState: Record<string, unknown>,
  ) => void,
): Promise<Record<string, unknown>> {
  const raw = await rawLegacyWork();
  const candidateState: Record<string, unknown> = {
    preserved: preservedDescriptor(),
    publishedHead: CANDIDATE_HEAD,
  };
  const target: Record<string, unknown> = {
    base: CANDIDATE_BASE,
    branch: CANDIDATE_BRANCH,
    checkpoint: null,
    head: CANDIDATE_HEAD,
    pr: 7,
    candidateState,
  };
  mutate?.(target, candidateState);
  raw.target = target;
  return raw;
}

export function validPreservationIntent(): Record<string, unknown> {
  return {
    kind: "candidate_preservation",
    key: `impl:${PRODUCING_RESERVATION}`,
    startedAt: 1786000000000,
    branch: CANDIDATE_REF,
    expectedHead: CANDIDATE_HEAD,
    observedBase: CANDIDATE_BASE,
    pr: null,
    requestId: PRODUCING_RESERVATION,
    resultId: null,
  };
}

/** A parked record whose only candidate state is the preservation intent. */
export async function preservationIntentRaw(
  overrides: {
    intent?: Record<string, unknown>;
    candidateState?: unknown;
    omitCandidateState?: boolean;
    target?: Record<string, unknown>;
  } = {},
): Promise<Record<string, unknown>> {
  const raw = await rawLegacyWork();
  const target: Record<string, unknown> = {
    base: CANDIDATE_BASE,
    branch: CANDIDATE_BRANCH,
    checkpoint: null,
    head: CANDIDATE_HEAD,
    pr: null,
    ...overrides.target,
  };
  if (overrides.omitCandidateState !== true) {
    target.candidateState = overrides.candidateState ??
      { preserved: null, publishedHead: null };
  }
  raw.target = target;
  raw.nextStep = "work";
  raw.wait = null;
  raw.intent = overrides.intent ?? validPreservationIntent();
  return raw;
}

export function expectRejected(
  raw: unknown,
  code: string,
  path: string | undefined,
  name: string,
): void {
  const result = tryParse(parseWorkRecordV1, raw);
  assert.equal(result.ok, false, `${name}: expected rejection`);
  if (!result.ok) {
    assert.equal(result.issues[0]?.code, code, name);
    if (path !== undefined) {
      assert.equal(result.issues[0]?.path, path, name);
    }
  }
}
