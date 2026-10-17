/**
 * The owner command `deno task check:macos-boundary` (issue #100): its pure
 * verdict, argument and line-format logic, and its non-darwin behaviour (an
 * explicit UNSUPPORTED result with exit 2 that spawns and writes nothing),
 * the owner trade-off it always prints, and the residual-risk probe the real
 * child runs (`residualProbe`, exercised here with a stand-in executable).
 * The darwin levels themselves run only on the owner's Mac.
 */

import assert from "node:assert/strict";

import {
  type CheckIoV1,
  type CheckStepV1,
  checkVerdict,
  compareVersions,
  formatStep,
  HELP_LINES,
  parseCheckArgs,
  parseCodexVersion,
  resultLines,
  runMacosBoundaryCheck,
  TRADE_OFF_LINES,
} from "./macos-boundary-check.ts";
import {
  RESIDUAL_PROBE_NAME,
  residualProbe,
  residualProbeArgs,
} from "./macos-boundary-child.ts";
import { CODEX_OPT_IN_ACK } from "../../src/host/local-supervisor-shared.ts";

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/host\/macos-boundary-check_test\.ts$/,
  "",
);

function step(
  status: CheckStepV1["status"],
  name: string,
  extra: Partial<CheckStepV1> = {},
): CheckStepV1 {
  return { level: "L1", name, status, detail: `${name} detail`, ...extra };
}

Deno.test("macos boundary check: arguments", () => {
  assert.deepEqual(parseCheckArgs([]), {
    ok: true,
    value: { model: false, keep: false, help: false },
  });
  assert.deepEqual(parseCheckArgs(["--model", "--keep"]), {
    ok: true,
    value: { model: true, keep: true, help: false },
  });
  assert.deepEqual(parseCheckArgs(["--help"]), {
    ok: true,
    value: { model: false, keep: false, help: true },
  });
  assert.deepEqual(parseCheckArgs(["-h"]), {
    ok: true,
    value: { model: false, keep: false, help: true },
  });
  const unknown = parseCheckArgs(["--model", "--force"]);
  assert.equal(unknown.ok, false);
  assert.match(!unknown.ok ? unknown.error : "", /--force/);
});

Deno.test("macos boundary check: any gating failure is FAIL and the baseline never gates", () => {
  assert.deepEqual(
    checkVerdict([step("PASS", "a"), step("INFO", "baseline")]),
    { result: "PASS", exitCode: 0, firstFailure: null },
  );
  assert.deepEqual(
    checkVerdict([
      step("PASS", "a"),
      step("FAIL", "exempt_nested_apply"),
      step("FAIL", "later"),
      step("INFO", "baseline"),
    ]),
    {
      result: "FAIL",
      exitCode: 1,
      firstFailure: "[L1] exempt_nested_apply: exempt_nested_apply detail",
    },
  );
  // A missing prerequisite is exit 2 even when a later level also failed.
  assert.deepEqual(
    checkVerdict([
      step("FAIL", "boom"),
      step("FAIL", "sandbox_exec", { level: "L0", prerequisite: true }),
    ]),
    {
      result: "FAIL",
      exitCode: 2,
      firstFailure: "[L0] sandbox_exec: sandbox_exec detail",
    },
  );
  // Nothing gating passed: never a vacuous PASS.
  assert.deepEqual(
    checkVerdict([step("INFO", "baseline"), step("SKIP", "model")]),
    {
      result: "FAIL",
      exitCode: 1,
      firstFailure: "no gating step passed",
    },
  );
  assert.equal(checkVerdict([]).result, "FAIL");
});

Deno.test("macos boundary check: one line per step", () => {
  assert.equal(
    formatStep({
      level: "L2",
      name: "exemption_applied",
      status: "PASS",
      detail: "codex-exemption: applied",
    }),
    "[L2] PASS exemption_applied: codex-exemption: applied",
  );
  assert.equal(
    formatStep({
      level: "L0",
      name: "codex",
      status: "FAIL",
      detail: "a\nb",
    }),
    "[L0] FAIL codex: a\\nb",
  );
});

Deno.test("macos boundary check: codex version parsing", () => {
  assert.deepEqual(parseCodexVersion("codex-cli 0.154.0\n"), [0, 154, 0]);
  assert.deepEqual(parseCodexVersion("codex-cli 1.2.3-alpha.4"), [1, 2, 3]);
  assert.equal(parseCodexVersion("nonsense"), null);
  assert.equal(compareVersions([0, 154, 0], [0, 154, 0]), 0);
  assert.ok(compareVersions([0, 153, 9], [0, 154, 0]) < 0);
  assert.ok(compareVersions([1, 0, 0], [0, 154, 0]) > 0);
});

Deno.test("macos boundary check: non-darwin reports UNSUPPORTED with exit 2 and spawns nothing", async () => {
  const cwd = await Deno.makeTempDir({
    prefix: "sentinel-macos-check-",
    dir: ROOT,
  });
  try {
    const lines: string[] = [];
    let spawned = 0;
    const io: CheckIoV1 = {
      os: "linux",
      cwd,
      env: () => {
        throw new Error("no environment may be read on an unsupported host");
      },
      print: (line) => lines.push(line),
      run: () => {
        spawned++;
        return Promise.reject(new Error("no process may be spawned"));
      },
    };
    assert.equal(await runMacosBoundaryCheck([], io), 2);
    assert.equal(spawned, 0);
    assert.ok(
      lines.some((line) => line.startsWith("RESULT: UNSUPPORTED")),
      lines.join("\n"),
    );
    const entries: string[] = [];
    for await (const entry of Deno.readDir(cwd)) entries.push(entry.name);
    assert.deepEqual(entries, [], "nothing is written on an unsupported host");

    // A usage error is reported before the platform gate, also as exit 2.
    lines.length = 0;
    assert.equal(await runMacosBoundaryCheck(["--bogus"], io), 2);
    assert.ok(lines.some((line) => line.includes("--bogus")));
    assert.equal(spawned, 0);

    lines.length = 0;
    assert.equal(await runMacosBoundaryCheck(["--help"], io), 0);
    const help = lines.join("\n");
    for (
      const needle of [
        "sandbox-exec",
        "~/.codex/bin/codex",
        "Deno",
        "UOS_AI_TOKEN",
      ]
    ) {
      assert.ok(help.includes(needle), `help mentions ${needle}`);
    }
    assert.equal(spawned, 0);
  } finally {
    await Deno.remove(cwd, { recursive: true }).catch(() => {});
  }
});

