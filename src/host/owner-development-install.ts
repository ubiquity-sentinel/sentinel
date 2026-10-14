/**
 * One-shot owner-authorized development installation.
 *
 * This fixed trusted operation performs at most one pointer movement in the
 * hosted release state: original generation 5 -> reader generation 6 ->
 * aggregate generation 7 -> review recovery generation 8 -> review-step
 * reconciliation generation 9 -> reviewer provenance generation 10 ->
 * one-shot exit contract generation 11, plus a one-time
 * rollback of an exact failed candidate to its recorded previously healthy
 * revision. It is NOT a runtime redesign and NOT a recurring global gate: every other state is a zero-write
 * waiting/no-change outcome so the unchanged protected supervisor continues
 * to settle and verify its own work. A rollback state never reattempts
 * installation by itself.
 *
 * Storage authority stays read-only: the complete release snapshot is read and
 * validated through the existing release-role Git store. The movement itself
 * is one explicitly owner-authorized commit created through GitHub's existing
 * Git database API with the exact expected state head as its ONLY parent, then
 * published with a non-force ref update. The commit message carries the
 * permanent owner-development-install record (authority timestamp, exact
 * prior/next revision and generation, expected parent state head, the exact
 * authorizing healthy proof and a random write nonce); the commit id remains
 * the durable rollback record. No review, release receipt, execution intent,
 * live-delivery claim or autonomous transition is fabricated.
 *
 * Identity is fixed: the process must be the `prepare` job of the protected
 * `sentinel-supervisor` workflow at the exact dispatched source commit. The
 * App token is used only for release-store/Git-data authority; the repository
 * token is used only for the read-only ancestry and test-local check
 * verification of an installed revision. Credentials are read by name, never
 * printed and never placed in a URL.
 */

import { runOwnerDevelopmentInstallMain } from "./owner-install-run.ts";
import { failedResult, report } from "./owner-install-result.ts";
export * from "./owner-install-pins.ts";
export * from "./owner-install-runtime-pins.ts";
export type {
  OwnerDevelopmentInstallActionV1,
  OwnerDevelopmentInstallFilesV1,
  OwnerDevelopmentInstallFileV1,
  OwnerDevelopmentInstallMoveV1,
  OwnerDevelopmentInstallPlanV1,
  OwnerDevelopmentInstallRecordV1,
  OwnerDevelopmentInstallResultV1,
  OwnerMatrixRecoveryEvidenceV1,
} from "./owner-install-types.ts";
export { planOwnerDevelopmentInstall } from "./owner-install-plan.ts";
export {
  buildOwnerDevelopmentInstallSnapshot,
  ownerDevelopmentInstallCommitMessage,
  ownerDevelopmentInstallFiles,
} from "./owner-install-snapshot.ts";
export { runOwnerDevelopmentInstallMain };

if (import.meta.main) {
  if (
    Deno.args.length > 1 ||
    (Deno.args.length === 1 && Deno.args[0] !== "--startup-recovery")
  ) {
    Deno.exitCode = report(failedResult("arguments_rejected"), 1);
  } else {
    Deno.exitCode = await runOwnerDevelopmentInstallMain({
      startupRecovery: Deno.args[0] === "--startup-recovery",
    });
  }
}
