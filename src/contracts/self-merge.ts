/** Trusted self-source CAS intent/receipt, separate from GitHub's merged flag. */
import type { GitSha, WorkItemId } from "./brands.ts";
import type { PortResultV1 } from "./ports.ts";
import { type NativeCiEvidenceV1, parseNativeCiEvidence } from "./native-ci.ts";
import {
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNonEmptyString,
  expectNullable,
  expectPattern as expectExactPattern,
  expectPositiveInt,
  expectRecord,
  expectVersion,
  fail,
  MaxText,
} from "./validation.ts";
function expectPattern(value: unknown, path: string, pattern: RegExp): string {
  return expectExactPattern(
    value,
    path,
    pattern,
    "invalid_pattern",
    "self merge identity pattern mismatch",
    MaxText.branch,
  );
}

export interface SelfMergeProofV1 {
  version: "v1";
  taskId: WorkItemId;
  operationKey: string;
  pr: number;
  headRef: string;
  head: GitSha;
  base: GitSha;
  tree: GitSha;
  merge: GitSha;
  ref: string;
  requestId: string;
  resultId: string;
  issueNumber: number;
  taskDigest: string;
  ci: NativeCiEvidenceV1;
  stage:
    | "prepared"
    | "preserved"
    | "source_applied"
    | "pr_closed"
    | "issue_closed";
  observedTarget: GitSha | null;
  prState: "open" | "closed" | "merged";
}
export interface SelfMergeExecutionV1 {
  taskId: WorkItemId;
  issueNumber: number | null;
  headRef: string;
  operationKey: string;
  deadline: number;
  proof: SelfMergeProofV1 | null;
  persist(proof: SelfMergeProofV1): Promise<PortResultV1<void>>;
}
export function parseSelfMergeProof(
  input: unknown,
  path = "$",
): SelfMergeProofV1 {
  const o = expectRecord(input, path);
  expectExactKeys(o, [
    "version",
    "taskId",
    "operationKey",
    "pr",
    "headRef",
    "head",
    "base",
    "tree",
    "merge",
    "ref",
    "requestId",
    "resultId",
    "issueNumber",
    "taskDigest",
    "ci",
    "stage",
    "observedTarget",
    "prState",
  ], path);
  expectVersion(o.version, `${path}.version`);
  const proof: SelfMergeProofV1 = {
    version: "v1",
    taskId: expectNonEmptyString(
      o.taskId,
      `${path}.taskId`,
      MaxText.recordId,
    ) as WorkItemId,
    operationKey: expectNonEmptyString(
      o.operationKey,
      `${path}.operationKey`,
      MaxText.token,
    ),
    pr: expectPositiveInt(o.pr, `${path}.pr`),
    headRef: expectNonEmptyString(o.headRef, `${path}.headRef`, MaxText.branch),
    head: expectGitSha(o.head, `${path}.head`),
    base: expectGitSha(o.base, `${path}.base`),
    tree: expectGitSha(o.tree, `${path}.tree`),
    merge: expectGitSha(o.merge, `${path}.merge`),
    ref: expectPattern(
      o.ref,
      `${path}.ref`,
      /^refs\/heads\/sentinel\/self-merge\/[a-f0-9]{64}$/,
    ),
    requestId: expectNonEmptyString(
      o.requestId,
      `${path}.requestId`,
      MaxText.recordId,
    ),
    resultId: expectNonEmptyString(
      o.resultId,
      `${path}.resultId`,
      MaxText.recordId,
    ),
    issueNumber: expectPositiveInt(o.issueNumber, `${path}.issueNumber`),
    taskDigest: expectPattern(
      o.taskDigest,
      `${path}.taskDigest`,
      /^[a-f0-9]{64}$/,
    ),
    ci: parseNativeCiEvidence(o.ci, `${path}.ci`),
    stage: expectEnum(o.stage, [
      "prepared",
      "preserved",
      "source_applied",
      "pr_closed",
      "issue_closed",
    ], `${path}.stage`),
    observedTarget: expectNullable(
      o.observedTarget,
      `${path}.observedTarget`,
      expectGitSha,
    ),
    prState: expectEnum(
      o.prState,
      ["open", "closed", "merged"],
      `${path}.prState`,
    ),
  };
  const ci = proof.ci.proof;
  if (
    ci.pr !== proof.pr || ci.head !== proof.head || ci.base !== proof.base ||
    ci.headRef !== proof.headRef || ci.testedTree !== proof.tree ||
    proof.operationKey !== `merge:${proof.pr}:${proof.head}`
  ) fail(path, "invalid_lifecycle", "self merge tuple contradicts native CI");
  const beforeSource = proof.stage === "prepared" ||
    proof.stage === "preserved";
  const closed = proof.stage === "pr_closed" || proof.stage === "issue_closed";
  if (
    (beforeSource && proof.observedTarget !== null) ||
    (!beforeSource && proof.observedTarget === null) ||
    (closed && proof.prState === "open") ||
    (!closed && proof.prState !== "open")
  ) {
    fail(
      path,
      "invalid_lifecycle",
      "self merge phase contradicts its native observations",
    );
  }
  return proof;
}