Deno.test({
  name:
    "macos boundary check: the deno task entry exits 2 with UNSUPPORTED off macOS",
  ignore: Deno.build.os === "darwin",
  fn: async () => {
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-lock",
        "--allow-read=.",
        "--allow-env=PATH",
        "tests/host/macos-boundary-check.ts",
      ],
      cwd: ROOT,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(output.stdout);
    assert.equal(output.code, 2, new TextDecoder().decode(output.stderr));
    assert.match(stdout, /^RESULT: UNSUPPORTED /m);
  },
});

/** The one sentence the owner must read before opting in or closing #100. */
const TRADE_OFF_SENTENCE =
  "Opting in lets merged repair-host code reach an unconfined Codex; only a supervisor-owned broker removes that.";

Deno.test("macos boundary check: help states the opt-in and its trade-off in plain words", () => {
  const help = HELP_LINES.join("\n");
  assert.ok(help.includes(TRADE_OFF_SENTENCE), help);
  assert.ok(help.includes("~/.config/sentinel-local/codex-exemption-opt-in"));
  assert.ok(help.includes(`'${CODEX_OPT_IN_ACK}'`), "the exact opt-in text");
  assert.ok(!CODEX_OPT_IN_ACK.includes("'"), "the opt-in text pastes quoted");
  assert.match(help, /never creates your opt-in/);
});

Deno.test("macos boundary check: every result is followed by the trade-off, and PASS never closes #100 on its own", () => {
  const passed = resultLines({
    result: "PASS",
    exitCode: 0,
    firstFailure: null,
  });
  assert.equal(passed[0], "RESULT: PASS");
  assert.deepEqual(passed.slice(1), [...TRADE_OFF_LINES]);
  const text = TRADE_OFF_LINES.join("\n");
  assert.ok(text.includes(TRADE_OFF_SENTENCE), text);
  assert.match(text, /not a protected path/);
  assert.match(text, /residual_r1_unconfined_codex/);
  assert.match(text, /does not show that the repair host is confined/);
  assert.match(text, /#100/);
  for (const line of TRADE_OFF_LINES) assert.match(line, /^TRADE-OFF: /);
  const failed = resultLines({
    result: "FAIL",
    exitCode: 1,
    firstFailure: "[L1] x: y",
  });
  assert.equal(failed[0], "RESULT: FAIL [L1] x: y");
  assert.deepEqual(failed.slice(1), [...TRADE_OFF_LINES]);
});

Deno.test("macos boundary fixture: the residual probe is the exact unconfined codex sandbox argv", () => {
  assert.deepEqual(residualProbeArgs("/s/r1-probe"), [
    "sandbox",
    "-c",
    'sandbox_mode="danger-full-access"',
    "--",
    "/bin/sh",
    "-c",
    'printf x > "$1"',
    "r1-probe",
    "/s/r1-probe",
  ]);
  assert.equal(RESIDUAL_PROBE_NAME, "r1-probe");
});

Deno.test("macos boundary fixture: the residual probe reports what the launched program wrote, information only", async () => {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "sentinel-macos-check-", dir: ROOT }),
  );
  try {
    const state = `${root}/state`;
    await Deno.mkdir(`${state}/clients`, { recursive: true });
    // Stand-in for the exempted Codex: it runs the command after `--` with no
    // sandbox at all, exactly what danger-full-access means.
    const unconfined = `${root}/unconfined-codex`;
    await Deno.writeTextFile(
      unconfined,
      '#!/bin/sh\n[ "$1" = sandbox ] && [ "$2" = -c ] && [ "$4" = -- ] || exit 9\nshift 4\nexec "$@"\n',
    );
    await Deno.chmod(unconfined, 0o755);
    const reproduced = await residualProbe(state, unconfined);
    assert.equal(reproduced.name, "residual_r1_unconfined_codex");
    assert.equal(reproduced.gating, false);
    assert.match(reproduced.detail, /^REPRODUCED: /);
    assert.match(reproduced.detail, /supervisor-owned broker/);
    assert.equal(await Deno.readTextFile(`${state}/r1-probe`), "x");

    // A program that refuses leaves the residual stated, never denied.
    await Deno.remove(`${state}/r1-probe`);
    const refusing = `${root}/refusing-codex`;
    await Deno.writeTextFile(refusing, "#!/bin/sh\necho refused >&2\nexit 3\n");
    await Deno.chmod(refusing, 0o755);
    const notReproduced = await residualProbe(state, refusing);
    assert.equal(notReproduced.gating, false);
    assert.match(notReproduced.detail, /^not reproduced by this argv/);
    assert.match(notReproduced.detail, /the residual still stands/);
    assert.match(notReproduced.detail, /exit=3/);

    const missing = await residualProbe(state, `${root}/absent-codex`);
    assert.equal(missing.gating, false);
    assert.match(missing.detail, /^inconclusive: /);
    assert.match(missing.detail, /the residual still stands/);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
