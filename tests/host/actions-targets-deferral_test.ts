/**
 * A pass whose committed targets were all unreadable (supervisor run
 * 43790005563: every default-branch read of the serial repair job failed
 * during a GitHub 403 burst and the job threw `targets_empty`, turning the
 * run red) defers instead when every failure looked transient, through the
 * actual hosted composition and the production target resolvers over fake
 * GitHub answers, the matrix rig's real Git state remote, release custody
 * and native identity:
 *
 * - an ordinary serial pass settles healthy with the idle deferral outcome,
 *   one text-free deferral line the launcher re-emits, no target cycle, no
 *   model start and no state write or GitHub request beyond the target reads;
 * - a failure that did not look transient (401, 404, a 403 without rate-limit
 *   evidence, an unusable answer) fails `targets_unavailable` instead, with
 *   the same line;
 * - a setting that lists no repository still refuses `targets_empty`;
 * - a verification execution and an admitted matrix cell fail
 *   `targets_unavailable`, writing nothing;
 * - the matrix planner publishes its empty zero-grant plan and a repository
 *   cell its refusal and marker, as for a cell whose target is not
 *   configured.
 */
import assert from "node:assert/strict";
import { ensureRepairStateSeed } from "../../src/host/actions-host-io.ts";
import { runActionsRepairHost } from "../../src/host/actions-repair-host.ts";
import {
  parseChildStatus,
  scanChildStatusRecords,
} from "../../src/host/hosted-runtime-status.ts";
import { runActionsMatrixHost } from "../../src/host/matrix-native-host.ts";
import { scanPlanDiagnostic } from "../../src/host/matrix-plan-diagnostic.ts";
import {
  REPAIR_CELL_SETTLED_WITHOUT_STARTUP,
  runRepairCellHost,
} from "../../src/host/repair-cell-actions.ts";
import {
  STATIC_TARGETS_DEFERRED,
  STATIC_TARGETS_EMPTY,
  STATIC_TARGETS_UNAVAILABLE,
  TARGETS_MAX,
} from "../../src/host/targets.ts";
import { parseRepairCellRefusalV1 } from "../../src/contracts/repair-delta.ts";
import type {
  HttpRequestV1,
  HttpResponseV1,
  HttpTransportV1,
} from "../../src/github/http.ts";
import { scanStepLines } from "../../src/repair/step-line.ts";
import {
  MAX_TARGETS_DEFERRAL_LISTED,
  TARGETS_DEFERRAL_KIND,
} from "../../src/repair/targets-deferral-line.ts";
import { rig } from "./matrix-actions-fixtures.ts";

const D = "a".repeat(64);
const CELL = "c".repeat(64);

/** The production target resolvers, over the transport each test supplies. */
const PRODUCTION = {
  resolveDefaultBranch: undefined,
  resolveTreeFacts: undefined,
};

type Answer = (request: HttpRequestV1) => Promise<HttpResponseV1>;

const reply =
  (status: number, headers: Record<string, string> = {}, body = "{}") =>
  (): Promise<HttpResponseV1> =>
    Promise.resolve({ status, headers: new Headers(headers), bodyText: body });

/** GitHub failures a later run can outlast. */
const TRANSIENT: readonly (readonly [string, Answer])[] = [
  ["a thrown request", () => Promise.reject(new TypeError("connection reset"))],
  ["502", reply(502)],
  ["503", reply(503)],
  ["429", reply(429)],
  ["403 with retry-after", reply(403, { "retry-after": "60" })],
  ["403 with no quota left", reply(403, { "x-ratelimit-remaining": "0" })],
  [
    "403 secondary rate limit",
    reply(403, {}, '{"message":"You have exceeded a secondary rate limit."}'),
  ],
];

/** Credential or access failures no later run outlasts by itself. */
const NOT_TRANSIENT: readonly (readonly [string, Answer])[] = [
  ["401", reply(401, {}, '{"message":"Bad credentials"}')],
  ["404", reply(404, {}, '{"message":"Not Found"}')],
  [
    "403 without rate-limit evidence",
    reply(403, {}, '{"message":"Resource not accessible by integration"}'),
  ],
  ["403 with quota left", reply(403, { "x-ratelimit-remaining": "17" })],
];

