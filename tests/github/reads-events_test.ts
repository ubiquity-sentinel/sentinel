/**
 * The runtime check read can carry each GitHub Actions check run's workflow
 * event, but only when the caller asks for it and the real client can prove
 * it. The proof is the check run's own Actions `details_url` (the run id and
 * job id), then `GET /actions/runs/{run_id}`: the returned run must be the
 * exact id and head and carry a trusted event. Every failure leaves the
 * event absent, so attribution stays on the legacy path.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type {
  GitHubChecksV1,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import {
  checkRunWire,
  checksPageWire,
  FakeClock,
  httpRespond,
  makePort,
  SHA1,
  SHA2,
  statusesPageWire,
} from "./helpers.ts";

const REPO_PATH = "/repos/ubiquity-sentinel/sentinel";
const COMMIT = `${REPO_PATH}/commits/${SHA1}`;
const RUN = 7001;
const JOB = 9001;
const ACTIONS = { id: 15368, slug: "github-actions" };

type EventReadV1 = (
  head: GitSha,
  names?: ReadonlySet<string>,
  options?: { events?: boolean },
) => Promise<PortResultV1<GitHubChecksV1>>;

function check(
  name: string,
  job = JOB,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return checkRunWire({
    id: job,
    name,
    app: ACTIONS,
    details_url:
      `https://github.com/ubiquity-sentinel/sentinel/actions/runs/${RUN}/job/${job}`,
    ...overrides,
  });
}

function script(runs: unknown[], actions: unknown) {
  return [
    httpRespond(
      "GET",
      `${COMMIT}/check-runs?per_page=100&page=1`,
      200,
      checksPageWire(runs),
    ),
    httpRespond("GET", `${REPO_PATH}/actions/runs/${RUN}`, 200, actions),
    httpRespond(
      "GET",
      `${COMMIT}/statuses?per_page=100&page=1`,
      200,
      statusesPageWire([]),
    ),
  ];
}

async function read(
  runs: unknown[],
  actions: unknown,
  options?: { events?: boolean },
) {
  const { port, transport } = makePort({
    clock: new FakeClock(Date.parse("2026-09-07T02:00:00Z")),
    script: script(runs, actions),
  });
  const eventRead = port.readChecks.bind(port) as EventReadV1;
  const result = await eventRead(SHA1, undefined, options);
  assert.ok(result.ok, JSON.stringify(result));
  return {
    checks: result.value.checks,
    actionReads: transport.requests.filter((request) =>
      request.url.includes("/actions/runs/")
    ).map((request) => request.url),
  };
}

Deno.test("readChecks events: the same workflow run is read once and its proven event reaches every check", async () => {
  const { checks, actionReads } = await read(
    [check("quality", JOB), check("test", JOB + 1)],
    { id: RUN, head_sha: SHA1, event: "pull_request" },
    { events: true },
  );
  assert.deepEqual(
    checks.map((value) => value.event),
    ["pull_request", "pull_request"],
  );
  assert.deepEqual(actionReads, [
    `https://api.github.com${REPO_PATH}/actions/runs/${RUN}`,
  ]);
});

Deno.test("readChecks events: the legacy read makes no workflow-run request and carries no event", async () => {
  const { checks, actionReads } = await read(
    [check("quality")],
    { id: RUN, head_sha: SHA1, event: "pull_request" },
  );
  assert.deepEqual(checks.map((value) => value.event), [undefined]);
  assert.deepEqual(actionReads, []);
});

Deno.test("readChecks events: an unproven run or event stays absent", async () => {
  for (
    const [actions, runs] of [
      [{ id: RUN, head_sha: SHA2, event: "push" }, [check("quality")]],
      [{ id: RUN, head_sha: SHA1, event: "not an event" }, [check("test")]],
      [{ id: RUN, head_sha: SHA1, event: "push" }, [check("quality", JOB, {
        details_url:
          `https://github.com/ubiquity-sentinel/sentinel/actions/runs/${RUN}/job/2`,
      })]],
      [{ id: RUN, head_sha: SHA1, event: "push" }, [check("quality", JOB, {
        app: null,
      })]],
    ] as const
  ) {
    const { checks } = await read([...runs], actions, { events: true });
    assert.equal(checks[0]?.event, undefined, JSON.stringify(actions));
  }
});
