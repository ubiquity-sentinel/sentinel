/** Reference lookups must survive trusted reservation-ledger compaction. */
import assert from "node:assert/strict";

Deno.test("reservation readers: wave, record and release lookups include the archive", async () => {
  const root = new URL("../../", import.meta.url);
  // Only the ledger's parser, lookup helpers, serializer and writers own live
  // membership. Reference consumers in src/ AND production ops/ must resolve
  // through the archive-aware helpers, including iteration and helper arguments.
  // These accesses preserve the live/archive partition, or refer to non-ledger
  // fields. Keep exceptions expression-specific: a lookup in the same file is
  // still a reference consumer and must not inherit the exception.
  const nonReferenceAccesses = new Map<string, string[]>([
    ["src/contracts/state-snapshots.ts", [
      "obj.reservations,",
      "snapshot.reservations,",
      "snapshot.reservations.find(",
    ]],
    ["src/budget/budget-state.ts", [
      "base.reservations, reservation]",
      "snapshot.reservations.map((r) =>",
      "value.reservations,",
    ]],
    ["src/state/state-codec.ts", [
      "repair.reservations)",
      "records.reservations,",
    ]],
    ["src/state/state-repair-transition.ts", [
      "next.reservations.some(",
      "prior.reservations)",
    ]],
    ["src/state/state-reservation-archive.ts", ["snapshot.reservations;"]],
    ["src/repair/loop-state.ts", [
      "base.reservations]",
      "original.reservations,",
      "other.reservations,",
    ]],
    ["src/repair/transitions.ts", ["snapshot.reservations]"]],
    ["src/host/matrix-uncertainty-maintenance.ts", [
      "before.reservations.map(",
    ]],
    ["src/host/local-status.ts", ["aggregates.reservations.omitted"]],
    ["src/host/local-release.ts", ["obj.reservations)"]],
    ["ops/issue48-review-quota-recovery.ts", ["prior.reservations,"]],
    ["ops/issue48-recovery.ts", ["prior.reservations,"]],
    ["ops/runtime-mismatch-recovery-disposition.ts", [
      "input.snapshot.reservations,",
    ]],
    ["ops/historical-retry-disposition.ts", ["snapshot.reservations.map("]],
    ["ops/hosted-autonomy-historical-recovery.ts", ["after.reservations.map("]],
    ["ops/hosted-autonomy-current-recovery.ts", ["lost.reservations"]],
  ]);
  const violations: string[] = [];
  async function inspect(directory: URL, prefix: string): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      const path = prefix + entry.name;
      if (entry.isDirectory) {
        await inspect(new URL(entry.name + "/", directory), path + "/");
      } else if (entry.isFile && entry.name.endsWith(".ts")) {
        const source = await Deno.readTextFile(new URL(entry.name, directory));
        const readers = /\b[\w.]+\.reservations\b/g;
        for (const match of source.matchAll(readers)) {
          if (
            nonReferenceAccesses.get(path)?.some((expression) =>
              source.startsWith(expression, match.index)
            )
          ) continue;
          const line = source.slice(0, match.index).split("\n").length;
          violations.push(`${path}:${line}: ${match[0]}`);
        }
      }
    }
  }
  for (const directory of ["src/", "ops/"]) {
    await inspect(new URL(directory, root), directory);
  }
  assert.deepEqual(
    violations.sort(),
    [],
    "use findReservationV1/allReservationsV1 for referenced charges",
  );
});