/**
 * Every listed target unreadable: the named Sentinel target fails `branch`
 * at its default-branch read, and the generic prospector target, whose
 * default branch reads, fails `facts` at the head read of its tree facts.
 * Every other request reaches the rig's own transport.
 */
function unreadable(
  http: HttpTransportV1,
  branch: Answer,
  facts: Answer = branch,
): HttpTransportV1 {
  return (request) => {
    const path = new URL(request.url).pathname;
    if (request.method !== "GET") return http(request);
    if (path === "/repos/ubiquity-sentinel/sentinel") return branch(request);
    if (path === "/repos/ubiquity/prospector") {
      return reply(200, {}, '{"default_branch":"main"}')();
    }
    if (path === "/repos/ubiquity/prospector/commits/main") {
      return facts(request);
    }
    return http(request);
  };
}

const TARGET_READS = [
  "GET /repos/ubiquity-sentinel/sentinel",
  "GET /repos/ubiquity/prospector",
  "GET /repos/ubiquity/prospector/commits/main",
];

const UNAVAILABLE_503 = reply(503);

const LISTED = JSON.stringify([
  "ubiquity-sentinel/sentinel",
  "ubiquity/prospector",
]);

const NO_MODEL = {
  modelId: "synthetic-model",
  runModel: () => {
    throw new Error("a deferred pass never starts a model");
  },
};

async function quietly<T>(
  body: () => Promise<T>,
): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    return { value: await body(), lines };
  } finally {
    console.log = original;
  }
}

/** Records every request; the rig's own transport answers it. */
function observed(http: HttpTransportV1) {
  const requests: string[] = [];
  const transport: HttpTransportV1 = (request) => {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return http(request);
  };
  return { requests, http: transport };
}

function deferralLines(lines: readonly string[]) {
  return scanStepLines(lines.join("\n")).filter((line) =>
    line.kind === TARGETS_DEFERRAL_KIND
  );
}

const EXPECTED_LINE = {
  kind: TARGETS_DEFERRAL_KIND,
  reasonCode: "targets_unavailable",
  listed: 2,
  branchUnavailable: 1,
  factsUnavailable: 1,
  transient: 2,
};

Deno.test("targets deferral: an ordinary serial pass with every target read transiently unavailable defers healthy and writes nothing", async () => {
  const r = await rig();
  try {
    await ensureRepairStateSeed(r.store, r.clock);
    const deps = await r.job("deferral-serial", "repair");
    await Deno.writeTextFile(`${deps.workDir}/sentinel.targets.json`, LISTED);
    const repairBefore = await r.store.readRepair();
    const releaseBefore = await r.release.readRelease();
    const http = observed(unreadable(deps.http, UNAVAILABLE_503, reply(429)));
    let cycles = 0;
    let probes = 0;
    const { value: result, lines } = await quietly(() =>
      runActionsRepairHost({
        ...deps,
        ...PRODUCTION,
        state: r.store,
        http: http.http,
        model: NO_MODEL,
        preflight: () => {
          probes++;
          return Promise.resolve();
        },
        runTargetCycles: () => {
          cycles++;
          throw new Error("a deferred pass runs no target cycle");
        },
      })
    );
    assert.deepEqual(result.outcome, {
      status: "idle",
      detail: STATIC_TARGETS_DEFERRED,
    });
    assert.equal(result.startupReady, true);
    assert.equal(probes, 1, "the actual startup probe still owns health");
    assert.equal(cycles, 0);
    assert.deepEqual(result.ciApproval, {
      approved: 0,
      pending: 0,
      unavailable: 0,
    });
    // The launcher reads exactly one healthy child record from this stdout
    // and re-emits the one text-free deferral line with its counts.
    const stdout = lines.join("\n");
    const scan = scanChildStatusRecords(stdout);
    assert.equal(scan.kind, "one");
    assert.equal(
      scan.kind === "one" &&
        parseChildStatus(scan.value, result.execution)?.healthy,
      true,
    );
    assert.deepEqual(deferralLines(lines), [EXPECTED_LINE]);
    const raw = lines.find((line) => line.includes(TARGETS_DEFERRAL_KIND));
    assert.ok(raw !== undefined);
    for (const text of ["prospector", "sentinel/", "status", "main"]) {
      assert.equal(raw.includes(text), false, `${text} in ${raw}`);
    }
    // No state write and no GitHub request beyond the target reads: nothing
    // after the target load ran.
    assert.deepEqual(await r.store.readRepair(), repairBefore);
    assert.deepEqual(await r.release.readRelease(), releaseBefore);
    assert.deepEqual(http.requests, TARGET_READS);
    assert(
      [...r.github.values()].every((port) => port.calls.length === 0),
      "no target port composed",
    );
  } finally {
    await r.cleanup();
  }
});

