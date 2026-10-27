import assert from "node:assert/strict";
import { GitMaintenanceIndex } from "../../src/state/maintenance-index.ts";
import { DenoGitRunner } from "../../src/state/mod.ts";
import {
  MAINTENANCE_INDEX_PATH,
  MAINTENANCE_INDEX_REF,
} from "../../src/contracts/maintenance-index.ts";
import { gitRun, T0, testGitEnv } from "../state/helpers.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  ARCHIVE,
  blocked,
  captured,
  FIRST_RUN,
  proof,
  walkRig,
} from "./hosted-autonomy-history-reach-fixtures.ts";

const index = (root: string, remoteUrl: string) =>
  new GitMaintenanceIndex({
    remoteUrl,
    scratchDir: `${root}/index`,
    runner: new DenoGitRunner(`${root}/git-home`),
  });

Deno.test("current matrix scan resumes authenticated discovery on the next maintenance invocation without rereading its verified prefix", async () => {
  const reads: string[][] = [];
  const rig = await walkRig({
    producers: 120,
    historyStride: 10,
    index,
    rows: [blocked("blocked-oldest", FIRST_RUN, 7001)],
    plans: new Map([[FIRST_RUN, {
      id: 7001,
      digest: ARCHIVE,
      expired: false,
    }]]),
    gitCost: (args) => {
      if (args[0] === "merge-base") {
        reads.push(args);
        return 4000;
      }
      return 0;
    },
  });
  try {
    const first = await captured(rig.walk);
    assert.equal(first.error, null);
    assert.equal(first.value, null);
    const before = reads.length;
    await assert.rejects(rig.walk, /^Error: REACHED 1001 blocked-oldest$/);
    assert(
      reads.length - before < before,
      `second invocation read ${reads.length - before}, first ${before}`,
    );
    console.log(
      JSON.stringify({
        firstReads: before,
        resumedReads: reads.length - before,
      }),
    );
  } finally {
    await rig.cleanup();
  }
});

async function git(root: string, cwd: string, args: string[]) {
  const result = await gitRun(cwd, args, testGitEnv(`${root}/home`));
  assert(result.ok, result.stderr);
  return result.stdout.trim();
}

async function appendProducer(root: string, runId: number) {
  const work = `${root}/history-work`;
  const head = await git(root, work, ["rev-parse", "HEAD"]);
  const manifest = JSON.parse(await Deno.readTextFile(`${work}/manifest.json`));
  manifest.stateHead = head;
  manifest.sequence++;
  manifest.updatedAt = T0 + manifest.sequence;
  const paths = [];
  for await (const row of Deno.readDir(`${work}/hostedRuntimes`)) {
    paths.push(row.name);
  }
  assert.equal(paths.length, 1);
  const path = `${work}/hostedRuntimes/${paths[0]}`;
  const runtime = JSON.parse(await Deno.readTextFile(path));
  runtime.lastExecutionProof = proof(runId);
  runtime.updatedAt = manifest.updatedAt;
  await Deno.writeTextFile(path, `${canonicalStringify(runtime)}\n`);
  await Deno.writeTextFile(
    `${work}/manifest.json`,
    `${canonicalStringify(manifest)}\n`,
  );
  await git(root, work, ["add", "-A"]);
  await git(root, work, ["commit", "-q", "-m", "new settled producer"]);
  await git(root, work, [
    "push",
    "-q",
    `${root}/remote.git`,
    "HEAD:refs/heads/sentinel-state/release",
  ]);
}

Deno.test("current matrix scan rechecks late artifacts and observes a new authenticated release-head producer", async () => {
  const old = blocked("old", FIRST_RUN, 7001);
  const initial = structuredClone(old);
  const plans = new Map<
    number,
    { id: number; digest: string; expired: boolean }
  >();
  let sidecar: GitMaintenanceIndex;
  const rig = await walkRig({
    producers: 8,
    index: (root, remote) => sidecar = index(root, remote),
    rows: [old],
    plans,
  });
  try {
    assert.equal((await captured(rig.walk)).error, null);
    const stored = await sidecar!.read();
    assert(stored.ok && stored.value.index !== null);
    assert.equal(
      stored.value.index.ranges.at(-1)?.next?.sequence,
      2,
      "the selected producer remains unexamined until its parent is proved",
    );
    plans.set(FIRST_RUN, { id: 7001, digest: ARCHIVE, expired: false });
    await assert.rejects(rig.walk, /^Error: REACHED 1001 old$/);
    // No cached negative may hide an artifact that appeared later.
    assert.deepEqual(old, initial);
    plans.delete(FIRST_RUN);
    const nextRun = FIRST_RUN + 100;
    await appendProducer(rig.root, nextRun);
    // Change the already-owned pending row to a genuinely new exact binding.
    const next = blocked("old", nextRun, 7002);
    Object.assign(old.record, next.record);
    Object.assign(old.charge, next.charge);
    plans.set(nextRun, { id: 7002, digest: ARCHIVE, expired: false });
    await assert.rejects(rig.walk, /^Error: REACHED 1101 old$/);
    assert.equal(rig.calls.recovered.at(-1), nextRun);
    assert.deepEqual(old, next);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("current matrix scan reconstructs corrupt metadata without losing pending requests or replacing its ref", async () => {
  const plans = new Map<
    number,
    { id: number; digest: string; expired: boolean }
  >();
  const row = blocked("pending", FIRST_RUN, 7001);
  const original = structuredClone(row);
  let sidecar: GitMaintenanceIndex;
  const rig = await walkRig({
    producers: 6,
    rows: [row],
    plans,
    index: (root, remote) => sidecar = index(root, remote),
  });
  try {
    assert.equal((await captured(rig.walk)).error, null);
    const saved = await sidecar!.read();
    assert(saved.ok && saved.value.index !== null);
    const work = `${rig.root}/corrupt-index`;
    await Deno.mkdir(work);
    await git(rig.root, work, ["init", "-q"]);
    await git(rig.root, work, [
      "fetch",
      "-q",
      "--no-auto-gc",
      `${rig.root}/remote.git`,
      MAINTENANCE_INDEX_REF,
    ]);
    await git(rig.root, work, ["checkout", "-q", "--detach", "FETCH_HEAD"]);
    const divergent = {
      ...saved.value.index,
      anchor: { ...saved.value.index.anchor, head: "f".repeat(40) },
    };
    for (
      const [mode, body] of [["corrupt", "{}"], [
        "divergent",
        `${canonicalStringify(divergent)}\n`,
      ]]
    ) {
      await Deno.writeTextFile(`${work}/${MAINTENANCE_INDEX_PATH}`, body);
      await git(rig.root, work, ["add", "-A"]);
      await git(rig.root, work, [
        "commit",
        "-q",
        "-m",
        `${mode} derived metadata`,
      ]);
      const changed = await git(rig.root, work, ["rev-parse", "HEAD"]);
      await git(rig.root, work, [
        "push",
        "-q",
        `${rig.root}/remote.git`,
        `HEAD:${MAINTENANCE_INDEX_REF}`,
      ]);
      if (mode === "corrupt") assert.equal((await sidecar!.read()).ok, false);
      plans.set(FIRST_RUN, { id: 7001, digest: ARCHIVE, expired: false });
      await assert.rejects(rig.walk, /^Error: REACHED 1001 pending$/);
      assert.deepEqual(row, original);
      const remote = await git(rig.root, work, [
        "ls-remote",
        `${rig.root}/remote.git`,
        MAINTENANCE_INDEX_REF,
      ]);
      assert(remote.startsWith(`${changed}\t`));
    }
  } finally {
    await rig.cleanup();
  }
});
