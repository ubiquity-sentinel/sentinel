/**
 * Part D: the known positives the checker must catch on the code they were
 * fixed in.
 *
 * (a) Re-retiring already retired records (fixed in 01f482529): the
 *     retirement fairness harness (`fleet.ts`) over the verbatim pre-fix
 *     planner (`fixtures/closures-pre-01f482529.ts`), whose body is pinned
 *     here to the immutable historical source, independently of later guards.
 * (b) The base_moved delivery loop (fixed in 180769ef4 and d3f2f7158): the
 *     lifecycle model with `preFixMergeReconcile` (`pipeline.ts`).
 * (c) The output-bound overrun (fixed in 63143fb92, torn re-entry refined in
 *     614a4fa02): the producer pass's per-pass outcome over the overrun
 *     cell's custody states, with the cell classified by the REAL
 *     `outputBoundCells`/`outputBoundOverrun` over the live 1127 receipt
 *     facts (tests/fixtures/host/output-bound-overrun-v1.json). The pass
 *     outcome table is transcribed from the producer pass (anchored); the
 *     pre-fix variant is the same bad-entry filter without the overrun
 *     exclusion, which is the whole of 63143fb92's change to that filter.
 */
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  matrixBundleFileNameV1,
  type MatrixCellPlanV1,
  type MatrixCellResultV1,
  matrixDigestV1,
  parseMatrixCellResultV1,
} from "../../src/contracts/matrix.ts";
import type { MatrixIngestReportV1 } from "../../src/host/matrix-ingest.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  HISTORICAL_RECOVERY_PROVIDERS,
  RECOVERY_ROUTE_FAILOVER_MODEL,
} from "../../ops/hosted-autonomy-matrix-bindings.ts";
import {
  outputBoundCells,
  outputBoundOverrun,
} from "../../ops/hosted-autonomy-output-bound.ts";
import { anchor, read } from "./anchors.ts";

// ------------------------------------------------- (a) fixture integrity
/** The fix's inserted block, exactly as 01f482529 added it. */
const RETIREMENT_FIX_BLOCK =
  `    // Already retired (this exact parking): planning it again would rewrite
    // the same row every pass and take a retirement slot from a record that
    // still needs one.
    if (
      record.nextStep === "blocked" && record.intent === null &&
      record.blocker?.kind === "other" &&
      record.blocker.message === HOSTED_AUTONOMY_RETIRED
    ) continue;
`;

