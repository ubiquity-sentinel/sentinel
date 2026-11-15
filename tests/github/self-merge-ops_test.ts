/**
 * Owner decision 2026-11-15 ("drop it"): the trusted self merge no longer
 * refuses a reviewed, green pull request because it changes launcher or
 * maintenance code under `ops/`. Live: PRs #385, #402, #409, #412 and #415
 * (each `ops/` plus tests) were refused `invalid` with no detail code and were
 * squash-merged by the maintenance delivery pass one cycle later. What CI runs
 * stays pinned to the base: the `.github` tree, the shard runner and its
 * timings, the size gate, `deno.json`, `deno.lock`, and the workflow, harness
 * and emitter sources.
 */
import assert from "node:assert/strict";
import { NATIVE_CI_SOURCES } from "../../src/contracts/native-ci.ts";
import { parseReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import { SELF_MERGE_TRUSTED_PIPELINE } from "../../src/github/self-merge-git.ts";
import { mergeDetailCode } from "../../src/repair/merge-event-codes.ts";
import { selfMergeFixture } from "./self-merge-fixture.ts";

type Rig = Awaited<ReturnType<typeof selfMergeFixture>>;

const LAUNCHER = {
  "ops/hosted-autonomy-runner.ts": "export const runner = 1;\n",
  "tests/host/hosted-autonomy-runner_test.ts":
    "Deno.test('runner', () => {});\n",
};

async function withRig<T>(
  candidate: Record<string, string> | undefined,
  body: (rig: Rig) => Promise<T>,
): Promise<T> {
  const rig = await selfMergeFixture({ candidate });
  try {
    return await body(rig);
  } finally {
    await rig.cleanup();
  }
}

async function development(rig: Rig) {
  return await rig.executor.readRemoteRef("refs/heads/development");
}

Deno.test("self merge ops: a reviewed green launcher-only change merges through the trusted port", async () => {
  await withRig(LAUNCHER, async (rig) => {
    const result = await rig.port.mergePullRequest(rig.request, rig.execution);
    assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok || result.value.outcome !== "merged") {
      throw new Error(JSON.stringify(result));
    }
    assert.equal(result.value.mergeSha, rig.merge);
    assert.equal(result.value.head, rig.head);
    assert.deepEqual(await development(rig), { ok: true, value: rig.merge });
    // The two-parent source write, never GitHub's squash merge API.
    assert.equal(rig.calls.some((c) => c.method === "PUT"), false);
  });
});

Deno.test("self merge ops: the durable proof and its settlement match an ordinary self merge", async () => {
  const shape = async (candidate: Record<string, string> | undefined) =>
    await withRig(candidate, async (rig) => {
      const result = await rig.port.mergePullRequest(
        rig.request,
        rig.execution,
      );
      assert.ok(result.ok && result.value.outcome === "merged");
      const proofs = rig.state.saved;
      for (const proof of proofs) {
        assert.equal(proof.merge, rig.merge);
        assert.equal(proof.head, rig.head);
        assert.equal(proof.base, rig.base);
        assert.equal(proof.tree, proof.ci.proof.testedTree);
        assert.equal(proof.ci.proof.testedCommit, rig.merge);
        assert.match(
          proof.ref,
          /^refs\/heads\/sentinel\/self-merge\/[a-f0-9]{64}$/,
        );
      }
      return {
        stages: proofs.map((p) => [
          p.stage,
          p.prState,
          p.observedTarget === null
            ? null
            : p.observedTarget === rig.merge
            ? "merge"
            : "other",
        ]),
        keys: proofs.map((p) => Object.keys(p).sort().join()),
        settled: result.ok && result.value.outcome === "merged"
          ? {
            stage: result.value.selfMerge?.stage,
            prState: result.value.selfMerge?.prState,
          }
          : null,
        pushes: rig.state.pushes.map((ref) =>
          ref.startsWith("refs/heads/sentinel/self-merge/") ? "operation" : ref
        ),
        writes: rig.calls.filter((c) => c.method !== "GET").map((c) =>
          `${c.method} ${new URL(c.url).pathname}`
        ),
      };
    });
  const ordinary = await shape(undefined);
  const launcher = await shape(LAUNCHER);
  assert.deepEqual(
    launcher.stages.map(([stage]) => stage),
    ["prepared", "preserved", "source_applied", "pr_closed", "issue_closed"],
  );
  assert.deepEqual(launcher, ordinary);
});

const PIPELINE = [
  "self merge trusted CI pipeline changed",
  "self_merge_ci_pipeline_changed",
] as const;
const SOURCE = [
  "self merge tested tree or trusted source mismatch",
  "self_merge_ci_source",
] as const;

/** Every CI definition path the self merge keeps pinned to its base. */
const CI_DEFINITION: readonly (readonly [string, readonly [string, string]])[] =
  [
    [".github/workflows/ci.yml", PIPELINE],
    [".github/dependabot.yml", PIPELINE],
    ["ops/ci-shards.ts", PIPELINE],
    ["ops/ci-test-timings.json", PIPELINE],
    ["ops/code-size.ts", PIPELINE],
    ["deno.json", PIPELINE],
    ["deno.lock", PIPELINE],
    ["test-local.ts", SOURCE],
    ["ops/native-ci-proof.ts", SOURCE],
  ];

