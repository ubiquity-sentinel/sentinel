import type {
  ModelIdV1,
  ModelRunReceiptV1,
  ModelRunRequestV1,
  PortErrorKindV1,
  PortResultV1,
  ReasoningEffortV1,
} from "../contracts/ports.ts";
import { localCheckoutKey } from "./local-checkout.ts";
import {
  localModelResultReason,
  type LocalModelResultReasonV1,
} from "./local-model-reason.ts";
import { emitLocalModelDiagnostic } from "./local-model-diagnostic.ts";
import { ensurePrivateDir, joinPath, writePrivateFile } from "./local-io.ts";

/**
 * Minimal private JSON projection of exactly one local model result. It is an
 * explicit allow-list: no issue, evidence, prompt, changed path, raw error or
 * credential content is ever serialized.
 */
export interface LocalModelResultProjectionV1 {
  version: "v1";
  kind: "local_model_result";
  taskId: string;
  base: string;
  requested: {
    model: ModelIdV1;
    reasoning: ReasoningEffortV1;
    maxDurationMs: number;
    maxOutputChars: number;
  };
  observedAt: number;
  result:
    | {
      ok: true;
      outcome: "completed" | "failed" | "interrupted";
      actual: {
        provider: string;
        threadId: string;
        turnId: string;
        terminalOrigin: "runtime" | "host-timeout";
        observedTerminalStatus: "completed" | "interrupted" | "failed" | null;
        observedModel: string;
        observedReasoning: string;
        durationMs: number;
        outputChars: number;
      };
      candidate: { head: string | null; changedPathCount: number } | null;
    }
    | { ok: false; errorKind: PortErrorKindV1 };
  reason: LocalModelResultReasonV1;
}

/**
 * Persist one private minimal model-result diagnostic for a task under
 * `<stateRoot>/model-results/<localCheckoutKey(taskId)>/`, using a unique
 * `crypto.randomUUID()` filename, private 0700 directories and a 0600 file.
 * Returns the exact written path. This diagnostic stays outside every model
 * checkout. After the private report is saved, one strictly validated advisory
 * summary line is emitted for the existing Actions log; that summary never
 * changes this path, this file or any caller result. A throw means the receipt
 * was not saved: the caller must not import or publish a candidate.
 */
export async function writeLocalModelResult(
  stateRoot: string,
  request: ModelRunRequestV1,
  result: PortResultV1<ModelRunReceiptV1>,
  observedAt: number,
): Promise<string> {
  const key = await localCheckoutKey(request.taskId);
  const root = joinPath(stateRoot, "model-results");
  const dir = joinPath(root, key);
  await ensurePrivateDir(stateRoot);
  await ensurePrivateDir(root);
  await ensurePrivateDir(dir);
  const path = joinPath(dir, `${crypto.randomUUID()}.json`);
  await writePrivateFile(
    path,
    JSON.stringify(projectLocalModelResult(request, result, observedAt)) + "\n",
  );
  emitLocalModelDiagnostic(request, result, observedAt, key);
  return path;
}

function projectLocalModelResult(
  request: ModelRunRequestV1,
  result: PortResultV1<ModelRunReceiptV1>,
  observedAt: number,
): LocalModelResultProjectionV1 {
  const common = {
    version: "v1" as const,
    kind: "local_model_result" as const,
    taskId: request.taskId,
    base: request.base,
    requested: {
      model: request.model,
      reasoning: request.reasoning,
      maxDurationMs: request.maxDurationMs,
      maxOutputChars: request.maxOutputChars,
    },
    observedAt,
  };
  const reason = localModelResultReason(request, result);
  if (!result.ok) {
    return {
      ...common,
      result: { ok: false, errorKind: result.error.kind },
      reason,
    };
  }
  const receipt = result.value;
  return {
    ...common,
    result: {
      ok: true,
      outcome: receipt.outcome,
      actual: {
        provider: receipt.actual.provider,
        threadId: receipt.actual.threadId,
        turnId: receipt.actual.turnId,
        terminalOrigin: receipt.actual.terminalOrigin,
        observedTerminalStatus: receipt.actual.observedTerminalStatus,
        observedModel: receipt.actual.observedModel,
        observedReasoning: receipt.actual.observedReasoning,
        durationMs: receipt.actual.durationMs,
        outputChars: receipt.actual.outputChars,
      },
      candidate: receipt.candidate === null ? null : {
        head: receipt.candidate.head,
        changedPathCount: receipt.candidate.changedPaths.length,
      },
    },
    reason,
  };
}
