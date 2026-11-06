/**
 * The hosted jobs that run with the matrix cell's credential-free boundary
 * (issue #328): literal read capabilities, a refusing state writer, no queue
 * custody preparation, no trusted contexts and no progress comments.
 */
export function isReadOnlyCellJob(job: string | undefined): boolean {
  return job === "matrix_cell" || job === "repair_cell";
}
