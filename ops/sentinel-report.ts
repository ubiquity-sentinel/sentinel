/**
 * `sentinel report` (#339): read-only throughput readback. Loads the metrics
 * sidecar ref and the repair state snapshot through their existing readers
 * (fetch only; no write method is called), then prints the pure renderer's
 * tables. Permissions: `--allow-run=git --allow-env=PATH` plus read/write on
 * the scratch directory (default /tmp) and read on a local `--remote` path.
 */
import { GitStateStore } from "../src/state/mod.ts";
import { GitThroughputMetricsStore } from "../src/state/throughput-metrics-store.ts";
import {
  parseThroughputReportWindowV1,
  renderThroughputReport,
  ThroughputReportRefusal,
} from "../src/state/throughput-report.ts";
import { readRepairLedgerV1 } from "../src/state/state-repair-ledger.ts";

export const REPORT_DEFAULT_REMOTE =
  "https://github.com/ubiquity-sentinel/sentinel.git";
export const REPORT_USAGE =
  "usage: sentinel report --since <YYYY-MM-DD> [--until <YYYY-MM-DD>] " +
  "[--remote <url-or-path>] [--scratch <dir>]\n" +
  "  needs: deno run --allow-run=git --allow-env=PATH " +
  "--allow-read=<scratch>[,<remote path>] --allow-write=<scratch>";

async function granted(
  descriptors: Deno.PermissionDescriptor[],
): Promise<boolean> {
  for (const descriptor of descriptors) {
    // query never prompts; a missing grant refuses instead of asking.
    if ((await Deno.permissions.query(descriptor)).state !== "granted") {
      return false;
    }
  }
  return true;
}

function refuse(message: string): never {
  console.error(`sentinel report refused: ${message}\n${REPORT_USAGE}`);
  Deno.exit(2);
}

export async function cmdReport(opts: Record<string, string>): Promise<void> {
  let window;
  try {
    window = parseThroughputReportWindowV1(opts.since, opts.until, Date.now());
  } catch (error) {
    if (error instanceof ThroughputReportRefusal) refuse(error.message);
    throw error;
  }
  const remote = opts.remote ?? REPORT_DEFAULT_REMOTE;
  const scratch = opts.scratch ?? "/tmp";
  const local = !/^[a-z][a-z0-9+.-]*:\/\//i.test(remote);
  if (
    !(await granted([
      { name: "run", command: "git" },
      { name: "env", variable: "PATH" },
      { name: "read", path: scratch },
      { name: "write", path: scratch },
      ...(local ? [{ name: "read" as const, path: remote }] : []),
    ]))
  ) refuse("missing Deno permission");
  const dir = await Deno.makeTempDir({
    dir: scratch,
    prefix: "sentinel-report-",
  });
  try {
    const metrics = await new GitThroughputMetricsStore({
      scratchDir: `${dir}/metrics`,
      remoteUrl: remote,
    }).read();
    if (!metrics.ok) {
      console.error(`metrics ref unreadable: ${metrics.error.kind}`);
      Deno.exit(1);
    }
    // The report covers the whole ledger, cold tier included.
    const repair = await readRepairLedgerV1(
      new GitStateStore({
        scratchDir: `${dir}/repair`,
        remoteUrl: remote,
        role: "repair",
      }),
    );
    if (!repair.ok) {
      console.error(`repair snapshot unreadable: ${repair.error.kind}`);
      Deno.exit(1);
    }
    const snapshot = repair.value.status === "found"
      ? repair.value.snapshot
      : null;
    console.log(`metrics ref head: ${metrics.value.head ?? "absent"}`);
    console.log(
      `repair state head: ${
        repair.value.status === "found" ? repair.value.head : "absent"
      }`,
    );
    console.log(
      renderThroughputReport(
        metrics.value.head === null ? null : metrics.value.ledger,
        snapshot,
        window,
      ).trimEnd(),
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}