function functionBody(text: string, name: string): string {
  const start = text.indexOf(`export function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = text.indexOf("\n}\n", start);
  return text.slice(start, end + 3);
}

/**
 * Pin the historical function body even in shallow checkouts. The digest is
 * from `01f482529^:ops/hosted-autonomy-closures.ts`; imports are intentionally
 * re-pointed in the fixture. Later queue custody guards change the current
 * body, but must neither rewrite this positive nor remove the retirement fix.
 * The paired fairness test executes both planners, so merely retaining the
 * fix's text cannot establish that the current planner makes progress.
 */
export async function preFixFixtureFaithful(): Promise<boolean> {
  const current = functionBody(
    await read("ops/hosted-autonomy-closures.ts"),
    "planHostedRetirements",
  );
  const fixture = functionBody(
    await read("tests/model/fixtures/closures-pre-01f482529.ts"),
    "planHostedRetirements",
  );
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fixture)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return current.includes(RETIREMENT_FIX_BLOCK) &&
    digest ===
      "c4cc69ac2afd28a0f7dcb2994069a4a933062ee5d827c9eb8d913eaa20369aab";
}

// ------------------------------------------------- (c) output-bound overrun
const LIVE = JSON.parse(
  await Deno.readTextFile(
    new URL("../fixtures/host/output-bound-overrun-v1.json", import.meta.url),
  ),
) as {
  work: WorkRecordV1[];
  runtime: {
    lastExecutionProof: {
      execution: {
        runId: number;
        runAttempt: number;
        launcherSha: string;
        revision: string;
        generation: number;
        id: string;
      };
    };
  };
};

const OVER = "issue-ubiquity-ai.ubq.fi-1127";
const ROUTE = {
  expectedProvider: HISTORICAL_RECOVERY_PROVIDERS,
  failoverModel: RECOVERY_ROUTE_FAILOVER_MODEL,
};

/** The live 1127 cell and its completed-past-bound result (live facts). */
async function overrunCell(): Promise<{
  cell: MatrixCellPlanV1;
  result: MatrixCellResultV1;
}> {
  const record = LIVE.work.find((row) => row.id === OVER)!;
  const execution = LIVE.runtime.lastExecutionProof.execution;
  const request = {
    taskId: record.id,
    repository: record.repository,
    base: record.target.base,
    issue: {
      number: record.related.issueNumber!,
      title: `issue ${record.related.issueNumber}`,
      body: "body",
    },
    evidence: [],
    model: "route-model",
    reasoning: "max",
    maxDurationMs: 1_800_000,
    maxOutputChars: 4_000_000,
  };
  const cell = {
    cellId: "f057b43c2fadb6d7a651972c346c18dde178f5733fa95af43f62527febdfe646",
    taskId: record.id,
    repository: record.repository,
    reservationId: record.intent!.requestId!,
    intentKey: record.intent!.key,
    expectedBase: record.target.base,
    runtimeSha: execution.revision,
    generation: execution.generation,
    requestDigest: await matrixDigestV1(request),
    request,
  } as unknown as MatrixCellPlanV1;
  const head = "1127".repeat(10) as GitSha;
  const result = parseMatrixCellResultV1({
    version: "v1",
    kind: "matrix_cell_result",
    waveId: execution.id,
    cellId: cell.cellId,
    taskId: cell.taskId,
    repository: cell.repository,
    run: {
      runId: execution.runId,
      runAttempt: execution.runAttempt,
      launcherSha: execution.launcherSha,
    },
    runtimeSha: cell.runtimeSha,
    generation: cell.generation,
    reservationId: cell.reservationId,
    intentKey: cell.intentKey,
    requestDigest: cell.requestDigest,
    status: "completed",
    receipt: {
      invocationId: "invocation-1127",
      outcome: "completed",
      actual: {
        evidenceKind: "request-runtime",
        provider: "uos",
        threadId: "thread-1127",
        turnId: "turn-1127",
        terminalOrigin: "runtime",
        observedTerminalStatus: "completed",
        observedModel: "route-model",
        observedReasoning: "max",
        durationMs: 779_963,
        outputChars: 4_005_441,
      },
      candidate: { head, checkpointSha: null, changedPaths: ["src/app.ts"] },
      error: null,
    },
    bundle: {
      file: matrixBundleFileNameV1(cell.cellId),
      digest: await matrixDigestV1(cell.cellId),
      head,
      checkpointSha: null,
    },
    detail: null,
    completedAt: Date.parse("2026-10-17T00:05:00Z"),
  });
  return { cell, result };
}

/** Custody of the overrun cell's charge and record. */
export type OverrunCustodyV1 =
  /** Charge reserved, record on its implementation intent (the incident). */
  | "reserved"
  /** First settlement write landed: charge ambiguous, record still working. */
  | "torn"
  /** Charge ambiguous, record blocked with the interrupted-bound detail. */
  | "settled";

export type MaintenanceOutcomeV1 =
  | "throws"
  | "applied"
  | "deferred"
  | "no_entry";

export interface ProducerStepV1 {
  outcome: MaintenanceOutcomeV1;
  next: OverrunCustodyV1;
  /** The settlement's record write was refused (adversarial infra). */
  refused?: boolean;
}

const PRODUCER = "ops/hosted-autonomy-producer-recovery.ts";
const PRODUCER_ANCHORS = {
  filter: anchor(
    "c.badEntriesExcludeOverrun",
    PRODUCER,
    "!overBound.has(entry.cellId),",
  ),
  fatal: anchor(
    "c.integrityFault",
    PRODUCER,
    `throw integrityFault("current matrix ingestion incomplete");`,
  ),
  deferred: anchor(
    "c.settleDeferred",
    PRODUCER,
    "      if (!bounded) {",
  ),
  torn: anchor(
    "c.tornPairAccepted",
    "ops/hosted-autonomy-output-bound.ts",
    `(charge.outcome === "ambiguous" && charge.settledAt !== null &&
      record.nextStep === "work");`,
  ),
  runnerEnds: anchor(
    "c.maintenanceEndsPass",
    "ops/hosted-autonomy-runner.ts",
    'if (maintenance.status !== "applied") return maintenance;',
  ),
  runnerThrows: anchor(
    "c.integrityRethrown",
    "ops/hosted-autonomy-runner.ts",
    "if (!continued || integrityFault(error)) throw error;",
  ),
};

/**
 * One producer pass over the overrun cell. `excluded` is the REAL
 * classifier's verdict (`outputBoundCells` contains the cell): the current
 * filter drops it from the bad entries, the pre-fix filter (2bc1ee776) has
 * no such exclusion, so the refusal is a bad entry and the pass throws.
 */
export function producerPass(
  version: "current" | "pre-63143fb92",
  custody: OverrunCustodyV1,
  excluded: boolean,
): ProducerStepV1[] {
  if (custody === "settled") {
    // The record no longer works the cell's intent: the walk requests no
    // ingest for it (nothing pending), so the pass goes on.
    return [{ outcome: "no_entry", next: "settled" }];
  }
  const bad = version === "pre-63143fb92" || !excluded;
  if (bad) return [{ outcome: "throws", next: custody }];
  // Settled in two writes; the record write may be refused (a torn pair),
  // which defers the pass; a pair torn before the pass is finished.
  return [
    { outcome: "applied", next: "settled" },
    { outcome: "deferred", next: "torn", refused: true },
  ];
}

export interface OverrunVerdictV1 {
  version: "current" | "pre-63143fb92";
  excluded: boolean;
  overrun: boolean;
  /** A custody state whose every pass throws without a write. */
  stuck: OverrunCustodyV1 | null;
  /** Passes to `settled` when no write is refused. */
  passesToSettle: number | null;
  anchors: string[];
}

/** Explore the producer pass from the incident's custody state. */
export async function outputBoundVerdict(
  version: "current" | "pre-63143fb92",
): Promise<OverrunVerdictV1> {
  const { cell, result } = await overrunCell();
  const overrun = outputBoundOverrun(result, cell, ROUTE);
  const report: MatrixIngestReportV1 = {
    waveId: result.waveId,
    entries: [{
      cellId: cell.cellId,
      disposition: "receipt_rejected",
      detail: "receipt does not verify against the exact planned request",
    }],
    ingested: 0,
  } as MatrixIngestReportV1;
  const excluded = outputBoundCells(report, [cell], [result], ROUTE).has(
    cell.cellId,
  );
  let stuck: OverrunCustodyV1 | null = null;
  // Reachable custody states and their per-pass outcomes.
  const seen = new Set<OverrunCustodyV1>(["reserved"]);
  const queue: OverrunCustodyV1[] = ["reserved"];
  while (queue.length > 0) {
    const custody = queue.shift()!;
    const steps = producerPass(version, custody, excluded);
    if (steps.every((step) => step.outcome === "throws")) stuck = custody;
    for (const step of steps) {
      if (!seen.has(step.next)) {
        seen.add(step.next);
        queue.push(step.next);
      }
    }
  }
  // Cooperative world (no refused write): passes until settled.
  let passesToSettle: number | null = null;
  let custody: OverrunCustodyV1 = "reserved";
  for (let pass = 1; pass <= 8; pass++) {
    const step: ProducerStepV1 = producerPass(version, custody, excluded).find((
      row,
    ) => row.refused !== true)!;
    custody = step.next;
    if (custody === "settled") {
      passesToSettle = pass;
      break;
    }
  }
  return {
    version,
    excluded,
    overrun,
    stuck,
    passesToSettle,
    anchors: Object.values(PRODUCER_ANCHORS),
  };
}
