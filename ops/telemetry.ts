import { Archive } from "./telemetry-store.ts";
import { importCapture } from "./telemetry-import.ts";
import { syncArchive } from "./telemetry-collect.ts";
import { makeReport, renderReport } from "./telemetry-report.ts";
import { object, time } from "./telemetry-types.ts";

function options(args: string[]) {
  const mode = args[0]?.startsWith("--") ? "sync" : args.shift() ?? "sync";
  if (!["sync", "report", "import"].includes(mode)) {
    throw new Error(
      "Usage: telemetry.ts sync|report|import [--archive PATH] [--days 7] [--cutoff ISO] [--max-reads 120] [--deadline-seconds 240] [--import-manifest PATH]",
    );
  }
  const values = new Map<string, string>();
  const allowed = [
    "--archive",
    "--days",
    "--cutoff",
    "--max-reads",
    "--deadline-seconds",
    "--import-manifest",
  ];
  while (args.length) {
    const flag = args.shift()!;
    const value = args.shift();
    if (!allowed.includes(flag) || !value || values.has(flag)) {
      throw new Error("Unknown, duplicate or missing telemetry option");
    }
    values.set(flag, value);
  }
  function integer(flag: string, fallback: number, max: number) {
    const n = Number(values.get(flag) ?? fallback);
    if (!Number.isSafeInteger(n) || n < 1 || n > max) {
      throw new Error(`${flag} must be an integer from 1 to ${max}`);
    }
    return n;
  }
  const cutoff = values.has("--cutoff") ? time(values.get("--cutoff")) : null;
  if (values.has("--cutoff") && cutoff === null) {
    throw new Error("Invalid --cutoff timestamp");
  }
  if (mode === "import" && !values.has("--import-manifest")) {
    throw new Error("import requires --import-manifest");
  }
  if (mode !== "import" && values.has("--import-manifest")) {
    throw new Error("--import-manifest is only valid for import");
  }
  return {
    mode,
    archive: values.get("--archive") ?? ".sentinel/telemetry",
    days: integer("--days", 7, 90),
    maxReads: integer("--max-reads", 120, 500),
    deadlineMs: integer("--deadline-seconds", 240, 240) * 1000,
    cutoff,
    manifest: values.get("--import-manifest"),
  };
}

export async function main(args = Deno.args): Promise<void> {
  const opts = options([...args]);
  const archive = new Archive(opts.archive);
  await archive.open();
  try {
    if (opts.mode === "import") {
      console.log(
        `Imported ${await importCapture(
          archive,
          opts.manifest!,
        )} verified command outputs.`,
      );
    }
    let cutoff = opts.cutoff;
    if (cutoff === null && opts.mode !== "sync") {
      // Keep a cached report's measurement cutoff stable, independently of import/retrieval time.
      const sessions = (await archive.sessions()).map(object).sort((a, b) =>
        Number(time(a.observedAt)) - Number(time(b.observedAt))
      );
      cutoff = time(sessions.at(-1)?.cutoff);
      if (cutoff === null) {
        const ends = (await archive.evidence()).flatMap((e) => {
          const query = new URLSearchParams(
            e.observation.endpoint.split("?")[1],
          );
          const end = query.get("created")?.split("..")[1];
          return end && time(end) ? [Number(time(end))] : [];
        });
        if (ends.length) cutoff = Math.max(...ends);
      }
    }
    cutoff ??= Date.now();
    const since = cutoff - opts.days * 86_400_000;
    if (opts.mode === "sync") {
      const coverage = await syncArchive(archive, {
        since,
        cutoff,
        maxReads: opts.maxReads,
        deadlineMs: opts.deadlineMs,
      });
      console.log(
        `Sync: ${coverage.reads}/${coverage.maxReads} GETs; ${coverage.stopped}; metadata ${
          coverage.runsComplete ? "complete" : "partial"
        }.`,
      );
    }
    console.log(renderReport(await makeReport(archive, since, cutoff)));
  } finally {
    await archive.close();
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    // API stderr and response bodies are deliberately never echoed here.
    console.error(
      error instanceof Error ? error.message : "Telemetry operation failed",
    );
    Deno.exitCode = 1;
  }
}
