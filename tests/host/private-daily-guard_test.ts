/**
 * Execute the private workflow's pacing step with fake gh, git and date on
 * PATH. The real shell must dispatch only after complete, usable reads.
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
    String(entry.run).includes("gh workflow run supervisor.yml")
  );
  assert.ok(step);
  return String(step.run);
}

// Return the projected API values, including partial stdout and a diagnostic
// when a later page fails. The active-run URLs have no age or ref filter.
const FAKE_GH = `#!/bin/bash
if [ "$1" = workflow ]; then
  printf '%s\\n' "$*" >> "$LOG"
  exit 0
fi
shift
if [ "$1" = --paginate ]; then shift; fi
case "$1" in
  *"supervisor.yml/runs?status=queued&per_page=1")
    answer="$QUEUED"
    if [ -f "$LOG.billed" ]; then answer="$QUEUED_AFTER_BILLING"; fi
    ;;
  *"supervisor.yml/runs?status=in_progress&per_page=1") answer="$IN_PROGRESS";;
  *"/check-runs?"*) answer="$CI";;
  *"supervisor.yml/runs?created=%3E%3D$MONTH&per_page=100") answer="$SUPERVISOR_IDS";;
  *"ci.yml/runs?created=%3E%3D$MONTH&per_page=100") answer="$CI_IDS";;
  *"/actions/runs/"*"/jobs?"*) answer="$JOBS";;
  *"private-daily.yml/runs?created=%3E%3D$MONTH&per_page=1") answer="$DAILY_COUNT";;
  *"private-sync.yml/runs?created=%3E%3D$MONTH&per_page=1")
    answer="$SYNC_COUNT"
    : > "$LOG.billed"
    ;;
  *) echo "unexpected gh $*" >&2; exit 2;;
esac
case "$answer" in
  fail) exit 1;;
  partial) printf '11\\n'; echo "synthetic failed page" >&2; exit 1;;
esac
printf '%s\\n' "$answer"
`;

const FAKE_DATE = `#!/bin/bash
[ "$*" = "-u +%F" ] || exit 2
[ "$TODAY" != fail ] || exit 1
printf '%s\\n' "$TODAY"
`;

const OK = {
  TODAY: "2026-11-02",
  QUEUED: "0",
  QUEUED_AFTER_BILLING: "0",
  IN_PROGRESS: "0",
  CI: "green",
  SUPERVISOR_IDS: "11\n12",
  CI_IDS: "21",
  JOBS: "30\n5",
  DAILY_COUNT: "3",
  SYNC_COUNT: "3",
};

async function run(scenario: Record<string, string>) {
  await Deno.mkdir(".sentinel-artifacts", { recursive: true });
  const root = await Deno.makeTempDir({
    dir: ".sentinel-artifacts",
    prefix: "daily-guard-",
  });
  try {
    const bin = `${Deno.cwd()}/${root}/bin`;
    await Deno.mkdir(bin);
    for (
      const [name, script] of [
        ["gh", FAKE_GH],
        ["date", FAKE_DATE],
        ["git", "#!/bin/bash\necho " + "c".repeat(40) + "\n"],
      ]
    ) {
      await Deno.writeTextFile(`${bin}/${name}`, script, { mode: 0o755 });
    }
    const log = `${Deno.cwd()}/${root}/dispatches`;
    await Deno.writeTextFile(`${root}/guard.sh`, await guardScript());
    const today = scenario.TODAY ?? OK.TODAY;
    const result = await new Deno.Command("/bin/bash", {
      args: [`${root}/guard.sh`],
      clearEnv: true,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        GH_TOKEN: "synthetic",
        GH_REPO: "ubiquity-sentinel-private/sentinel",
        LOG: log,
        MONTH: `${today.slice(0, 7)}-01`,
        ...OK,
        ...scenario,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
    const dispatches = await Deno.readTextFile(log).then(
      (text) => text.trim().split("\n"),
      () => [],
    );
    return {
      code: result.code,
      out: decode(result.stdout) + decode(result.stderr),
      dispatches,
    };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("private daily guard: an active supervisor blocks dispatch regardless of age", async (t) => {
  for (
    const [name, scenario, expected] of [
      ["queued", { QUEUED: "1" }, "queued"],
      ["in progress", { IN_PROGRESS: "1" }, "in_progress"],
      ["queued during billing", { QUEUED_AFTER_BILLING: "1" }, "queued"],
    ] as const
  ) {
    await t.step(name, async () => {
      const result = await run(scenario);
      assert.equal(result.code, 0, result.out);
      assert.deepEqual(result.dispatches, [], result.out);
      assert.equal(result.out, `no cycle: a supervisor run is ${expected}\n`);
    });
  }
});

Deno.test("private daily guard: any failed or malformed read ends green with one line and no dispatch", async (t) => {
  for (
    const [name, scenario, reason] of [
      ["date unreadable", { TODAY: "fail" }, "the UTC date is unreadable"],
      ["day malformed", { TODAY: "2026-11-00" }, "the UTC date is unreadable"],
      [
        "queued runs unreadable",
        { QUEUED: "fail" },
        "queued supervisor runs are unreadable",
      ],
      [
        "in-progress runs unreadable",
        { IN_PROGRESS: "partial" },
        "in_progress supervisor runs are unreadable",
      ],
      [
        "in-progress count malformed",
        { IN_PROGRESS: "x" },
        "unreadable in_progress supervisor run count",
      ],
      [
        "checks unreadable",
        { CI: "fail" },
        "the launcher's checks are unreadable",
      ],
      [
        "CI not green",
        { CI: "not_green" },
        `launcher ${
          "c".repeat(40)
        } has no green test-local yet (running, red or absent)`,
      ],
      [
        "later runs page failed",
        { CI_IDS: "partial" },
        "this month's ci.yml runs are unreadable",
      ],
      [
        "run ID malformed",
        { SUPERVISOR_IDS: "11\nx" },
        "unreadable supervisor.yml run id",
      ],
      [
        "later jobs page failed",
        { JOBS: "partial" },
        "the jobs of run 11 are unreadable",
      ],
      [
        "job minutes malformed",
        { JOBS: "30\nNaN" },
        "unreadable job minutes of run 11",
      ],
      [
        "daily count unreadable",
        { DAILY_COUNT: "fail" },
        "this month's private-daily.yml runs are unreadable",
      ],
      [
        "sync count malformed",
        { SYNC_COUNT: "x" },
        "unreadable private-sync.yml run count",
      ],
    ] as const
  ) {
    await t.step(name, async () => {
      const result = await run(scenario);
      assert.equal(result.code, 0, result.out);
      assert.deepEqual(result.dispatches, [], result.out);
      assert.equal(result.out, `no cycle: ${reason}\n`);
    });
  }
});

Deno.test("private daily guard: bills the same inputs and paces dispatch within the monthly cap", async (t) => {
  // Default usage: 3 runs x (30 + 5) job minutes + 3 daily + 3 sync.
  for (
    const [name, scenario, used, allowance, decision] of [
      ["day one holds this usage", { TODAY: "2026-11-01" }, 111, 60, "hold"],
      ["unused allowance carries into day two", {}, 111, 120, "dispatch"],
      ["one minute under day two", { DAILY_COUNT: "11" }, 119, 120, "dispatch"],
      [
        "own runs bring usage to allowance",
        { DAILY_COUNT: "12" },
        120,
        120,
        "hold",
      ],
      ["one minute over day two", { DAILY_COUNT: "13" }, 121, 120, "hold"],
      ["zero-padded UTC day", { TODAY: "2026-11-08" }, 111, 480, "dispatch"],
      [
        "day 31 one minute below the cap",
        { TODAY: "2026-12-31", JOBS: "598", DAILY_COUNT: "2" },
        1799,
        1800,
        "dispatch",
      ],
      [
        "day 31 at the cap",
        { TODAY: "2026-12-31", JOBS: "598" },
        1800,
        1800,
        "hold",
      ],
      [
        "day 31 above the cap and below its daily allowance",
        { TODAY: "2026-12-31", JOBS: "600" },
        1806,
        1800,
        "hold",
      ],
    ] as const
  ) {
    await t.step(name, async () => {
      const result = await run(scenario);
      assert.equal(result.code, 0, result.out);
      assert.deepEqual(
        result.dispatches,
        decision === "dispatch"
          ? [
            "workflow run supervisor.yml --repo ubiquity-sentinel-private/sentinel --ref sentinel-supervisor",
          ]
          : [],
        result.out,
      );
      const prefix = decision === "hold" ? "no cycle: " : "";
      assert.equal(
        result.out,
        `${prefix}month-to-date billed minutes (estimate): used=${used} allowance=${allowance} decision=${decision}\n`,
      );
    });
  }
});
