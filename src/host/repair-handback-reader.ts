/**
 * The serial repair job's read of the records its own run's repository cells
 * handed back to the trusted path (issue #328).
 *
 * A cell hands back a delegated record whose step needs an effect a cell may
 * not perform (a refresh, a review start, a publication, a merge). The serial
 * job runs beside the cells; once every repository cell job of this attempt
 * has completed, this read authenticates their deltas exactly as finalize
 * does (`authenticateRepairFanout`: this run's protected dispatch, the plan
 * the native outputs named, each cell's own completed producer job and the
 * marker in its log binding the runtime, generation and delta seal), opens
 * each delta for this run, plan and repository, and returns the delegated
 * records each one handed back. The serial pass then steps them in this run.
 *
 * Read-only and bounded: no request starts at or after `until`, and the plan
 * or a cell's delta that cannot be authenticated yet (a run, log or artifact
 * not served yet) is read again a bounded number of times; a plan never
 * authenticated hands nothing back. A cell never read is simply not
 * taken over: finalize drops its records' stamps as before, so the next plan
 * returns them to the serial pass. Nothing here writes state, applies a delta
 * or performs an effect.
 */
import { openRepairDeltaV1 } from "../contracts/repair-delta.ts";
import type { Clock, StateReadView } from "../contracts/ports.ts";
import { createDeadline, type HttpTransportV1 } from "../github/http.ts";
import { repairFanoutBindingV1 } from "../repair/repair-fanout-plan.ts";
import { createMatrixArtifactArchive } from "./matrix-artifact-archive.ts";
import type { MatrixArtifactReaderV1 } from "./matrix-artifact-context.ts";
import { createMatrixArtifactHttp } from "./matrix-artifact-http.ts";
import type {
  RepairHandbackRequestV1,
  RepairHandbackV1,
} from "./matrix-artifact-port.ts";
import { authenticateRepairFanout } from "./repair-fanout-finalize.ts";

/** Interval between reads while a repository cell is still running. */
export const REPAIR_HANDBACK_POLL_MS = 15_000;
/**
 * Authenticated reads once every cell completed: a log or artifact GitHub
 * has not served yet is read again, a cell that never authenticates is left
 * to finalize instead of holding the serial job.
 */
export const REPAIR_HANDBACK_AUTH_READS = 4;
const CELL_JOB = "repair_cell (";

type Reader = Pick<MatrixArtifactReaderV1, "json" | "pages" | "download">;
type Archive = ReturnType<typeof createMatrixArtifactArchive>;

export interface RepairHandbackSeamsV1 {
  reader?: Reader;
  archive?: Archive;
  /** The pause between reads; tests advance their clock instead. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal.aborted) done();
    else signal.addEventListener("abort", done, { once: true });
  });
}

/** True once every repository cell job of this attempt has completed. */
async function cellsCompleted(
  reader: Reader,
  run: RepairHandbackRequestV1["run"],
): Promise<boolean> {
  const jobs = await reader.pages(
    `/runs/${run.runId}/attempts/${run.runAttempt}/jobs`,
    "jobs",
  );
  const cells = jobs.filter((job) =>
    typeof job.name === "string" && job.name.startsWith(CELL_JOB)
  );
  return cells.length > 0 && cells.every((job) => job.status === "completed");
}

export async function readRepairHandbacks(
  options: {
    state: StateReadView;
    token: string;
    http: HttpTransportV1;
    clock: Clock;
  },
  request: RepairHandbackRequestV1,
  seams: RepairHandbackSeamsV1 = {},
): Promise<RepairHandbackV1[] | null> {
  const started = options.clock.now();
  if (request.until <= started) return null;
  const deadline = createDeadline(request.until - started);
  const controller = new AbortController();
  const stop = () => controller.abort();
  request.signal?.addEventListener("abort", stop, { once: true });
  if (request.signal?.aborted === true) stop();
  try {
    const reader = seams.reader ?? createMatrixArtifactHttp(
      { ...options, artifactRoot: "" },
      request.until,
      deadline,
      { id: null },
    );
    const archive = seams.archive ??
      createMatrixArtifactArchive(reader.download, deadline, controller);
    const wait = seams.wait ?? pause;
    /** Per authenticated cell: the records it handed back. */
    const read = new Map<string, RepairHandbackV1>();
    let planned: number | null = null;
    let reads = 0;
    while (!controller.signal.aborted) {
      try {
        if (await cellsCompleted(reader, request.run)) {
          reads++;
          const authenticated = await authenticateRepairFanout(
            {
              clock: options.clock,
              run: request.run,
              runtime: request.runtime,
              planDigest: request.planDigest,
            },
            reader,
            archive,
          );
          // A plan GitHub did not serve (or not yet) is read again within
          // the same bound as a cell's delta.
          if (authenticated === null) throw new Error("plan unauthenticated");
          planned = authenticated.plan.cells.length;
          const binding = await repairFanoutBindingV1(authenticated.plan);
          for (const artifact of authenticated.artifacts) {
            const cell = authenticated.plan.cells.find((entry) =>
              entry.cellId === artifact.cellId
            );
            if (cell === undefined || read.has(cell.cellId)) continue;
            // A refusal, or a sealed delta that does not open, hands nothing
            // back; a missing or not yet authenticated one is read again.
            if (artifact.refused === true) {
              read.set(cell.cellId, {
                repository: cell.repository,
                records: [],
              });
              continue;
            }
            if (
              artifact.envelope === null ||
              artifact.envelope === "unauthenticated"
            ) continue;
            const opened = await openRepairDeltaV1(artifact.envelope, {
              binding,
              repository: cell.repository,
            });
            const scope = new Set(cell.records);
            read.set(cell.cellId, {
              repository: cell.repository,
              records: opened.ok
                ? opened.delta.deferredToTrusted.filter((id) => scope.has(id))
                : [],
            });
          }
          if (read.size >= planned) break;
        }
      } catch { /* an unavailable read is read again while time remains */ }
      if (
        reads >= REPAIR_HANDBACK_AUTH_READS ||
        options.clock.now() + REPAIR_HANDBACK_POLL_MS >= request.until
      ) break;
      await wait(REPAIR_HANDBACK_POLL_MS, controller.signal);
    }
    // Read, but never authenticated: nothing is taken over.
    if (reads > 0 && planned === null) return null;
    return [...read.values()].filter((entry) => entry.records.length > 0);
  } catch {
    return null;
  } finally {
    request.signal?.removeEventListener("abort", stop);
    controller.abort();
    deadline.dispose();
  }
}