Deno.test("targets deferral: every failure that looks transient defers the serial pass", async () => {
  const r = await rig();
  try {
    await ensureRepairStateSeed(r.store, r.clock);
    for (const [label, answer] of TRANSIENT) {
      const deps = await r.job(`deferral-transient-${label}`, "repair");
      await Deno.writeTextFile(`${deps.workDir}/sentinel.targets.json`, LISTED);
      const { value: result, lines } = await quietly(() =>
        runActionsRepairHost({
          ...deps,
          ...PRODUCTION,
          state: r.store,
          http: unreadable(deps.http, answer),
          model: NO_MODEL,
        })
      );
      assert.deepEqual(result.outcome, {
        status: "idle",
        detail: STATIC_TARGETS_DEFERRED,
      }, label);
      assert.deepEqual(deferralLines(lines), [EXPECTED_LINE], label);
    }
  } finally {
    await r.cleanup();
  }
});

Deno.test("targets deferral: a failure that does not look transient fails red and still says why", async () => {
  const r = await rig();
  try {
    await ensureRepairStateSeed(r.store, r.clock);
    const repairBefore = await r.store.readRepair();
    const releaseBefore = await r.release.readRelease();
    const cases: (readonly [string, Answer, Answer, number])[] = [
      ...NOT_TRANSIENT.map(([label, answer]) =>
        [label, answer, answer, 0] as const
      ),
      // One credential failure keeps the pass red beside a transient one.
      ["401 beside a 503", reply(401), UNAVAILABLE_503, 1],
      ["503 beside a 404", UNAVAILABLE_503, reply(404), 1],
      // A default branch that answers but proves nothing is not transient.
      [
        "an unusable 200 beside a 503",
        reply(200, {}, '{"default_branch":""}'),
        UNAVAILABLE_503,
        1,
      ],
    ];
    for (const [label, branch, facts, transient] of cases) {
      // Every job's entrypoint for a credential failure, the serial pass for
      // the rest.
      const jobs = label === "401"
        ? ["repair", "matrix_plan", "repair_cell"] as const
        : ["repair"] as const;
      for (const job of jobs) {
        const deps = await r.job(`deferral-red-${job}-${label}`, job);
        await Deno.writeTextFile(
          `${deps.workDir}/sentinel.targets.json`,
          LISTED,
        );
        const host = {
          ...deps,
          ...PRODUCTION,
          state: r.store,
          http: unreadable(deps.http, branch, facts),
          model: NO_MODEL,
        };
        // Each job's own entrypoint: serial pass, planner, repository cell.
        const { lines } = await quietly(() =>
          assert.rejects(
            () =>
              job === "matrix_plan"
                ? runActionsMatrixHost(host)
                : job === "repair_cell"
                ? runRepairCellHost({
                  ...host,
                  carrier: { planDigest: D, repairPlanDigest: D, cellId: CELL },
                })
                : runActionsRepairHost({
                  ...host,
                  runTargetCycles: () => {
                    throw new Error("no target cycle");
                  },
                }),
            new Error(STATIC_TARGETS_UNAVAILABLE),
            `${job} ${label}`,
          )
        );
        // No plan, refusal or marker: the red job is the whole answer.
        await assert.rejects(
          () => Deno.stat(`${deps.workDir}/../.sentinel-repair/result.json`),
          Deno.errors.NotFound,
        );
        assert.deepEqual(
          deferralLines(lines),
          [{ ...EXPECTED_LINE, transient }],
          `${job} ${label}`,
        );
        assert.equal(scanChildStatusRecords(lines.join("\n")).kind, "none");
      }
    }
    assert.deepEqual(await r.store.readRepair(), repairBefore);
    assert.deepEqual(await r.release.readRelease(), releaseBefore);
  } finally {
    await r.cleanup();
  }
});

