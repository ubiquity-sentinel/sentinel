import { dirname, resolve } from "node:path";
import { type Archive, safeError } from "./telemetry-store.ts";
import { decoder, digest, list, object, time } from "./telemetry-types.ts";

/** Narrow read-only GH endpoint allowlist, shared by import and live collection. */
export function allowedEndpoint(input: string): boolean {
  if (input.includes("#") || /[\r\n]/.test(input)) return false;
  const [path, query] = input.split("?");
  if (path.includes("..")) return false;
  const match = path.match(
    /^repos\/(ubiquity-sentinel\/sentinel|ubiquity\/(?:ai\.ubq\.fi|passport\.ubq\.fi))\/(.+)$/i,
  );
  if (!match) return false;
  const resource = match[2];
  const known = /^pulls(?:\/\d+)?$/.test(resource) ||
    match[1].toLowerCase() === "ubiquity-sentinel/sentinel" &&
      (/^git\/ref\/heads\/(?:sentinel-state\/release|sentinel-supervisor|development)$/
        .test(resource) ||
        /^git\/(?:trees|blobs)\/[a-f0-9]{40}$/.test(resource) ||
        /^actions\/workflows\/supervisor\.yml\/runs$/.test(resource) ||
        /^actions\/runs\/\d+\/attempts\/\d+(?:\/(?:jobs|logs))?$/.test(
          resource,
        ) ||
        /^actions\/jobs\/\d+(?:\/logs)?$/.test(resource));
  return !!known &&
    [...new URLSearchParams(query).keys()].every((key) =>
      ["state", "sort", "direction", "per_page", "page", "created", "recursive"]
        .includes(key)
    );
}
function request(command: unknown): string | null {
  if (
    !Array.isArray(command) ||
    command.slice(0, 4).join(" ") !== "gh api --method GET" ||
    typeof command[4] !== "string"
  ) return null;
  const query = new URLSearchParams();
  for (let i = 5; i < command.length; i += 2) {
    if (command[i] !== "-f" || typeof command[i + 1] !== "string") return null;
    const text: string = command[i + 1];
    const at = text.indexOf("=");
    if (at < 1) return null;
    query.set(text.slice(0, at), text.slice(at + 1));
  }
  query.sort();
  const endpoint =
    command[4].replace(/^repos\/[^/]+\/[^/]+/, (s: string) => s.toLowerCase()) +
    (query.size ? `?${query}` : "");
  return allowedEndpoint(endpoint) ? endpoint : null;
}

/** Import original command outputs, never derived scorecards or model artifacts. */
export async function importCapture(
  archive: Archive,
  manifestPath: string,
): Promise<number> {
  const path = resolve(manifestPath);
  const raw = await Deno.readFile(path);
  const manifestHash = await digest(raw);
  const manifest = object(JSON.parse(decoder.decode(raw)));
  const entries = list(manifest.entries);
  const bySource = new Map(entries.map((e) => [String(e.source), e]));
  async function readEntry(
    entry: Record<string, unknown>,
  ): Promise<Uint8Array> {
    if (
      typeof entry.saved !== "string" ||
      !resolve(entry.saved).startsWith(`${dirname(path)}/`)
    ) throw new Error("Capture file escapes manifest directory");
    const bytes = await Deno.readFile(entry.saved);
    if (bytes.length !== entry.bytes || await digest(bytes) !== entry.sha256) {
      throw new Error("Capture manifest digest mismatch");
    }
    return bytes;
  }
  let count = 0;
  const dispositions: {
    receipt: string;
    endpoint: string | null;
    original: string;
    disposition: string;
    reason: string | null;
  }[] = [];
  const outputs = new Set<string>();
  for (
    const ledger of entries.filter((e) =>
      String(e.source).endsWith("/github-commands.json")
    )
  ) {
    const ledgerBytes = await readEntry(ledger);
    const ledgerHash = await digest(ledgerBytes);
    const receipts = list(JSON.parse(decoder.decode(ledgerBytes)));
    for (let i = 0; i < receipts.length; i++) {
      const receipt = receipts[i];
      const endpoint = request(receipt.command);
      const output = bySource.get(String(receipt.output));
      outputs.add(String(receipt.output));
      const identity = `${ledgerHash}:${i}`;
      if (!endpoint || !output || !time(receipt.startedAt)) {
        dispositions.push({
          receipt: identity,
          endpoint,
          original: String(receipt.output),
          disposition: "excluded",
          reason: !endpoint
            ? "outside telemetry GET allowlist"
            : !output
            ? "output missing from manifest"
            : "missing original observation time",
        });
        continue;
      }
      const bytes = await readEntry(output);
      let status = receipt.status === 0 ? 200 : 0;
      if (status !== 200) {
        const err = bySource.get(String(receipt.stderr));
        const text = err ? decoder.decode(await readEntry(err)) : "";
        status = Number(text.match(/HTTP\s+(\d{3})/)?.[1] ?? 0);
      }
      const saved = await archive.record({
        endpoint,
        observedAt: new Date(Number(time(receipt.startedAt))).toISOString(),
        status,
        error: status === 200 ? null : safeError(status),
        transport: "capture",
        source: {
          manifest: manifestHash,
          receipt: identity,
          original: String(receipt.output),
          sha256: String(output.sha256),
        },
      }, status === 200 ? bytes : null);
      dispositions.push({
        receipt: identity,
        endpoint,
        original: String(receipt.output),
        disposition: saved.observation.blob ? "imported" : "error_observation",
        reason: saved.observation.error,
      });
      count++;
    }
  }
  if (!count) {
    throw new Error(
      "No verified allowlisted GH command outputs in capture manifest",
    );
  }
  await archive.saveSession({
    schema: 1,
    kind: "capture_import",
    manifest: manifestHash,
    imported: count,
    excluded: dispositions.filter((d) => d.disposition === "excluded").length,
    dispositions,
    retainedOnlyInSeed: entries.filter((e) => !outputs.has(String(e.source)))
      .map((e) => ({
        original: e.source,
        sha256: e.sha256,
        reason:
          "not an original allowlisted GET output; retained in immutable seed",
      })),
  });
  return count;
}
