/** Reference lookups must survive trusted reservation-ledger compaction. */
import assert from "node:assert/strict";

Deno.test("reservation readers: wave, record and release lookups include the archive", async () => {
  const root = new URL("../../src/", import.meta.url);
  // These are ledger membership checks, not reference resolution. The helper
  // implements live-first lookup; the writer forbids restoring archived rows
  // or changing a row during its move from the live ledger into the archive.
  const ledgerOwners = new Map([
    ["contracts/state-snapshots.ts", "snapshot.reservations.find("],
    ["state/state-repair-transition.ts", "next.reservations.some("],
  ]);
  const violations: string[] = [];
  async function inspect(directory: URL, prefix = ""): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      const path = prefix + entry.name;
      if (entry.isDirectory) {
        await inspect(new URL(entry.name + "/", directory), path + "/");
      } else if (entry.isFile && entry.name.endsWith(".ts")) {
        const source = await Deno.readTextFile(new URL(entry.name, directory));
        const readers =
          /[\w.]+\.reservations\s*\.\s*(?:find|findIndex|some|every|filter)\s*\(/g;
        for (const match of source.matchAll(readers)) {
          if (match[0] === ledgerOwners.get(path)) continue;
          const line = source.slice(0, match.index).split("\n").length;
          violations.push(`${path}:${line}: ${match[0]}`);
        }
      }
    }
  }
  await inspect(root);
  assert.deepEqual(
    violations.sort(),
    [],
    "use findReservationV1/allReservationsV1 for referenced charges",
  );
});
