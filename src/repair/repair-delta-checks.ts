/**
 * Closed check names of the advisory fan-out line's `unauthenticated`
 * breakdown (`fanout-summary-line.ts`), shared by finalize's authentication
 * (src/host/repair-fanout-finalize.ts) and the delta application
 * (`repair-delta-apply.ts`) without an import cycle.
 *
 * The closed check an `unauthenticated` delta failed, for the advisory
 * fan-out line only (never evidence): finalize's own authentication checks
 * (`authenticateRepairFanout`), in order, then `seal`, the envelope's seal or
 * binding refused when the application opens it (`openRepairDeltaV1`).
 */
export const REPAIR_DELTA_UNAUTHENTICATED_CHECKS = [
  /** More than one artifact or producer job names the cell. */
  "ambiguous",
  /** The artifact's workflow-run provenance is not this run's. */
  "provenance",
  /**
   * The archive reader refused it: the artifact's recorded state, size or
   * digest, the download, the downloaded bytes against that size and digest,
   * or an entry its rules refuse (a name other than `plan.json`,
   * `result.json` or a bundle, a third entry, a directory, link or special
   * file, or an entry over its bound).
   */
  "archive",
  /**
   * The archive's files are not exactly one `result.json` (for example a
   * `result.json` beside a bundle, which the reader accepts), or that file is
   * not a bounded JSON object (invalid or oversized bytes decode to nothing).
   */
  "shape",
  /** The producer job or its cell step is not the exact completed one. */
  "job",
  /** The producer job's log could not be read. */
  "job_log",
  /** The step window holds not exactly one valid cell marker. */
  "marker",
  /** The envelope's digest is not the one its marker carries. */
  "digest",
  /** The envelope's seal or binding was refused when opened. */
  "seal",
] as const;

export type RepairDeltaUnauthenticatedV1 =
  typeof REPAIR_DELTA_UNAUTHENTICATED_CHECKS[number];
