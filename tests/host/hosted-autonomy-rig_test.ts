import assert from "node:assert/strict";
import { createRepairStateStore, DenoGitRunner } from "../../src/state/mod.ts";
import { gitRun } from "../state/helpers.ts";
import { ENV } from "./hosted-autonomy-fixtures.ts";
import { makeRig, repairSnapshot } from "./hosted-autonomy-rig.ts";

Deno.test("hosted autonomy rig: real Git state pushes do not launch background maintenance", async () => {
  const { rig } = await makeRig("receive-maintenance", {
    fixtureDir: Deno.cwd(),
    repair: repairSnapshot([], []),
  });
  try {
    const root = await Deno.realPath(rig.tmp);
    const remoteUrl = `${root}/remote.git`;
    // Force useful maintenance work even in this tiny, freshly seeded remote.
    for (
      const [key, value] of [
        ["maintenance.loose-objects.enabled", "true"],
        ["maintenance.loose-objects.auto", "-1"],
      ]
    ) {
      const configured = await gitRun(root, [
        "--git-dir",
        remoteUrl,
        "config",
        key,
        value,
      ], ENV);
      assert.ok(configured.ok, configured.stderr);
    }
    const trace = `${root}/git-trace.jsonl`;
    const scratchDir = `${root}/traced-repair`;
    const store = createRepairStateStore({
      scratchDir,
      remoteUrl,
      runner: new DenoGitRunner(`${scratchDir}/state-git-home`, {
        GIT_TRACE2_EVENT: trace,
      }),
    });
    const read = await store.readRepair();
    assert.ok(read.ok && read.value.status === "found", JSON.stringify(read));
    const snapshot = read.value.snapshot;
    const written = await store.writeRepair({
      ...snapshot,
      stateHead: read.value.head,
      sequence: snapshot.sequence + 1,
      updatedAt: snapshot.updatedAt + 1,
    }, read.value.head);
    assert.ok(
      written.ok && written.value.status === "applied",
      JSON.stringify(written),
    );
    const background = (await Deno.readTextFile(trace)).trim().split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) =>
        event.event === "start" &&
        event.argv.some((arg: string) => arg === "maintenance" || arg === "gc")
      );
    assert.deepEqual(
      background,
      [],
      "temporary remote pushes must not leave detached Git writers racing reads or cleanup",
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});
