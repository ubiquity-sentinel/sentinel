/** Trusted self-only source CAS. Native PR state is observed, never invented. */
import type {
  MergeOutcomeV1,
  MergeRequestV1,
  PortResultV1,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type {
  SelfMergeExecutionV1,
  SelfMergeProofV1,
} from "../contracts/self-merge.ts";
import { parseSelfMergeProof } from "../contracts/self-merge.ts";
import type { GitExecutorV1 } from "./git-executor.ts";
import type { GitHubApiClient } from "./client.ts";
import type { Clock } from "../contracts/ports.ts";

export interface SelfMergeControllerV1 {
  client: GitHubApiClient;
  git: GitExecutorV1;
  clock: Clock;
  author: string;
  authorize(applied: boolean): Promise<PortResultV1<void>>;
  gated<T>(call: () => Promise<PortResultV1<T>>): Promise<PortResultV1<T>>;
}
export async function executeSelfMerge(
  io: SelfMergeControllerV1,
  request: MergeRequestV1,
  context?: SelfMergeExecutionV1,
): Promise<PortResultV1<MergeOutcomeV1>> {
  const g = io.git;
  if (
    context === undefined || typeof context.persist !== "function" ||
    g.readSelfMergeCommit === undefined ||
    g.proveSelfMergeCommit === undefined || g.integrateBase === undefined
  ) return portError("unavailable", "self merge native capability unavailable");
  const acceptance = request.review.taskAcceptance;
  if (
    acceptance === undefined || acceptance === null ||
    acceptance.verdict !== "fulfilled" ||
    context.issueNumber !== acceptance.issueNumber ||
    context.operationKey !==
      `merge:${request.pullRequestNumber}:${request.expectedHead}` ||
    !Number.isSafeInteger(context.deadline)
  ) return portError("invalid", "self merge task binding mismatch");
  const checkDeadline = () => {
    if (io.clock.now() >= context.deadline) throw new Error("deadline");
  };
  const read = (sha: typeof request.expectedHead) =>
    io.gated(() => g.readSelfMergeCommit!(sha));
  let proof = context.proof;
  const save = async (next: SelfMergeProofV1): Promise<PortResultV1<void>> => {
    checkDeadline();
    const parsed = parseSelfMergeProof(next);
    const result = await context.persist(parsed);
    if (result.ok) {
      proof = parsed;
      context.proof = parsed;
    }
    return result;
  };
  try {
    checkDeadline();
    if (proof !== null) {
      proof = parseSelfMergeProof(proof);
      if (
        proof.taskId !== context.taskId ||
        proof.operationKey !== context.operationKey ||
        proof.pr !== request.pullRequestNumber ||
        proof.head !== request.expectedHead ||
        proof.base !== request.expectedBase ||
        proof.headRef !== context.headRef ||
        proof.requestId !== request.review.requestId ||
        proof.resultId !== request.review.resultId ||
        proof.issueNumber !== acceptance.issueNumber ||
        proof.taskDigest !== acceptance.taskDigest
      ) return portError("invalid", "self merge intent identity mismatch");
    }
    const ci = await io.client.readNativeCiEvidence({
      head: request.expectedHead,
      base: request.expectedBase,
      pr: request.pullRequestNumber,
      headRef: context.headRef,
    });
    if (!ci.ok) return ci;
    const base = await read(request.expectedBase),
      head = await read(request.expectedHead),
      tested = await read(ci.value.proof.testedCommit),
      workflow = await read(ci.value.proof.workflowSource);
    if (!base.ok) return base;
    if (!head.ok) return head;
    if (!tested.ok) return tested;
    if (!workflow.ok) return workflow;
    const native = ci.value.proof;
    for (const key of ["workflows", "operations", "config", "lock"] as const) {
      if (
        base.value.pipeline[key] === null ||
        base.value.pipeline[key] !== tested.value.pipeline[key]
      ) return portError("invalid", "self merge trusted CI pipeline changed");
    }
    if (
      proof !== null &&
      (proof.tree !== native.testedTree ||
        proof.ci.proof.testedTree !== proof.tree ||
        proof.ci.proof.head !== proof.head ||
        proof.ci.proof.base !== proof.base || proof.ci.proof.pr !== proof.pr ||
        proof.ci.proof.headRef !== proof.headRef)
    ) return portError("invalid", "self merge preserved CI binding mismatch");
    if (
      native.testedTree !== head.value.tree ||
      tested.value.tree !== head.value.tree ||
      (native.testedCommit !== request.expectedHead &&
        (tested.value.parents.length !== 2 ||
          tested.value.parents[0] !== request.expectedBase ||
          tested.value.parents[1] !== request.expectedHead)) ||
      native.sources.workflow !== base.value.sources.workflow ||
      native.sources.workflow !== workflow.value.sources.workflow ||
      native.sources.harness !== base.value.sources.harness ||
      native.sources.harness !== tested.value.sources.harness ||
      native.sources.emitter !== base.value.sources.emitter ||
      native.sources.emitter !== tested.value.sources.emitter
    ) {
      return portError(
        "invalid",
        "self merge tested tree or trusted source mismatch",
      );
    }
    if (proof === null) {
      const auth = await io.authorize(false);
      if (!auth.ok) return auth;
      const merged = await g.integrateBase(
        request.expectedBase,
        request.expectedHead,
      );
      if (!merged.ok) return merged;
      const commit = await read(merged.value);
      if (!commit.ok) return commit;
      if (
        commit.value.tree !== native.testedTree ||
        commit.value.parents.length !== 2 ||
        commit.value.parents[0] !== request.expectedBase ||
        commit.value.parents[1] !== request.expectedHead
      ) return portError("invalid", "self merge integrated commit mismatch");
      const identity = new TextEncoder().encode(
        JSON.stringify([
          "sentinel-self-merge-v1",
          context.taskId,
          context.operationKey,
          request.expectedBase,
          request.expectedHead,
          merged.value,
          request.review.requestId,
          request.review.resultId,
        ]),
      );
      const digest = [
        ...new Uint8Array(await crypto.subtle.digest("SHA-256", identity)),
      ].map((b) => b.toString(16).padStart(2, "0")).join("");
      const saved = await save({
        version: "v1",
        taskId: context.taskId,
        operationKey: context.operationKey,
        pr: request.pullRequestNumber,
        headRef: context.headRef,
        head: request.expectedHead,
        base: request.expectedBase,
        tree: native.testedTree,
        merge: merged.value,
        ref: `refs/heads/sentinel/self-merge/${digest}`,
        requestId: request.review.requestId,
        resultId: request.review.resultId!,
        issueNumber: acceptance.issueNumber,
        taskDigest: acceptance.taskDigest,
        ci: ci.value,
        stage: "prepared",
        observedTarget: null,
        prState: "open",
      });
      if (!saved.ok) return saved;
    }
    if (proof === null) {
      return portError("unavailable", "self merge intent unavailable");
    }
    const deterministic = await g.integrateBase(
      request.expectedBase,
      request.expectedHead,
    );
    if (!deterministic.ok) return deterministic;
    if (deterministic.value !== proof.merge) {
      return portError("invalid", "self merge deterministic identity mismatch");
    }
    const refInput = new TextEncoder().encode(
      JSON.stringify([
        "sentinel-self-merge-v1",
        context.taskId,
        context.operationKey,
        request.expectedBase,
        request.expectedHead,
        proof.merge,
        request.review.requestId,
        request.review.resultId,
      ]),
    );
    const expectedRef = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", refInput)),
    ].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (proof.ref !== `refs/heads/sentinel/self-merge/${expectedRef}`) {
      return portError("invalid", "self merge operation ref binding mismatch");
    }
    const p = proof;
    const preserved = await io.gated(() => g.readRemoteRef(p.ref));
    if (!preserved.ok) return preserved;
    if (preserved.value !== null && preserved.value !== p.merge) {
      return portError("conflict", "self merge preservation ref moved");
    }
    if (preserved.value === null) {
      const auth = await io.authorize(false);
      if (!auth.ok) return auth;
      checkDeadline();
      const pushed = await io.gated(() => g.push(p.ref, p.merge, null));
      if (!pushed.ok) return pushed;
      const after = await io.gated(() => g.readRemoteRef(p.ref));
      if (!after.ok || after.value !== p.merge) {
        return portOk({ outcome: "ambiguous", head: p.head, mergeSha: null });
      }
    }
    const custody = await io.gated(() => g.proveSelfMergeCommit!(p.ref, p));
    if (!custody.ok) return custody;
    if (!custody.value) {
      return portError("invalid", "self merge object custody mismatch");
    }
    if (p.stage === "prepared") {
      const saved = await save({ ...p, stage: "preserved" });
      if (!saved.ok) return saved;
    }
    const targetRef = "refs/heads/development";
    let target = await io.gated(() => g.readRemoteRef(targetRef));
    if (!target.ok) return target;
    if (
      target.value === p.base &&
      (proof!.stage === "prepared" || proof!.stage === "preserved")
    ) {
      const auth = await io.authorize(false);
      if (!auth.ok) return auth;
      const currentCi = await io.client.readNativeCiEvidence({
        head: p.head,
        base: p.base,
        pr: p.pr,
        headRef: p.headRef,
      });
      if (!currentCi.ok) return currentCi;
      if (currentCi.value.proof.testedTree !== p.tree) {
        return portError("invalid", "self merge native CI changed");
      }
      checkDeadline();
      const pushed = await io.gated(() => g.push(targetRef, p.merge, p.base));
      if (!pushed.ok) return pushed;
      target = await io.gated(() => g.readRemoteRef(targetRef));
      if (!target.ok) {
        return portOk({ outcome: "ambiguous", head: p.head, mergeSha: null });
      }
    }
    if (target.value === null || target.value === p.base) {
      return portOk({ outcome: "ambiguous", head: p.head, mergeSha: null });
    }
    const applied = await io.gated(() => g.proveSelfMergeCommit!(targetRef, p));
    if (!applied.ok) return applied;
    if (!applied.value) {
      return portError(
        "conflict",
        "self merge target moved without exact merge",
      );
    }
    if (proof!.stage === "prepared" || proof!.stage === "preserved") {
      const saved = await save({
        ...proof!,
        stage: "source_applied",
        observedTarget: target.value,
      });
      if (!saved.ok) return saved;
    }
    const auth = await io.authorize(true);
    if (!auth.ok) return auth;
    const pull = await io.client.readPullRequest(p.pr);
    if (!pull.ok) return pull;
    if (pull.value !== null && pull.value.number !== p.pr) {
      return portError("conflict", "self merge PR number mismatch");
    }
    if (
      pull.value === null || pull.value.head !== p.head ||
      pull.value.headRef !== p.headRef ||
      pull.value.baseRef !== "development" || pull.value.author !== io.author ||
      pull.value.body !== `Resolves #${p.issueNumber}`
    ) return portError("conflict", "self merge PR closure identity mismatch");
    if (pull.value.state === "open") {
      checkDeadline();
      const closed = await io.client.closePullRequest(p.pr);
      if (closed.ok && closed.value.number !== p.pr) {
        return portError("conflict", "self merge PR number mismatch");
      }
      if (closed.ok && closed.value.baseRef !== "development") {
        return portError("conflict", "self merge PR branch mismatch");
      }
      if (
        closed.ok &&
        (closed.value.head !== p.head || closed.value.headRef !== p.headRef ||
          closed.value.author !== io.author ||
          closed.value.body !== pull.value.body ||
          closed.value.state === "open")
      ) return portError("conflict", "self merge PR close response mismatch");
    }
    const after = await io.client.readPullRequest(p.pr);
    if (!after.ok) return after;
    if (after.value !== null && after.value.number !== p.pr) {
      return portError("conflict", "self merge PR number mismatch");
    }
    if (after.value !== null && after.value.baseRef !== "development") {
      return portError("conflict", "self merge PR branch mismatch");
    }
    if (
      after.value === null || after.value.state === "open" ||
      after.value.head !== p.head || after.value.headRef !== p.headRef ||
      after.value.author !== io.author ||
      after.value.body !== `Resolves #${p.issueNumber}`
    ) return portError("unavailable", "self merge PR closure unconfirmed");
    if (after.value.state === "merged" && after.value.mergeSha !== p.merge) {
      return portError("conflict", "self merge native merge identity mismatch");
    }
    if (proof!.stage !== "pr_closed" && proof!.stage !== "issue_closed") {
      const saved = await save({
        ...proof!,
        stage: "pr_closed",
        prState: after.value.state,
      });
      if (!saved.ok) return saved;
    }
    const issue = await io.client.readIssue(p.issueNumber);
    if (!issue.ok) return issue;
    if (issue.value === null || issue.value.number !== p.issueNumber) {
      return portError("conflict", "self merge source issue identity mismatch");
    }
    const { reviewTaskStatementDigest } = await import(
      "../contracts/review-receipt.ts"
    );
    if (
      await reviewTaskStatementDigest({
        issueNumber: p.issueNumber,
        title: issue.value.title,
        body: issue.value.body,
      }) !== p.taskDigest
    ) return portError("conflict", "self merge task changed before closure");
    if (issue.value.state === "open") {
      checkDeadline();
      const closed = await io.client.closeIssue(p.issueNumber);
      if (
        closed.ok &&
        (closed.value.number !== p.issueNumber ||
          closed.value.state !== "closed" ||
          closed.value.title !== issue.value.title ||
          closed.value.body !== issue.value.body)
      ) {
        return portError(
          "conflict",
          "self merge issue close response mismatch",
        );
      }
      const observed = await io.client.readIssue(p.issueNumber);
      if (!observed.ok) return observed;
      if (
        observed.value === null || observed.value.number !== p.issueNumber ||
        observed.value.state !== "closed" ||
        observed.value.title !== issue.value.title ||
        observed.value.body !== issue.value.body
      ) return portError("unavailable", "self merge issue closure unconfirmed");
    }
    const saved = await save({ ...proof!, stage: "issue_closed" });
    if (!saved.ok) return saved;
    return portOk({
      outcome: "merged",
      head: p.head,
      mergeSha: p.merge,
      selfMerge: proof!,
    });
  } catch {
    return portError(
      "unavailable",
      "self merge deadline or intent unavailable",
    );
  }
}
