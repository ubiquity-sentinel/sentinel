/**
 * The private daily guard (`private-daily.yml`, step "Start at most one
 * supervisor cycle per UTC day") executed as written, with fake `gh` and
 * `git` on PATH: it dispatches only when every read succeeded and every
 * guard passed, and any failed or malformed read (an HTTP error with no
 * body, a failed later page, a non-numeric answer) ends the day green with
 * no dispatch. Nothing here reaches GitHub.
 */
import assert from "node:assert/strict";
import { parse } from "@std/yaml";

type Obj = Record<string, unknown>;

async function guardScript(): Promise<string> {
  const doc = parse(
    await Deno.readTextFile(".github/workflows/private-daily.yml"),
  ) as Obj;
  const steps = ((doc.jobs as Obj).daily as Obj).steps as Obj[];
  const step = steps.find((entry) =>
    entry.name === "Start at most one supervisor cycle per UTC day"
  )!;
  return String(step.run);
}

// Answers by URL; a scenario value of `fail` exits 1 with no output (a
// body-less API error), anything else is printed as the `--jq` result.
const FAKE_GH = `#!/bin/bash
args="$*"
case "$args" in
  *"workflow run supervisor.yml"*) echo dispatched >> "$LOG"; exit 0;;
  *"supervisor.yml/runs?created="*"per_page=1 "*) answer="$STARTED";;
  *"/check-runs?"*) answer="$CI";;
  *"supervisor.yml/runs?created="*) answer="$SUPERVISOR_IDS";;
  *"ci.yml/runs?created="*) answer="$CI_IDS";;
  *"/actions/runs/"*"/jobs?"*) answer="$JOBS";;
  *"private-daily.yml/runs?"*|*"private-sync.yml/runs?"*) answer="$COUNT";;
  *) echo "unexpected gh $args" >&2; exit 2;;
esac
if [ "$answer" = fail ]; then exit 1; fi
printf '%s\\n' "$answer"
`;

const OK = {
  STARTED: "0",
  CI: "green",
  SUPERVISOR_IDS: "11\n12",
  CI_IDS: "21",
  JOBS: "30\n5",
  COUNT: "3",
};

async function run(scenario: Record<string, string>) {
  const root = await Deno.makeTempDir({
    dir: ".sentinel-artifacts",
    prefix: "daily-guard-",
  }).catch(async () => {
    await Deno.mkdir(".sentinel-artifacts", { recursive: true });
    return Deno.makeTempDir({ dir: ".sentinel-artifacts", prefix: "daily-" });
  });
  try {
    const bin = `${Deno.cwd()}/${root}/bin`;
    await Deno.mkdir(bin);
    await Deno.writeTextFile(`${bin}/gh`, FAKE_GH);
    await Deno.writeTextFile(
      `${bin}/git`,
      "#!/bin/bash\necho " + "c".repeat(40) + "\n",
    );
    await Deno.chmod(`${bin}/gh`, 0o755);
    await Deno.chmod(`${bin}/git`, 0o755);
    const log = `${Deno.cwd()}/${root}/dispatches`;
    await Deno.writeTextFile(`${root}/guard.sh`, await guardScript());
    const result = await new Deno.Command("/bin/bash", {
      args: [`${root}/guard.sh`],
      clearEnv: true,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        GH_TOKEN: "synthetic",
        GH_REPO: "ubiquity-sentinel-private/sentinel",
        LOG: log,
        ...OK,
        ...scenario,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
    const dispatched = await Deno.readTextFile(log).then(
      (text) => text.trim().split("\n").length,
      () => 0,
    );
    return {
      code: result.code,
      out: decode(result.stdout) + decode(result.stderr),
      dispatched,
    };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("private daily guard: dispatches once when every read succeeds under the budget", async () => {
  const ok = await run({});
  assert.equal(ok.code, 0, ok.out);
  assert.equal(ok.dispatched, 1, ok.out);
  // 3 runs x (30 + 5) job minutes + 3 + 3 daily and sync runs.
  assert.match(
    ok.out,
    /month-to-date billed minutes \(estimate\): 111 of 2000/,
  );
});

Deno.test("private daily guard: any failed or malformed read, or a spent guard, ends green with no dispatch", async (t) => {
  for (
    const [name, scenario, reason] of [
      ["today's runs unreadable", { STARTED: "fail" }, /unreadable/],
      [
        "today's count malformed",
        { STARTED: "x" },
        /unreadable supervisor run count/,
      ],
      ["already started today", { STARTED: "1" }, /already started/],
      ["checks unreadable", { CI: "fail" }, /checks are unreadable/],
      ["CI not green", { CI: "not_green" }, /no green test-local/],
      [
        "month listing unreadable",
        { CI_IDS: "fail" },
        /ci\.yml runs are unreadable/,
      ],
      [
        "a later jobs page failed",
        { JOBS: "fail" },
        /jobs of run 11 are unreadable/,
      ],
      ["malformed job minutes", { JOBS: "30\nNaN" }, /unreadable job minutes/],
      [
        "daily count unreadable",
        { COUNT: "fail" },
        /private-daily\.yml runs are unreadable/,
      ],
      ["budget spent", { JOBS: "600" }, /free-tier guard: 1806 minutes/],
    ] as const
  ) {
    await t.step(name, async () => {
      const result = await run(scenario);
      assert.equal(result.code, 0, result.out);
      assert.equal(result.dispatched, 0, result.out);
      assert.match(result.out, /no cycle today: /);
      assert.match(result.out, reason);
    });
  }
});
