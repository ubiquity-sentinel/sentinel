import type { GitSha } from "../../src/contracts/brands.ts";
import type {
  NativeTakeoverObservation,
  TakeoverCandidateObservation,
  TakeoverProofRequest,
} from "../../src/contracts/existing-pr-takeover.ts";
import { portOk, type StateReadView } from "../../src/contracts/ports.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { createTakeoverProofPort } from "../../src/github/existing-pr-takeover-proof.ts";
import {
  TAKEOVER_NATIVE_PRESERVED,
  takeoverAnchorRef,
  takeoverBindingDigest,
  takeoverNativeRef,
  takeoverProvenanceRef,
} from "../../src/github/existing-pr-takeover-provenance.ts";
import { REPO, SHA1, SHA2, SHA3, T0, workRecord } from "../state/helpers.ts";
import { seededSnapshot } from "../repair/loop-rig.ts";

export const CURRENT = "d".repeat(40) as GitSha;
export const NEXT = "e".repeat(40) as GitSha;
export async function takeoverFixture() {
  const clock = {
    value: T0 + 100,
    now() {
      return this.value;
    },
  };
  const policy = { activated: true };
  let fence = true;
  const binding = {
    repository: REPO,
    taskId: workRecord("issue-1").id,
    issueNumber: 1,
    issueNodeId: "I_1",
    issueDigest: "f".repeat(64),
    pullRequest: 999,
    pullNodeId: "PR_999",
    headRepositoryId: "R_target",
    headRepository: { owner: REPO.owner, name: REPO.name },
    headRef: "human/issue-1",
    baseRef: "development",
    author: "human-owner",
  };
  const bindingDigest = await takeoverBindingDigest(binding);
  const anchor = workRecord("issue-1", {
    source: { kind: "issue", id: "1", revision: SHA1 },
    related: { incidentId: null, issueNumber: 1 },
    nextStep: "blocked",
    blocker: { kind: "other", message: TAKEOVER_NATIVE_PRESERVED, since: T0 },
    wait: null,
    intent: null,
    target: {
      base: SHA1,
      branch: binding.headRef,
      checkpoint: null,
      head: SHA3,
      pr: 999,
      candidateState: { preserved: null, publishedHead: SHA3 },
    },
    evidence: [takeoverAnchorRef(bindingDigest)],
  });
  const ancestor = parseRepairStateSnapshotV1(seededSnapshot([anchor]));
  const record = structuredClone(anchor);
  record.nextStep = "review";
  record.blocker = null;
  record.evidence = [takeoverProvenanceRef(bindingDigest, SHA2)];
  const snapshot = parseRepairStateSnapshotV1({
    ...ancestor,
    stateHead: SHA2,
    sequence: 2,
    work: [record],
  });
  const request: TakeoverProofRequest = {
    record: snapshot.work[0],
    snapshot,
    expectedStateHead: CURRENT,
    expectedHead: SHA3,
    operation: "review",
    deadline: T0 + 60_000,
  };
  const native: NativeTakeoverObservation = {
    binding,
    head: SHA3,
    base: SHA1,
    state: "open",
    issueOpen: true,
    associationComplete: true,
    associated: true,
    reciprocalComplete: true,
    reciprocalIssues: [{
      number: 1,
      nodeId: "I_1",
      repository: { owner: REPO.owner, name: REPO.name },
    }],
    openCandidates: [{ number: 999, nodeId: "PR_999" }],
    headRefExists: true,
    sameRepository: true,
    writableBranch: true,
    protectedPathsClear: true,
    queueCustodyClear: true,
  };
  const candidate: TakeoverCandidateObservation = {
    anchorRef: await takeoverNativeRef({
      bindingDigest,
      head: SHA3,
      base: SHA1,
    }),
    anchorHead: SHA3,
    anchorRestored: true,
    currentHead: SHA3,
    currentBase: SHA1,
    custody: { kind: "native" },
    currentDescendsFromAnchor: true,
    nextHead: null,
    nextDescendsFromExpected: false,
  };
  const hooks = { native: () => {}, candidate: () => {} };
  const stateControl = { head: CURRENT, ancestorAvailable: true };
  const state: Pick<StateReadView, "readRepair" | "readRepairAt"> = {
    readRepair: () =>
      Promise.resolve(
        portOk({
          status: "found",
          snapshot: structuredClone(request.snapshot),
          head: stateControl.head,
          ref: null,
        }),
      ),
    readRepairAt: ({ commit, expectedHead }) =>
      Promise.resolve(portOk(
        stateControl.ancestorAvailable && commit === SHA2 &&
          expectedHead === stateControl.head
          ? {
            status: "found",
            snapshot: structuredClone(ancestor),
            head: SHA2,
            ref: null,
          }
          : { status: "absent", currentHead: stateControl.head, ref: null },
      )),
  };
  const deps = {
    state,
    clock,
    repository: REPO,
    baseBranch: "development",
    policy,
    runtimeCapabilityAccepted: () => fence,
    principal: { revalidate: () => Promise.resolve(portOk(undefined)) },
    readNative: () => {
      hooks.native();
      return Promise.resolve(portOk(structuredClone(native)));
    },
    readCandidate: () => {
      hooks.candidate();
      return Promise.resolve(portOk(structuredClone(candidate)));
    },
  };
  return {
    clock,
    policy,
    denyFence: () => {
      fence = false;
    },
    bindingDigest,
    ancestor,
    request,
    native,
    candidate,
    hooks,
    stateControl,
    deps,
    port: createTakeoverProofPort(deps),
  };
}