Deno.test("targets deferral: a setting that lists no repository still refuses as an empty setting", async () => {
  const r = await rig();
  try {
    await ensureRepairStateSeed(r.store, r.clock);
    for (const setting of ["[]", "{}", null]) {
      const deps = await r.job(`deferral-empty-${setting}`, "repair");
      const path = `${deps.workDir}/sentinel.targets.json`;
      if (setting === null) await Deno.remove(path);
      else await Deno.writeTextFile(path, setting);
      const before = await r.store.readRepair();
      const { lines } = await quietly(() =>
        assert.rejects(
          () =>
            runActionsRepairHost({
              ...deps,
              ...PRODUCTION,
              state: r.store,
              model: NO_MODEL,
            }),
          new Error(STATIC_TARGETS_EMPTY),
        )
      );
      assert.deepEqual(deferralLines(lines), [], `setting ${setting}`);
      assert.deepEqual(await r.store.readRepair(), before);
    }
  } finally {
    await r.cleanup();
  }
});

for (const purpose of ["bootstrap", "rollback"] as const) {
  Deno.test(`targets deferral: a ${purpose} execution with every target read unavailable fails as unavailable`, async () => {
    const r = await rig(true, purpose);
    try {
      await ensureRepairStateSeed(r.store, r.clock);
      const deps = await r.job(`deferral-${purpose}`, "repair");
      await Deno.writeTextFile(`${deps.workDir}/sentinel.targets.json`, LISTED);
      const repairBefore = await r.store.readRepair();
      const releaseBefore = await r.release.readRelease();
      let cycles = 0;
      const { lines } = await quietly(() =>
        assert.rejects(
          () =>
            runActionsRepairHost({
              ...deps,
              ...PRODUCTION,
              state: r.store,
              http: unreadable(deps.http, UNAVAILABLE_503),
              model: NO_MODEL,
              runTargetCycles: () => {
                cycles++;
                throw new Error("no target cycle");
              },
            }),
          new Error(STATIC_TARGETS_UNAVAILABLE),
        )
      );
      // Unavailable evidence never passes an install or rollback gate, even
      // when it looks transient, but the job log still names why.
      assert.equal(cycles, 0);
      assert.deepEqual(deferralLines(lines), [EXPECTED_LINE]);
      assert.equal(scanChildStatusRecords(lines.join("\n")).kind, "none");
      assert.deepEqual(await r.store.readRepair(), repairBefore);
      assert.deepEqual(await r.release.readRelease(), releaseBefore);
    } finally {
      await r.cleanup();
    }
  });
}

Deno.test("targets deferral: the matrix planner publishes an empty zero-grant plan that says why", async () => {
  const r = await rig();
  try {
    await ensureRepairStateSeed(r.store, r.clock);
    const deps = await r.job("deferral-plan", "matrix_plan");
    await Deno.writeTextFile(`${deps.workDir}/sentinel.targets.json`, LISTED);
    const before = await r.store.readRepair();
    const { value: result, lines } = await quietly(() =>
      runActionsMatrixHost({
        ...deps,
        ...PRODUCTION,
        state: r.store,
        http: unreadable(deps.http, UNAVAILABLE_503),
        model: NO_MODEL,
      })
    );
    assert("plan" in result);
    assert.deepEqual(result.plan.cells, []);
    assert.equal(result.prepared, 0);
    const output = await Deno.readTextFile(deps.env.GITHUB_OUTPUT);
    for (
      const expected of [
        'matrix={"include":[]}\n',
        "hasCells=false\n",
        "hasRepairCells=false\n",
        `planDigest=${result.planDigest}\n`,
      ]
    ) assert(output.includes(expected), `${expected} in ${output}`);
    const parsed = lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    assert.equal(
      parsed.filter((line) => line.kind === "sentinel_matrix_plan").length,
      1,
    );
    const diagnostic = parsed.filter((line) =>
      line.kind === "sentinel_matrix_plan_diagnostic"
    );
    assert.equal(diagnostic.length, 1, JSON.stringify(parsed));
    assert.equal(diagnostic[0].cause, "targets_unavailable");
    // The launcher's own re-parse accepts the cause it re-emits.
    assert.equal(
      scanPlanDiagnostic(lines.join("\n"), { id: result.plan.waveId })?.cause,
      "targets_unavailable",
    );
    assert.deepEqual(deferralLines(lines), [EXPECTED_LINE]);
    assert.deepEqual(await r.store.readRepair(), before);
    assert(
      [...r.github.values()].every((port) => port.calls.length === 0),
      "no discovery or source admission",
    );
  } finally {
    await r.cleanup();
  }
});

