import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  candidateBranch,
  candidatePreservationRef,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import { reservation, workRecord } from "../state/helpers.ts";
import { CLOSED_C_WAVE } from "../../src/host/modern-matrix-recovery.ts";
import { NOW, T0, UNRELATED } from "./owner-install-fixture-constants.ts";

export async function matrixRecoveryState() {
  const work = CLOSED_C_WAVE.cells.map((cell) =>
    workRecord(cell.taskId, {
      createdAt: T0,
      updatedAt: T0 + 1000,
      repository: cell.repository,
      source: {
        kind: "issue",
        id: cell.taskId.split("-").at(-1),
        revision: cell.base,
      },
      related: {
        incidentId: null,
        issueNumber: Number(cell.taskId.split("-").at(-1)),
      },
      failingRevision: null,
      controller: { sha: CLOSED_C_WAVE.runtimeSha },
      counters: { attempts: 1, retries: 0, reviewRounds: 0 },
      target: {
        base: cell.base,
        branch: candidateBranch(cell.taskId as WorkItemId),
        head: null,
        checkpoint: null,
        pr: null,
      },
      intent: {
        kind: "implementation",
        key: implementationIntentKey(cell.reservationId),
        startedAt: T0,
        branch: candidateBranch(cell.taskId as WorkItemId),
        expectedHead: null,
        observedBase: cell.base,
        pr: null,
        requestId: cell.reservationId,
        resultId: null,
      },
    })
  );
  const charges = CLOSED_C_WAVE.cells.map((cell) =>
    reservation(cell.reservationId, {
      createdAt: T0,
      repository: cell.repository,
      taskId: cell.taskId,
      attempt: 1,
      head: cell.base,
    })
  );
  for (let index = 0; index < 13; index++) {
    const requestId = "c".repeat(63) + index.toString(16);
    const id = "older-unrelated-" + index;
    const branch = "sentinel/" + id;
    const repository = {
      owner: "Ubiquity-Sentinel",
      name: "sentinel",
      installationId: 0,
    };
    work.push(workRecord(id, {
      repository,
      createdAt: T0 - 2000,
      updatedAt: T0 - 1000,
      source: { kind: "issue", id: String(1000 + index), revision: UNRELATED },
      related: { incidentId: null, issueNumber: 1000 + index },
      target: {
        base: UNRELATED,
        branch,
        head: null,
        checkpoint: null,
        pr: null,
      },
      counters: { attempts: 1, retries: 0, reviewRounds: 0 },
      intent: {
        kind: "implementation",
        key: implementationIntentKey(requestId),
        startedAt: T0 - 1000,
        branch,
        expectedHead: null,
        observedBase: UNRELATED,
        pr: null,
        requestId,
        resultId: null,
      },
    }));
    charges.push(
      reservation(requestId, {
        repository,
        taskId: id,
        head: UNRELATED,
        createdAt: T0 - 1000,
      }),
    );
  }
  const original = parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    sequence: 1,
    stateHead: null,
    updatedAt: T0 + 3000,
    incidents: [],
    evidence: [],
    work,
    reservations: charges,
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
  const ingestedWork = await Promise.all(work.map(async (row, index) => {
    if (index >= CLOSED_C_WAVE.cells.length) return row;
    if (index >= 18) {
      return {
        ...row,
        nextStep: "blocked",
        blocker: {
          kind: "other",
          since: NOW,
          message: "matrix result unavailable",
        },
        updatedAt: NOW,
      };
    }
    const head = "b".repeat(40) as GitSha;
    const protectedCandidate = row.id === "issue-ubiquity-ai.ubq.fi-751";
    return {
      ...row,
      target: {
        ...row.target,
        head,
        checkpoint: null,
        candidateState: { preserved: null, publishedHead: null },
      },
      intent: protectedCandidate ? null : {
        ...row.intent!,
        kind: "candidate_preservation",
        branch: await candidatePreservationRef(
          row.repository,
          row.id,
          row.intent!.key,
        ),
        expectedHead: head,
      },
      nextStep: protectedCandidate ? "blocked" : "work",
      blocker: protectedCandidate
        ? {
          kind: "other",
          since: NOW,
          message: "candidate touches a protected path",
        }
        : null,
      updatedAt: NOW,
    };
  }));
  const ingested = parseRepairStateSnapshotV1({
    ...original,
    sequence: 2,
    updatedAt: NOW,
    work: ingestedWork,
    reservations: charges.map((row, index) =>
      index >= CLOSED_C_WAVE.cells.length ? row : ({
        ...row,
        outcome: index < 18 ? "submitted" : "ambiguous",
        settledAt: NOW,
      })
    ),
  });
  return { original, ingested };
}