Deno.test("self merge ops: a change to what CI runs is still refused before any write", async (t) => {
  for (const [path, [detail, code]] of CI_DEFINITION) {
    await t.step(path, async () => {
      await withRig({
        ...LAUNCHER,
        [path]: `changed CI definition ${path}\n`,
      }, async (rig) => {
        const result = await rig.port.mergePullRequest(
          rig.request,
          rig.execution,
        );
        assert.deepEqual(result, {
          ok: false,
          error: { kind: "invalid", detail },
        });
        // The repair loop logs this refusal with its fixed code, never null.
        if (!result.ok) {
          assert.equal(mergeDetailCode(result.error.detail), code);
        }
        assert.equal(rig.state.saved.length, 0);
        assert.equal(rig.state.pushes.length, 0);
        assert.deepEqual(await development(rig), { ok: true, value: rig.base });
        assert.equal(rig.calls.some((c) => c.method !== "GET"), false);
      });
    });
  }
});

/** The outcome and observable effects of one merge call under `arrange`. */
async function refusal(
  candidate: Record<string, string> | undefined,
  arrange: (rig: Rig) => void,
) {
  return await withRig(candidate, async (rig) => {
    arrange(rig);
    const result = await rig.port.mergePullRequest(rig.request, rig.execution);
    const target = await development(rig);
    const label = (sha: string | null) =>
      sha === null
        ? null
        : sha === rig.base
        ? "base"
        : sha === rig.merge
        ? "merge"
        : sha === rig.head
        ? "head"
        : "other";
    return {
      result: !result.ok
        ? result.error
        : result.value.outcome === "blocked"
        ? { outcome: "blocked", reason: result.value.reason }
        : {
          outcome: result.value.outcome,
          mergeSha: label(result.value.mergeSha),
        },
      saved: rig.state.saved.map((p) => p.stage),
      pushes: rig.state.pushes.map((ref) =>
        ref.startsWith("refs/heads/sentinel/self-merge/") ? "operation" : ref
      ),
      target: target.ok ? label(target.value) : "unreadable",
      writes: rig.calls.filter((c) => c.method !== "GET").length,
    };
  });
}

Deno.test("self merge ops: red or missing CI, a stale receipt and a moved base refuse a launcher change as any other", async (t) => {
  const cases: [string, (rig: Rig) => void][] = [
    ["red head CI", (rig) => rig.state.failedCi = true],
    ["missing head CI", (rig) => rig.state.missingCi = true],
    ["foreign head CI", (rig) => rig.state.foreignCi = true],
    ["stale review receipt", (rig) => {
      rig.request.review = parseReviewReceiptV1({
        ...rig.request.review,
        resultId: "result-8",
      });
    }],
    ["base moved before the target write", (rig) => rig.state.race = true],
    ["base advanced to the candidate", (rig) => rig.state.ancestorRace = true],
  ];
  for (const [name, arrange] of cases) {
    await t.step(name, async () => {
      const ordinary = await refusal(undefined, arrange);
      const launcher = await refusal(LAUNCHER, arrange);
      assert.notEqual(launcher.target, "merge", JSON.stringify(launcher));
      assert.equal(
        "outcome" in launcher.result && launcher.result.outcome === "merged",
        false,
      );
      assert.deepEqual(launcher, ordinary);
    });
  }
});

/**
 * The narrowed pin must follow the CI definition: every `ops/` file the CI
 * workflow or its harness runs (and each relative module those import) is a
 * pinned pipeline path or a pinned native CI source.
 */
Deno.test("self merge ops: every ops/ file the CI definition runs stays pinned", async () => {
  const pinned = new Set<string>([
    ...SELF_MERGE_TRUSTED_PIPELINE.map(([, path]) => path),
    ...NATIVE_CI_SOURCES,
  ]);
  const ran = new Set<string>();
  const pending = [".github/workflows/ci.yml", "test-local.ts"];
  for (let file = pending.shift(); file !== undefined; file = pending.shift()) {
    const text = await Deno.readTextFile(file);
    const dir = file.slice(0, file.lastIndexOf("/") + 1);
    for (
      const next of [
        ...[...text.matchAll(/\bops\/[A-Za-z0-9_.-]+/g)].map((m) => m[0]),
        ...[...text.matchAll(/from "\.\/([A-Za-z0-9_.-]+)"/g)].map((m) =>
          dir + m[1]
        ),
      ]
    ) {
      if (ran.has(next)) continue;
      ran.add(next);
      if (next.endsWith(".ts")) pending.push(next);
    }
  }
  assert.deepEqual([...ran].sort(), [
    "ops/ci-shards.ts",
    "ops/ci-test-timings.json",
    "ops/code-size.ts",
    "ops/native-ci-proof.ts",
  ]);
  for (const file of ran) assert.ok(pinned.has(file), file);
});
