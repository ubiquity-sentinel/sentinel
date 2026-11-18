/**
 * The backup runner this launcher's legs run as (2026-11-18 review): the
 * same `backupCiRunnerId` the trusted pass plans with, from the committed act
 * and node pins and the leg revision. The stand-in rule counts only receipts
 * of this runner, so reverting a leg revision or pin bump makes the newer
 * runner's receipts inert by code instead of by an operator suspension.
 * Null when the pins do not parse (then nothing stands in).
 */
import pins from "../../ops/backup-ci-pins.json" with { type: "json" };
import {
  backupCiRunnerId,
  parseBackupCiPins,
} from "../../ops/backup-ci-act.ts";

const parsed = parseBackupCiPins(pins);

export const BACKUP_CI_CURRENT_RUNNER_ID: string | null = parsed === null
  ? null
  : backupCiRunnerId(parsed);
