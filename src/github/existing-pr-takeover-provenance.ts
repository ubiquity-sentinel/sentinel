/** Existing V1 evidence references authenticate ancestry; they are not review verdicts. */
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type {
  TakeoverBinding,
  TakeoverPreserveRequest,
} from "../contracts/existing-pr-takeover.ts";
import type { StateReadView } from "../contracts/ports.ts";
import {
  parseEvidenceRef,
  parseRepositoryIdentity,
} from "../contracts/shared.ts";
import type { EvidenceRefV1 } from "../contracts/shared.ts";
import { parseRepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";

export const TAKEOVER_EVIDENCE_NAMESPACE =
  "artifact:review-receipt/pr-takeover-v1";
export const TAKEOVER_NATIVE_PRESERVED =
  "existing pull request takeover custody: native head preserved";
export const TAKEOVER_NATIVE_PRESERVING =
  "existing pull request takeover custody: preserving native head";

export function nativeTakeoverIntentKey(
  input: TakeoverPreserveRequest,
): string {
  return `pr_takeover:${input.bindingDigest}:${input.head}:${input.base}`;
}

/** A marker suppresses fallback, but only readTakeoverAnchor proves ancestry. */
export function hasTakeoverCustody(record: WorkRecordV1): boolean {
  return record.evidence.some((row) =>
    row.ref.startsWith(TAKEOVER_EVIDENCE_NAMESPACE)
  ) || record.intent?.key.startsWith("pr_takeover:") === true ||
    record.blocker?.message === TAKEOVER_NATIVE_PRESERVING ||
    record.blocker?.message === TAKEOVER_NATIVE_PRESERVED;
}
const HEX = /^[0-9a-f]{64}$/;
const POINTER =
  /^artifact:review-receipt\/pr-takeover-v1\/([0-9a-f]{64})\/([0-9a-f]{40})$/;
const equal = (a: unknown, b: unknown) =>
  canonicalStringify(a) === canonicalStringify(b);
const text = (v: unknown, max: number) =>
  typeof v === "string" && v.length > 0 &&
  v.length <= max &&
  [...v].every((character) =>
    character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127
  );
const branch = (v: unknown) =>
  text(v, 256) &&
  (v as string).split("/").every((p) =>
    /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(p) && !p.endsWith(".") &&
    !p.endsWith(".lock") && !p.includes("..")
  );

/** Stable binding excludes mutable H/B, which are separately bound at every effect. */
export async function takeoverBindingDigest(
  binding: TakeoverBinding,
): Promise<string> {
  parseRepositoryIdentity(binding.repository, "$takeover.repository");
  if (
    !text(binding.taskId, 256) || !text(binding.issueNodeId, 256) ||
    !HEX.test(binding.issueDigest) || !text(binding.pullNodeId, 256) ||
    !text(binding.headRepositoryId, 256) || !text(binding.author, 128) ||
    !Number.isSafeInteger(binding.issueNumber) || binding.issueNumber <= 0 ||
    !Number.isSafeInteger(binding.pullRequest) || binding.pullRequest <= 0 ||
    !branch(binding.headRef) || !branch(binding.baseRef) ||
    !equal(binding.headRepository, {
      owner: binding.repository.owner,
      name: binding.repository.name,
    })
  ) throw new Error("invalid existing PR takeover binding");
  return await digest({ domain: "sentinel.existing-pr-takeover.v1", binding });
}

export async function takeoverNativeRef(input: {
  bindingDigest: string;
  head: GitSha;
  base: GitSha;
}): Promise<string> {
  if (
    !HEX.test(input.bindingDigest) || !isGitSha(input.head) ||
    !isGitSha(input.base)
  ) {
    throw new Error("invalid existing PR takeover native ref");
  }
  return `refs/heads/sentinel-candidates/${await digest({
    domain: "sentinel.existing-pr-native-custody.v1",
    ...input,
  })}`;
}

/** Parking metadata only; creating a reference never grants custody or review authority. */
export function takeoverAnchorRef(bindingDigest: string): EvidenceRefV1 {
  if (!HEX.test(bindingDigest)) throw new Error("invalid takeover digest");
  return parseEvidenceRef({
    kind: "review_receipt",
    ref: `${TAKEOVER_EVIDENCE_NAMESPACE}/anchor/${bindingDigest}`,
  }, "$takeover.anchor");
}

/** Points at an already committed ancestor, never at the commit being written. */
export function takeoverProvenanceRef(
  bindingDigest: string,
  anchor: GitSha,
): EvidenceRefV1 {
  if (!HEX.test(bindingDigest) || !isGitSha(anchor)) {
    throw new Error("invalid takeover pointer");
  }
  return parseEvidenceRef({
    kind: "review_receipt",
    ref: `${TAKEOVER_EVIDENCE_NAMESPACE}/${bindingDigest}/${anchor}`,
  }, "$takeover.provenance");
}

export interface TakeoverAnchor {
  stateHead: GitSha;
  record: WorkRecordV1;
  bindingDigest: string;
  nativeRef: string;
}

/** Authenticate the exact native-custody park through the existing strict state reader. */
export async function readTakeoverAnchor(input: {
  state: Pick<StateReadView, "readRepairAt">;
  record: WorkRecordV1;
  snapshot: RepairStateSnapshotV1;
  expectedStateHead: GitSha;
}): Promise<TakeoverAnchor | null> {
  try {
    const { record, expectedStateHead, state } = input;
    if (!isGitSha(expectedStateHead) || state.readRepairAt === undefined) {
      return null;
    }
    const current = parseRepairStateSnapshotV1(input.snapshot);
    if (
      !equal(current.work.find((row) => row.id === record.id) ?? null, record)
    ) return null;
    const refs = record.evidence.filter((row) =>
      row.ref.startsWith(TAKEOVER_EVIDENCE_NAMESPACE)
    );
    if (refs.length !== 1 || refs[0].kind !== "review_receipt") return null;
    const match = POINTER.exec(refs[0].ref);
    if (
      match === null || match[2] === expectedStateHead || !isGitSha(match[2])
    ) return null;
    const observed = await state.readRepairAt({
      commit: match[2],
      expectedHead: expectedStateHead,
    });
    if (
      !observed.ok || observed.value.status !== "found" ||
      observed.value.head !== match[2]
    ) return null;
    const snapshot = parseRepairStateSnapshotV1(observed.value.snapshot);
    const anchor = snapshot.work.find((row) => row.id === record.id);
    if (anchor === undefined) return null;
    const evidence = anchor.evidence.filter((row) =>
      row.ref.startsWith(TAKEOVER_EVIDENCE_NAMESPACE)
    );
    if (
      !equal(evidence, [takeoverAnchorRef(match[1])]) ||
      anchor.source.kind !== "issue" ||
      anchor.related.issueNumber === null ||
      anchor.source.id !== String(anchor.related.issueNumber) ||
      anchor.related.incidentId !== null ||
      anchor.nextStep !== "blocked" || anchor.blocker?.kind !== "other" ||
      anchor.blocker.message !== TAKEOVER_NATIVE_PRESERVED ||
      anchor.intent !== null ||
      anchor.wait !== null || anchor.target.head === null ||
      anchor.target.pr === null ||
      anchor.target.branch === null || anchor.target.checkpoint !== null ||
      anchor.target.candidateState?.preserved !== null ||
      anchor.target.candidateState.publishedHead !== anchor.target.head ||
      !equal(anchor.repository, record.repository) ||
      !equal(anchor.source, record.source) ||
      !equal(anchor.related, record.related) ||
      anchor.target.pr !== record.target.pr ||
      anchor.target.branch !== record.target.branch
    ) return null;
    return {
      stateHead: match[2],
      record: anchor,
      bindingDigest: match[1],
      nativeRef: await takeoverNativeRef({
        bindingDigest: match[1],
        head: anchor.target.head,
        base: anchor.target.base,
      }),
    };
  } catch {
    return null;
  }
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalStringify(value));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
