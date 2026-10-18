/**
 * Rollback safety of the CI evidence lane. Generation 81 rolls back to the
 * installed generation-80 runtime (R80 e48e7e110), which then consumes what
 * generation 81 left behind: planned CI correction cells and the cell carrier
 * lines its launcher reads. The evidence itself is never persisted; only the
 * finding text changes. R80's own parsers, extracted read-only from the local
 * object store, must accept every shape this tree writes. A shallow checkout
 * without R80 ignores these cases.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  type MatrixCellPlanV1,
  matrixDigestV1,
} from "../../src/contracts/matrix.ts";
import {
  type GitHubCheckV1,
  type ModelRunRequestV1,
  portOk,
} from "../../src/contracts/ports.ts";
import { planMatrixWave, runMatrixCell } from "../../src/host/matrix.ts";
import { writeResult } from "../../src/host/matrix-actions-shared.ts";
import {
  CI_CORRECTION_FINDING_PREFIX,
  ciCorrectionFinding,
} from "../../src/repair/ci-rejection.ts";
import { MAX_CORRECTION_FINDING_CHARS } from "../../src/repair/loop-review-records.ts";
import { SHA3, T0 } from "../state/helpers.ts";
import {
  ACTUAL,
  freshIssue,
  makeRig,
  PROVIDER,
  ROOT,
  RUN,
  seedSnapshot,
  WAVE,
} from "./matrix-runtime-fixtures.ts";

const R80 = "e48e7e110e7cb2ed3385bf1be5165f05d8a4e481";
const GIT_ENV = {
  PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

async function r80Available(): Promise<boolean> {
  try {
    const probe = await new Deno.Command("git", {
      args: ["-C", ROOT, "cat-file", "-e", `${R80}^{commit}`],
      clearEnv: true,
      env: GIT_ENV,
      stdout: "null",
      stderr: "null",
    }).output();
    return probe.success;
  } catch {
    return false;
  }
}

/** Import R80 modules from its `src/` tree extracted under the repository. */
async function loadR80(paths: readonly string[]) {
  const dir = await Deno.makeTempDir({
    dir: ROOT,
    prefix: "sentinel-gen80-cievidence-",
  });
  const dispose = () => Deno.remove(dir, { recursive: true }).catch(() => {});
  try {
    // `git archive` is limited to the directory it runs in: run it at the
    // top of the work tree so R80's own top-level `src` is archived.
    const top = await new Deno.Command("git", {
      args: ["-C", ROOT, "rev-parse", "--show-toplevel"],
      clearEnv: true,
      env: GIT_ENV,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!top.success) throw new Error("R80 source unavailable");
    const archive = await new Deno.Command("git", {
      args: [
        "-C",
        new TextDecoder().decode(top.stdout).trim(),
        "archive",
        "--format=tar",
        R80,
        "src",
      ],
      clearEnv: true,
      env: GIT_ENV,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!archive.success) throw new Error("R80 source unavailable");
    await Deno.writeFile(`${dir}/tree.tar`, archive.stdout);
    const extracted = await new Deno.Command("tar", {
      args: ["-xf", `${dir}/tree.tar`, "-C", dir],
      clearEnv: true,
      env: { PATH: GIT_ENV.PATH },
      stdout: "null",
      stderr: "null",
    }).output();
    if (!extracted.success) throw new Error("R80 source unreadable");
    const modules: Record<string, unknown>[] = [];
    for (const path of paths) {
      modules.push(await import(new URL(`file://${dir}/${path}`).href));
    }
    return { modules, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

const available = await r80Available();
const BASE = "aafb7ee0598699bb7fb8a72ea133693ed64462da" as GitSha;

function failing(name: string): GitHubCheckV1 {
  return {
    name,
    status: "completed",
    conclusion: "failure",
    head: SHA3,
    startedAt: T0,
    completedAt: T0,
  } as GitHubCheckV1;
}

Deno.test("the CI finding keeps its prefix and bound and no longer denies log evidence", () => {
  const names = Array.from(
    { length: 12 },
    (_, index) => `${"n".repeat(60)}-${String(index).padStart(2, "0")}`,
  );
  const finding = ciCorrectionFinding(BASE, names.map(failing));
  assert.ok(finding.message.startsWith(CI_CORRECTION_FINDING_PREFIX));
  assert.ok(finding.message.length <= MAX_CORRECTION_FINDING_CHARS);
  assert.ok(!finding.message.includes("no CI log text"));
  assert.match(finding.message, /fix the candidate so they pass\.$/);
});

Deno.test({
  name:
    "R80 parses the generation-81 CI correction request and recognizes its finding",
  ignore: !available,
  fn: async () => {
    const loaded = await loadR80([
      "src/contracts/matrix-model.ts",
      "src/repair/ci-rejection.ts",
    ]);
    try {
      const [model, rejection] = loaded.modules as [
        {
          parseMatrixModelRequestV1: (
            input: unknown,
            path: string,
          ) => ModelRunRequestV1;
        },
        {
          isCiCorrectionFinding: (
            finding: { severity: string; path: string | null; message: string },
          ) => boolean;
          CI_CORRECTION_FINDING_PREFIX: string;
        },
      ];
      assert.equal(
        rejection.CI_CORRECTION_FINDING_PREFIX,
        CI_CORRECTION_FINDING_PREFIX,
      );
      const longest = ciCorrectionFinding(
        BASE,
        Array.from(
          { length: 8 },
          (_, index) => failing(`${"c".repeat(62)}${index}`),
        ),
      );
      for (
        const finding of [
          ciCorrectionFinding(BASE, [failing("validate")]),
          longest,
        ]
      ) {
        const request = {
          taskId: "issue-645",
          repository: {
            owner: "ubiquity",
            name: "ai.ubq.fi",
            installationId: 1,
          },
          base: BASE,
          checkoutBase: SHA3,
          issue: { number: 645, title: "t", body: "b" },
          evidence: [],
          reviewFindings: [finding],
          model: "gpt-reserve",
          reasoning: "max",
          maxDurationMs: 1_000,
          maxOutputChars: 1_000,
        };
        const parsed = model.parseMatrixModelRequestV1(
          JSON.parse(JSON.stringify(request)),
          "$",
        );
        assert.equal(parsed.reviewFindings?.[0].message, finding.message);
        assert.ok(rejection.isCiCorrectionFinding(finding));
      }
    } finally {
      await loaded.dispose();
    }
  },
});

Deno.test({
  name:
    "R80's launcher accepts the cell carrier of a generation-81 CI correction with evidence",
  ignore: !available,
  fn: async () => {
    const loaded = await loadR80(["src/host/hosted-runtime-matrix.ts"]);
    const rig = await makeRig([645], 1);
    try {
      const [launcher] = loaded.modules as [{
        resolveMatrixLauncherResult: (
          run: unknown,
          execution: unknown,
          job: "matrix_cell",
          stdin: string,
        ) => { status: string; matrixCarrier?: Record<string, unknown> };
      }];
      const seeded = await rig.store.writeRepair(
        seedSnapshot([freshIssue(645, rig.base)]),
        null,
      );
      assert.ok(seeded.ok);
      const report = await planMatrixWave(rig.deps, rig.planOptions());
      const planned = report.plan.cells[0];
      const request: ModelRunRequestV1 = {
        ...planned.request,
        checkoutBase: SHA3,
        reviewFindings: [ciCorrectionFinding(rig.base, [failing("validate")])],
      };
      const cell: MatrixCellPlanV1 = {
        ...planned,
        request,
        requestDigest: await matrixDigestV1(request),
      };
      const ctx = await rig.claimCell(cell);
      const stdout: string[] = [];
      const stderr: string[] = [];
      const log = console.log;
      const error = console.error;
      console.log = (...args: unknown[]) => stdout.push(args.join(" "));
      console.error = (...args: unknown[]) => stderr.push(args.join(" "));
      try {
        const result = await runMatrixCell(
          {
            ...ctx.deps,
            model: {
              modelId: "gpt-reserve",
              runModel: () =>
                Promise.resolve(portOk({
                  invocationId: "codex-r80",
                  outcome: "completed",
                  actual: {
                    evidenceKind: "request-runtime",
                    provider: PROVIDER,
                    threadId: "thread-r80",
                    turnId: "turn-r80",
                    terminalOrigin: "runtime",
                    observedTerminalStatus: "completed",
                    observedModel: "gpt-reserve",
                    observedReasoning: "max",
                    durationMs: 10,
                    outputChars: 10,
                  },
                  candidate: null,
                  error: null,
                })),
            },
            ciEvidence: {
              readCiFailureEvidence: (input) =>
                Promise.resolve({
                  head: input.head,
                  base: input.base,
                  checks: [],
                  omittedChecks: 0,
                  unavailable: "forbidden_actions_read",
                }),
            },
          },
          { waveId: WAVE, run: RUN, cell },
          ACTUAL,
          rig.clock.now(),
        );
        assert.equal(result.status, "completed");
        await writeResult(`${rig.tmp}/artifacts`, result);
      } finally {
        console.log = log;
        console.error = error;
      }
      assert.equal(stderr.length, 1, "one plain diagnostic line");
      assert.ok(!stderr[0].trim().startsWith("{"), "never a JSON record");
      const encoder = new TextEncoder();
      const resolved = launcher.resolveMatrixLauncherResult(
        {
          outcome: "exited",
          exitCode: 0,
          stdout: encoder.encode(stdout.join("\n") + "\n"),
          stderr: encoder.encode(stderr.join("\n") + "\n"),
          truncated: false,
          settled: true,
          detail: "exited",
        },
        {
          id: WAVE,
          runId: RUN.runId,
          runAttempt: RUN.runAttempt,
          launcherSha: RUN.launcherSha,
          purpose: "ordinary",
          revision: ACTUAL.runtimeSha,
          generation: ACTUAL.generation,
          releaseId: null,
          createdAt: T0,
        },
        "matrix_cell",
        JSON.stringify({ planDigest: "0".repeat(64), cellId: cell.cellId }),
      );
      assert.equal(resolved.status, "healthy", JSON.stringify(resolved));
      assert.equal(resolved.matrixCarrier?.cellId, cell.cellId);
    } finally {
      await rig.cleanup();
      await loaded.dispose();
    }
  },
});
