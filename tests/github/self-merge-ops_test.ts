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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_CI_SOURCES } from "../../src/contracts/native-ci.ts";
import { parseReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import {
  SELF_MERGE_TRUSTED_PIPELINE,
  SELF_MERGE_TRUSTED_SOURCES,
} from "../../src/github/self-merge-git.ts";
import { mergeDetailCode } from "../../src/repair/merge-event-codes.ts";
import {
  CI_WORKFLOW,
  ciHarness,
  type CiHarnessV1,
  codeGraph,
  lockPins,
} from "./ci-harness-graph.ts";
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

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * What the self merge pins, as production reads it; a directory pin (the
 * `.github` tree) covers every file under it.
 */
const PINNED: readonly string[] = [
  ...SELF_MERGE_TRUSTED_PIPELINE.map(([, path]) => path),
  ...SELF_MERGE_TRUSTED_SOURCES.map(([, path]) => path),
];

function unpinned(harness: CiHarnessV1): string[] {
  return [...harness.closure, ...harness.named].filter((file) =>
    !PINNED.some((pin) => file === pin || file.startsWith(`${pin}/`))
  ).sort();
}

/**
 * The narrowed pin must cover the whole CI harness, so that no refactor can
 * move harness logic into a file a pull request may change: every local file
 * that a script ci.yml runs (or that one spawns) reaches by a code edge, JSON
 * and dynamic imports included, and every file they name by path. Type-only
 * edges run nothing and stay unpinned.
 */
Deno.test("self merge ops: every local file the CI harness runs or reads stays pinned", async () => {
  const harness = await ciHarness(ROOT);
  assert.deepEqual(harness.problems, []);
  assert.deepEqual(harness.entries, [
    "ops/ci-shards.ts",
    "ops/code-size.ts",
    "ops/native-ci-proof.ts",
    "test-local.ts",
  ]);
  assert.deepEqual(harness.closure, [
    "ops/ci-shards.ts",
    "ops/ci-test-timings.json",
    "ops/code-size.ts",
    "ops/native-ci-proof.ts",
    "test-local.ts",
  ]);
  assert.deepEqual(harness.typeOnly, ["src/contracts/native-ci.ts"]);
  assert.deepEqual(harness.external, ["node:path"]);
  const lock = JSON.parse(await Deno.readTextFile(join(ROOT, "deno.lock")));
  for (const specifier of harness.external) {
    assert.ok(lockPins(lock, specifier), specifier);
  }
  assert.ok(harness.named.includes(CI_WORKFLOW));
  assert.deepEqual(unpinned(harness), []);
  // The contract's source list is the one the self merge reads.
  assert.deepEqual(
    SELF_MERGE_TRUSTED_SOURCES.map(([, path]) => path),
    [...NATIVE_CI_SOURCES],
  );
});

type Edits = Record<string, (text: string) => string>;

const HELPER: Edits = {
  "ops/ci-helper.ts": () =>
    "export const CI_HELPER = 1;\nexport type CiHelper = number;\n",
};

/** The harness graph of a disposable copy of `files` with `edits` applied. */
async function editedHarness(files: readonly string[], edits: Edits) {
  const copy = await Deno.makeTempDir({
    dir: ROOT,
    prefix: "sentinel-ci-harness-graph-",
  });
  try {
    for (const file of files) {
      await Deno.mkdir(dirname(join(copy, file)), { recursive: true });
      await Deno.copyFile(join(ROOT, file), join(copy, file));
    }
    for (const [file, edit] of Object.entries(edits)) {
      const path = join(copy, file);
      await Deno.mkdir(dirname(path), { recursive: true });
      const text = files.includes(file) ? await Deno.readTextFile(path) : "";
      const edited = edit(text);
      assert.notEqual(edited, text, `${file} edit applies`);
      await Deno.writeTextFile(path, edited);
    }
    return await ciHarness(copy);
  } finally {
    await Deno.remove(copy, { recursive: true });
  }
}

Deno.test("self merge ops: the harness graph guard fails on any unpinned code edge", async (t) => {
  const real = await ciHarness(ROOT);
  // The reviewer's example: the proof emitter takes NATIVE_CI_MARKER by value
  // from the contract, which makes the contract's code closure emitter code.
  const contract = await codeGraph(ROOT, "src/contracts/native-ci.ts");
  assert.deepEqual(contract.problems, []);
  assert.ok(contract.local.includes("src/contracts/validation.ts"));
  const files = [
    ...new Set([
      "deno.json",
      "deno.lock",
      ...real.closure,
      ...real.named,
      ...contract.local,
    ]),
  ];
  const cases: [string, Edits, string[]][] = [
    ["a ../src value import", {
      "ops/native-ci-proof.ts": (text) =>
        text.replace(
          'const NATIVE_CI_MARKER = "sentinel_native_ci_v1:";',
          'import { NATIVE_CI_MARKER } from "../src/contracts/native-ci.ts";',
        ),
    }, contract.local],
    ["a single-quoted relative import", {
      ...HELPER,
      "ops/ci-shards.ts": (text) =>
        `import { CI_HELPER } from './ci-helper.ts';\n${text}`,
    }, ["ops/ci-helper.ts"]],
    ["a dynamic import of a file outside ops/", {
      "src/ci-gate.ts": () => "export const gate = 1;\n",
      "test-local.ts": (text) => `${text}await import("./src/ci-gate.ts");\n`,
    }, ["src/ci-gate.ts"]],
    ["a side-effect import", {
      ...HELPER,
      "ops/code-size.ts": (text) => `import './ci-helper.ts';\n${text}`,
    }, ["ops/ci-helper.ts"]],
    ["a file read by a single-quoted path", {
      "ops/ci-limits.json": () => "{}\n",
      "ops/ci-shards.ts": (text) =>
        `${text}await Deno.readTextFile(new URL('./ci-limits.json', import.meta.url));\n`,
    }, ["ops/ci-limits.json"]],
    // The task's script is an entry: its own import is found too.
    ["a ci.yml step running a deno.json task", {
      ...HELPER,
      "ops/ci-gate.ts": () => 'import "./ci-helper.ts";\n',
      "deno.json": (text) => {
        const config = JSON.parse(text);
        config.tasks["ci:gate"] = "deno run --allow-read=. ops/ci-gate.ts";
        return JSON.stringify(config);
      },
      [CI_WORKFLOW]: (text) =>
        text.replace(
          "test-local.ts --checks",
          "test-local.ts --checks && deno task ci:gate",
        ),
    }, ["ops/ci-gate.ts", "ops/ci-helper.ts"]],
  ];
  for (const [name, edits, expected] of cases) {
    await t.step(name, async () => {
      const harness = await editedHarness(files, edits);
      assert.deepEqual(harness.problems, []);
      assert.deepEqual(unpinned(harness), expected);
    });
  }
  await t.step("a type-only import stays outside the pin", async () => {
    const harness = await editedHarness(files, {
      ...HELPER,
      "ops/native-ci-proof.ts": (text) =>
        `import type { CiHelper } from "./ci-helper.ts";\n${text}`,
    });
    assert.deepEqual(harness.problems, []);
    assert.deepEqual(harness.closure, real.closure);
    assert.ok(harness.typeOnly.includes("ops/ci-helper.ts"));
    assert.deepEqual(unpinned(harness), []);
  });
  await t.step(
    "a dynamic import of a computed specifier is a problem",
    async () => {
      const harness = await editedHarness(files, {
        ...HELPER,
        "ops/ci-shards.ts": (text) =>
          `${text}const helper = "ci-helper";\nawait import(\`./\${helper}.ts\`);\n`,
      });
      assert.deepEqual(harness.problems, [
        "ops/ci-shards.ts: dynamic import of a computed specifier",
      ]);
    },
  );
});
