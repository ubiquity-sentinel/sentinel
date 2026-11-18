/**
 * The closed detail codes of one failed delivery port call's operational line
 * (`sentinel_merge_event`, emitted by `loop-merge.ts`): one fixed code per
 * static adapter detail. Any other detail is logged as `detailCode: null`, and
 * the line never carries the detail text. The launcher accepts exactly these
 * codes (`MERGE_EVENT_DETAIL_CODES`, `src/host/hosted-runtime-identity.ts`).
 */
export const MERGE_DETAIL_CODES = [
  ["candidate restore has no exact durable binding", "candidate_binding"],
  ["candidate restore remote identity is not exact", "candidate_remote"],
  ["candidate restore fetch did not verify", "candidate_fetch"],
  ["ancestry check failed", "ancestry_unavailable"],
  // Every `invalid` refusal of the trusted self merge (2026-11-15): the port's
  // own pre-write and custody checks (`port-self-merge.ts`), its current
  // review and task re-read (`port-merge.ts`), its Git object reads
  // (`git-executor.ts`) and the native CI self scope (`client-native-ci.ts`).
  ["self merge task binding mismatch", "self_merge_task_binding"],
  ["self merge intent identity mismatch", "self_merge_intent_identity"],
  ["self merge trusted CI pipeline changed", "self_merge_ci_pipeline_changed"],
  ["self merge preserved CI binding mismatch", "self_merge_preserved_ci"],
  ["self merge tested tree or trusted source mismatch", "self_merge_ci_source"],
  ["self merge integrated commit mismatch", "self_merge_integrated_commit"],
  ["self merge deterministic identity mismatch", "self_merge_deterministic"],
  ["self merge operation ref binding mismatch", "self_merge_operation_ref"],
  ["self merge object custody mismatch", "self_merge_object_custody"],
  ["self merge native CI changed", "self_merge_native_ci_changed"],
  ["self merge current native review unavailable", "self_merge_review"],
  ["self merge task unavailable", "self_merge_task_unavailable"],
  ["self merge current task acceptance mismatch", "self_merge_task_acceptance"],
  ["self merge commit identity invalid", "self_merge_commit_identity"],
  ["self merge object store is masked", "self_merge_object_store"],
  ["self merge commit malformed", "self_merge_commit_malformed"],
  ["self merge ref malformed", "self_merge_ref_malformed"],
  // 2026-11-17: only the owner merges Sentinel's own protected change.
  ["self merge protected path requires owner", "self_merge_protected_path"],
  ["native CI self scope mismatch", "self_merge_ci_scope"],
] as const;

export type MergeDetailCodeV1 = typeof MERGE_DETAIL_CODES[number][1];

/** The fixed code of one static adapter detail; null for any other detail. */
export function mergeDetailCode(detail: string): MergeDetailCodeV1 | null {
  return MERGE_DETAIL_CODES.find(([known]) => known === detail)?.[1] ?? null;
}
