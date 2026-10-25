/**
 * The retry pass's WRITTEN action lines, and the one predicate that decides
 * the `retried` reason from them.
 *
 * The retry pass names every record it decided on as `retry:<id>:...`. Only
 * three of those lines report a state write: a grant
 * (`retry:<id>:grant=<n>:<detail>`), a re-admission
 * (`retry:<id>:readmit:<detail>`) and a repeat-failure park
 * (`retry:<id>:parked:repeat_failure:<label>`), each pushed only after the
 * pass's own write was read back. Every other `retry:` line (`denied:`,
 * `skipped:`, the legacy class and held-head reports) is read-only and is
 * repeated on every pass while its record waits, so it never makes a pass
 * `retried`: a pass that wrote nothing reports its own class instead.
 */

/** A grant the retry pass wrote: `retry:<id>:grant=<n>:<detail>`. */
export function retryGrantAction(
  id: string,
  grant: number,
  detail: string,
): string {
  return `retry:${id}:grant=${grant}:${detail}`;
}

/** A re-admission the retry pass wrote: `retry:<id>:readmit:<detail>`. */
export function retryReadmitAction(id: string, detail: string): string {
  return `retry:${id}:readmit:${detail}`;
}

/** A repeat-failure park the retry pass wrote. */
export function retryParkAction(id: string, label: string): string {
  return `retry:${id}:parked:repeat_failure:${label}`;
}

/**
 * A written line: the work item id alphabet (`[A-Za-z0-9._:-]`, see
 * `isWorkItemId`) up to one of the three written markers. A read-only line's
 * reason is a fixed token whose details (`|`, `=`) leave that alphabet before
 * any marker, so no denial or skip matches.
 */
const WRITTEN_RETRY_ACTION =
  /^retry:[A-Za-z0-9._:-]{1,256}?:(?:grant=\d+:|readmit:|parked:repeat_failure:)/;

/** True for one line the retry pass pushes only after its write. */
export function isWrittenRetryAction(action: string): boolean {
  return WRITTEN_RETRY_ACTION.test(action);
}

/** True when this pass's actions report at least one retry write. */
export function retryWritten(actions: readonly string[]): boolean {
  return actions.some(isWrittenRetryAction);
}
