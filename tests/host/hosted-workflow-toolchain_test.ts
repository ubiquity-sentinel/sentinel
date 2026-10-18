/** The supervisor's model jobs provide the target toolchain the sandbox can reach. */
import assert from "node:assert/strict";
import { BUN_LINUX_ARM64_PIN } from "../../src/replay/bun-frozen-reader.ts";
import { SANDBOX_BUN_EXECUTABLE } from "../../src/host/local-client.ts";

const ROOT = decodeURIComponent(new URL("../..", import.meta.url).pathname)
  .replace(/\/$/, "");
const SUPERVISOR = await Deno.readTextFile(
  `${ROOT}/.github/workflows/supervisor.yml`,
);
const CI = await Deno.readTextFile(`${ROOT}/.github/workflows/ci.yml`);

/**
 * The model sandbox reads only platform defaults plus exact grants; the
 * rendered Codex profile grants exactly this Bun executable.
 */
const SANDBOX_BUN = SANDBOX_BUN_EXECUTABLE;
const EXPOSE_STEP = "Expose the pinned Bun to the model sandbox";

/** One top-level job's lines, up to the next job key or the end. */
function jobLines(workflow: string, job: string): string[] {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${job}:`);
  if (start < 0) throw new Error(`supervisor job ${job} is missing`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^ {2}[a-z][a-z_-]*:$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end);
}

/** Every `      - ` step of one job as its own text block, in order. */
function jobSteps(workflow: string, job: string): string[] {
  const lines = jobLines(workflow, job);
  const steps: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("      - ")) {
      if (current !== null) steps.push(current.join("\n"));
      current = [line];
    } else if (current !== null) {
      current.push(line);
    }
  }
  if (current !== null) steps.push(current.join("\n"));
  return steps;
}

function stepIndex(steps: readonly string[], test: RegExp): number {
  const found = steps.flatMap((step, index) => test.test(step) ? [index] : []);
  assert.equal(found.length, 1, `exactly one step matches ${test}`);
  return found[0];
}

/** The one pinned setup-bun line and Bun version the deterministic CI uses. */
function ciBunPin(): { uses: string; version: string } {
  const uses = CI.split("\n").filter((line) =>
    line.includes("oven-sh/setup-bun@")
  );
  assert.equal(uses.length, 1, "ci.yml pins exactly one setup-bun step");
  const usesLine = uses[0].trim().replace(/^- /, "");
  assert.match(usesLine, /^uses: oven-sh\/setup-bun@[0-9a-f]{40} # v\S+$/);
  const version = /bun-version: (\S+)/.exec(CI)?.[1];
  assert.ok(version !== undefined, "ci.yml names its Bun version");
  return { uses: usesLine, version };
}

Deno.test("hosted workflow: model jobs install the target's pinned Bun where the sandbox can execute it", () => {
  const pin = ciBunPin();
  // ubiquity/ai.ubq.fi runs only on Bun since d28cefa: its quality wrappers
  // refuse anything but Bun 1.4.0, the same runtime its frozen release pins.
  assert.equal(pin.version, BUN_LINUX_ARM64_PIN.version);
  for (
    const [job, runtimeStep] of [
      ["matrix_cell", "Run isolated issue cell"],
      ["repair", "Run selected Sentinel runtime"],
    ] as const
  ) {
    const steps = jobSteps(SUPERVISOR, job);
    const node = stepIndex(steps, /uses: actions\/setup-node@/);
    const bun = stepIndex(steps, /uses: oven-sh\/setup-bun@/);
    const expose = stepIndex(steps, new RegExp(`- name: ${EXPOSE_STEP}$`, "m"));
    const runtime = stepIndex(
      steps,
      new RegExp(`- name: ${runtimeStep}$`, "m"),
    );
    const setup = steps[bun];
    // The exact action commit and Bun version the deterministic CI already
    // proved, never a floating tag or a second pin.
    assert.equal(
      setup.split("\n")[0].trim(),
      `- ${pin.uses}`,
      `${job} uses the ci.yml setup-bun pin`,
    );
    assert.ok(
      setup.includes(`bun-version: ${pin.version}`),
      `${job} installs Bun ${pin.version}`,
    );
    assert.ok(
      !/\benv:|secrets\.|token/i.test(setup),
      `${job} gives the toolchain installer no credential`,
    );
    assert.ok(node < bun && bun < expose && expose < runtime, job);
    // The Codex permission profile grants `:minimal` platform reads plus
    // exact executables only, so the runner-home install that setup-bun puts
    // on PATH is invisible to model commands. A real executable copy at the
    // exactly granted path is what the sandboxed shell actually finds.
    const exposeText = steps[expose];
    assert.ok(exposeText.includes("set -euo pipefail"), job);
    assert.ok(
      exposeText.includes(
        `sudo install -m755 "$(command -v bun)" ${SANDBOX_BUN}`,
      ),
      `${job} installs a real Bun executable at ${SANDBOX_BUN}`,
    );
    assert.ok(
      exposeText.includes(
        `test "$(${SANDBOX_BUN} --version)" = "${pin.version}"`,
      ),
      `${job} proves the sandbox-visible Bun is exactly ${pin.version}`,
    );
    assert.ok(!/secrets\.|token/i.test(exposeText), job);
  }
});

Deno.test("hosted workflow: jobs that start no target model session install no Bun", () => {
  for (const job of ["maintenance", "prepare", "matrix_plan", "finalize"]) {
    const text = jobLines(SUPERVISOR, job).join("\n");
    assert.ok(!text.includes("setup-bun"), `${job} installs no Bun`);
    assert.ok(!text.includes(SANDBOX_BUN), `${job} exposes no Bun`);
  }
  // No other supervisor reference may float the action.
  for (const line of SUPERVISOR.split("\n")) {
    if (!line.includes("oven-sh/setup-bun@")) continue;
    assert.match(line, /oven-sh\/setup-bun@[0-9a-f]{40} # v/);
  }
});

Deno.test("hosted workflow: self-test dependencies are prepared without credentials before mint", () => {
  const nodeVersion = /node-version: (\S+)/.exec(CI)?.[1];
  assert.equal(nodeVersion, "24.19.0");
  for (const job of ["matrix_plan", "matrix_cell", "repair"]) {
    const steps = jobSteps(SUPERVISOR, job);
    const node = stepIndex(steps, /uses: actions\/setup-node@/);
    assert.ok(steps[node].includes(`node-version: ${nodeVersion}`));
    const expose = stepIndex(
      steps,
      /- name: Expose the pinned Node to the model sandbox$/m,
    );
    assert.ok(
      steps[expose].includes(
        'sudo install -m755 "$(command -v node)" /usr/local/bin/node',
      ),
    );
    assert.ok(steps[expose].includes(`= "v${nodeVersion}"`));
    const setup = stepIndex(
      steps,
      /- name: Install locked self-test dependencies$/m,
    );
    const mint = stepIndex(
      steps,
      /- name: Mint the scoped sentinel App token$/m,
    );
    const seal = stepIndex(
      steps,
      /- name: Seal trusted self-test dependencies$/m,
    );
    assert.ok(
      node < expose && expose < setup && setup < seal && seal < mint,
      job,
    );
    assert.ok(steps[setup].includes("working-directory: launcher"));
    assert.ok(
      steps[setup].includes(
        "npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefix .github/actions/sentinel-app-token",
      ),
    );
    assert.ok(!/env:|secrets\.|outputs\.token/.test(steps[setup]));
    assert.ok(steps[seal].includes("working-directory: launcher"));
    assert.ok(steps[seal].includes("ops/hosted-autonomy-self-dependencies.ts"));
    assert.ok(steps[seal].includes("--allow-env=PATH,NODE_V8_COVERAGE"));
    assert.ok(!/secrets\.|outputs\.token|--allow-net/.test(steps[seal]));
    const lines = jobLines(SUPERVISOR, job).join("\n");
    assert.equal(
      lines.includes("SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT"),
      job !== "matrix_cell",
    );
  }
  for (const job of ["maintenance", "prepare", "finalize"]) {
    assert.equal(
      jobLines(SUPERVISOR, job).join("\n").includes(
        "SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT",
      ),
      false,
    );
  }
});
