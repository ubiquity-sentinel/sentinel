import assert from "node:assert/strict";
import {
  type CurrentMatrixIndexV1,
  MAINTENANCE_INDEX_REF,
  MATRIX_INDEX_RELEASE_REF,
  parseCurrentMatrixIndexV1,
  parseMatrixProducerPlanMembershipV1,
} from "../../src/contracts/maintenance-index.ts";
import { HOSTED_CONTROLLER_REPOSITORY } from "../../src/contracts/hosted-controller-deployment.ts";
import { MAX_MATRIX_CELLS } from "../../src/contracts/matrix.ts";
import { GitMaintenanceIndex } from "../../src/state/maintenance-index.ts";
import { DenoGitRunner } from "../../src/state/mod.ts";
import type { GitRunnerV1 } from "../../src/state/state-git.ts";
import { gitRun, makeRemoteCtx, SHA1, testGitEnv } from "./helpers.ts";

const empty = (): CurrentMatrixIndexV1 => ({
  version: "v1",
  kind: "current_matrix_index",
  controller: HOSTED_CONTROLLER_REPOSITORY,
  releaseRef: MATRIX_INDEX_RELEASE_REF,
  anchor: { head: SHA1, sequence: 4 },
  ranges: [],
  producers: [],
});

Deno.test("maintenance index rejects foreign identity and a false complete partial cursor", () => {
  assert.throws(() =>
    parseCurrentMatrixIndexV1({ ...empty(), controller: "other/repo" })
  );
  assert.throws(() =>
    parseCurrentMatrixIndexV1({
      ...empty(),
      ranges: [{
        from: { head: SHA1, sequence: 4 },
        through: { head: SHA1, sequence: 4 },
        next: null,
      }],
    })
  );
});

Deno.test("maintenance index positive plan membership rejects incomplete and ambiguous descriptors", () => {
  const plan = {
    planDigest: "1".repeat(64),
    plannerJobId: 17,
    reservationIds: ["2".repeat(64), "3".repeat(64)],
  };
  assert.deepEqual(parseMatrixProducerPlanMembershipV1(plan), plan);
  assert.deepEqual(
    parseMatrixProducerPlanMembershipV1({
      ...plan,
      reservationIds: [],
    }).reservationIds,
    [],
  );
  for (
    const invalid of [
      { ...plan, plannerJobId: 0 },
      { ...plan, planDigest: "unknown" },
      { ...plan, reservationIds: ["2".repeat(64), "2".repeat(64)] },
      { ...plan, reservationIds: ["missing"] },
      { ...plan, unavailable: true },
      {
        ...plan,
        reservationIds: Array.from(
          { length: MAX_MATRIX_CELLS + 1 },
          (_, i) => i.toString(16).padStart(64, "0"),
        ),
      },
      { planDigest: plan.planDigest, plannerJobId: plan.plannerJobId },
    ]
  ) assert.throws(() => parseMatrixProducerPlanMembershipV1(invalid));
});

Deno.test("maintenance index uses independent nonforce creation CAS and reconciles a lost push response", async () => {
  const root = await Deno.makeTempDir({
    prefix: "sentinel-index-test-",
    dir: decodeURIComponent(new URL("../../", import.meta.url).pathname),
  });
  try {
    await Deno.mkdir(`${root}/home`);
    const env = testGitEnv(`${root}/home`);
    const { remoteUrl } = await makeRemoteCtx(root, env);
    const runner = new DenoGitRunner(`${root}/home`);
    const calls: string[][] = [];
    const lost: GitRunnerV1 = {
      async runGit(args, opts) {
        calls.push(args);
        const result = await runner.runGit(args, opts);
        return args[0] === "push" ? { ...result, ok: false, code: 1 } : result;
      },
    };
    const a = new GitMaintenanceIndex({
      scratchDir: `${root}/a`,
      remoteUrl,
      runner: lost,
    });
    const b = new GitMaintenanceIndex({
      scratchDir: `${root}/b`,
      remoteUrl,
      runner,
    });
    const [one, two] = await Promise.all([
      a.write({ expectedHead: null, index: empty() }),
      b.write({ expectedHead: null, index: empty() }),
    ]);
    assert(one.ok && two.ok);
    assert.deepEqual([one.value.status, two.value.status].sort(), [
      "applied",
      "conflict",
    ]);
    const read = await b.read();
    assert(read.ok && read.value.head !== null && read.value.index !== null);
    const first = read.value.head;
    assert.deepEqual(read.value.index, empty());
    const moved = await a.write({ expectedHead: first, index: empty() });
    assert(moved.ok && moved.value.status === "applied");
    const stale = await b.write({ expectedHead: first, index: empty() });
    assert(stale.ok && stale.value.status === "conflict");
    const refs = await gitRun(root, ["ls-remote", remoteUrl], env);
    assert(refs.ok);
    assert.equal(refs.stdout.trim().split("\n").length, 1);
    assert(refs.stdout.trim().endsWith(`\t${MAINTENANCE_INDEX_REF}`));
    assert(
      calls.filter((args) => args[0] === "push").every((args) =>
        !args.some((arg) => arg.startsWith("--force") || arg.startsWith("+"))
      ),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
