/**
 * Source anchors. Every fact the checker MODELS instead of executing (a
 * runtime step that needs live ports, a cap applied inline in an async pass,
 * a runtime recovery of one exact blocker) is pinned to the exact source text
 * it was transcribed from. The test fails when an anchor no longer matches,
 * so a change to the modeled code forces the model (and KNOWN_JAMS) to be
 * revisited instead of silently drifting.
 */
export interface AnchorV1 {
  /** Stable id the model cites. */
  readonly id: string;
  /** Repository-relative file. */
  readonly file: string;
  /** Exact text that must occur in the file. */
  readonly needle: string;
}

const registry = new Map<string, AnchorV1>();

/** Register (or re-cite) one anchor and return its id. */
export function anchor(id: string, file: string, needle: string): string {
  const existing = registry.get(id);
  if (
    existing !== undefined &&
    (existing.file !== file || existing.needle !== needle)
  ) {
    throw new Error(`anchor ${id} registered twice with different text`);
  }
  registry.set(id, { id, file, needle });
  return id;
}

export function anchors(): AnchorV1[] {
  return [...registry.values()];
}

/** `file:line` of an anchor's first match, for traces. */
export async function locate(id: string): Promise<string> {
  const entry = registry.get(id);
  if (entry === undefined) return id;
  const text = await read(entry.file);
  const index = text.indexOf(entry.needle);
  if (index < 0) return `${entry.file}:?`;
  return `${entry.file}:${text.slice(0, index).split("\n").length}`;
}

const cache = new Map<string, string>();

export async function read(file: string): Promise<string> {
  const cached = cache.get(file);
  if (cached !== undefined) return cached;
  const text = await Deno.readTextFile(
    new URL(`../../${file}`, import.meta.url),
  );
  cache.set(file, text);
  return text;
}

/** Every registered anchor whose text is gone from its file. */
export async function brokenAnchors(): Promise<AnchorV1[]> {
  const broken: AnchorV1[] = [];
  for (const entry of registry.values()) {
    if (!(await read(entry.file)).includes(entry.needle)) broken.push(entry);
  }
  return broken;
}
