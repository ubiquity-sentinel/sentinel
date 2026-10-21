/** Facts emitted only by the protected native CI wrapper; parsing is not authentication. */
import type { GitSha } from "./brands.ts";
import {
  expectExactKeys,
  expectGitSha,
  expectNonEmptyString,
  expectPositiveInt,
  expectRecord,
  expectVersion,
  fail,
  MaxText,
} from "./validation.ts";

export const NATIVE_CI_MARKER = "sentinel_native_ci_v1:";
export const NATIVE_CI_SOURCES = [
  ".github/workflows/ci.yml",
  "test-local.ts",
  "ops/native-ci-proof.ts",
] as const;
export interface NativeCiProofV1 {
  version: "v1";
  repository: "Ubiquity-Sentinel/sentinel";
  repositoryId: number;
  runId: number;
  attempt: number;
  job: "test-local";
  pr: number;
  headRef: string;
  head: GitSha;
  base: GitSha;
  testedCommit: GitSha;
  testedTree: GitSha;
  workflowSource: GitSha;
  sources: { workflow: GitSha; harness: GitSha; emitter: GitSha };
}
export interface NativeCiEvidenceV1 {
  proof: NativeCiProofV1;
  jobId: number;
  checkId: number;
}
export function parseNativeCiProof(
  input: unknown,
  path = "$",
): NativeCiProofV1 {
  const o = expectRecord(input, path);
  expectExactKeys(o, [
    "version",
    "repository",
    "repositoryId",
    "runId",
    "attempt",
    "job",
    "pr",
    "headRef",
    "head",
    "base",
    "testedCommit",
    "testedTree",
    "workflowSource",
    "sources",
  ], path);
  expectVersion(o.version, `${path}.version`);
  if (o.repository !== "Ubiquity-Sentinel/sentinel" || o.job !== "test-local") {
    fail(path, "invalid_value", "native CI scope mismatch");
  }
  const s = expectRecord(o.sources, `${path}.sources`);
  expectExactKeys(s, ["workflow", "harness", "emitter"], `${path}.sources`);
  return {
    version: "v1",
    repository: "Ubiquity-Sentinel/sentinel",
    repositoryId: expectPositiveInt(o.repositoryId, `${path}.repositoryId`),
    runId: expectPositiveInt(o.runId, `${path}.runId`),
    attempt: expectPositiveInt(o.attempt, `${path}.attempt`),
    job: "test-local",
    pr: expectPositiveInt(o.pr, `${path}.pr`),
    headRef: expectNonEmptyString(o.headRef, `${path}.headRef`, MaxText.branch),
    head: expectGitSha(o.head, `${path}.head`),
    base: expectGitSha(o.base, `${path}.base`),
    testedCommit: expectGitSha(o.testedCommit, `${path}.testedCommit`),
    testedTree: expectGitSha(o.testedTree, `${path}.testedTree`),
    workflowSource: expectGitSha(o.workflowSource, `${path}.workflowSource`),
    sources: {
      workflow: expectGitSha(s.workflow, `${path}.sources.workflow`),
      harness: expectGitSha(s.harness, `${path}.sources.harness`),
      emitter: expectGitSha(s.emitter, `${path}.sources.emitter`),
    },
  };
}
export function parseNativeCiEvidence(
  input: unknown,
  path = "$",
): NativeCiEvidenceV1 {
  const o = expectRecord(input, path);
  expectExactKeys(o, ["proof", "jobId", "checkId"], path);
  return {
    proof: parseNativeCiProof(o.proof, `${path}.proof`),
    jobId: expectPositiveInt(o.jobId, `${path}.jobId`),
    checkId: expectPositiveInt(o.checkId, `${path}.checkId`),
  };
}