Deno.test("targets deferral: an admitted matrix cell fails as unavailable and writes no result", async () => {
  const r = await rig();
  try {
    await ensureRepairStateSeed(r.store, r.clock);
    const deps = await r.job("deferral-cell", "matrix_cell");
    await Deno.writeTextFile(`${deps.workDir}/sentinel.targets.json`, LISTED);
    const before = await r.store.readRepair();
    await quietly(() =>
      assert.rejects(
        () =>
          runActionsRepairHost({
            ...deps,
            ...PRODUCTION,
            job: "matrix_cell",
            state: r.store,
            http: unreadable(deps.http, UNAVAILABLE_503),
            model: NO_MODEL,
          }),
        new Error(STATIC_TARGETS_UNAVAILABLE),
      )
    );
    assert.deepEqual(await r.store.readRepair(), before);
    await assert.rejects(
      () => Deno.stat(`${deps.workDir}/../.sentinel-matrix`),
      Deno.errors.NotFound,
    );
  } finally {
    await r.cleanup();
  }
});

for (const startup of ["ready", "unavailable"] as const) {
  Deno.test(`targets deferral: a repository cell writes its refusal and marker (startup ${startup})`, async () => {
    const r = await rig();
    try {
      await ensureRepairStateSeed(r.store, r.clock);
      const deps = await r.job(
        `deferral-repair-cell-${startup}`,
        "repair_cell",
      );
      await Deno.writeTextFile(`${deps.workDir}/sentinel.targets.json`, LISTED);
      const before = await r.store.readRepair();
      const { value, lines } = await quietly(() =>
        runRepairCellHost({
          ...deps,
          ...PRODUCTION,
          state: r.store,
          http: unreadable(deps.http, UNAVAILABLE_503),
          model: NO_MODEL,
          preflight: () =>
            startup === "ready"
              ? Promise.resolve()
              : Promise.reject(new Error("no model sandbox")),
          // No fan-out plan was downloaded: `plan_unavailable`, exactly as
          // the cell's own pass would refuse.
          carrier: { planDigest: D, repairPlanDigest: D, cellId: CELL },
        })
      );
      if (startup === "ready") {
        assert(typeof value === "object");
        assert.deepEqual(value.outcome, {
          status: "idle",
          detail: STATIC_TARGETS_DEFERRED,
        });
      } else assert.equal(value, REPAIR_CELL_SETTLED_WITHOUT_STARTUP);
      const result = JSON.parse(
        await Deno.readTextFile(
          `${deps.workDir}/../.sentinel-repair/result.json`,
        ),
      );
      assert.deepEqual(parseRepairCellRefusalV1(result), {
        version: "v1",
        kind: "repair_cell_refusal",
        cellId: CELL,
        reason: "plan_unavailable",
      });
      const markers = lines.flatMap((line) => {
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          return value.kind === "sentinel_repair_cell" ? [value] : [];
        } catch {
          return [];
        }
      });
      assert.equal(markers.length, 1);
      assert.equal(markers[0].cellId, CELL);
      assert.equal(markers[0].transitions, 0);
      assert.deepEqual(await r.store.readRepair(), before);
    } finally {
      await r.cleanup();
    }
  });
}

Deno.test("targets deferral: the line's listed bound is the committed setting's bound", () => {
  assert.equal(MAX_TARGETS_DEFERRAL_LISTED, TARGETS_MAX);
});
