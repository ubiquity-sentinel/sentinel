/**
 * Pins the bridge to the owner-pinned driver's bridge-facing VpsJournalMetrics
 * interface (ubiquity-sentinel/sentinel#150, #161, #162). Each composition runs the
 * exact upstream metrics bytes of ai.ubq.fi 21e4a2a9 (pinned today), e50c298b
 * (ubiquity/ai.ubq.fi#1027) or 6c3afe42 (#1155 and #1162) through the real
 * loader, so a mismatch with the driver fails here instead of refusing every
 * VPS release at release time.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portOk, type StateReadView } from "../../src/contracts/ports.ts";
import { parseVpsReleaseRecordV1 } from "../../src/contracts/vps-release.ts";
import {
  composeTrustedVpsReleaseHost,
  type TrustedVpsReleaseHostOptionsV1,
} from "../../src/host/vps-release.ts";
import type { VpsQueryLimits } from "../../src/release/vps-metrics.ts";
import {
  DENO_DRIVER_SHA,
  denoDriverFiles,
  FAKE_DRIVER,
  installVpsDriverHook,
  JOINED_DRIVER_SHA,
  joinedDriverFiles,
  journalCoverage,
  journalRange,
  journalRows,
  testCipher,
  UPSTREAM_BLOBS,
  upstreamSource,
  WINDOW_DRIVER_SHA,
  windowDriverFiles,
  writeVpsDriverTree,
} from "../release/vps-driver-fixture.ts";

const fixture = parseVpsReleaseRecordV1(
  JSON.parse(
    await Deno.readTextFile(
      new URL("../fixtures/vps/release-requested-v1.json", import.meta.url),
    ),
  ),
);
const TARGET = "/home/codex/repos/ubiquity/ai.ubq.fi";
const STARTED = Math.ceil(fixture.createdAt / 30_000) * 30_000 + 60_000;
const candidate = fixture.driver.candidate;
const STATE_HEAD = "1".repeat(40) as GitSha;

/** One committed monitoring operation for the pinned driver. */
function monitoringState(driverSha256: string): StateReadView {
  const record = parseVpsReleaseRecordV1({
    ...fixture,
    phase: "monitoring",
    intent: { action: "promote", persistedAt: fixture.createdAt },
    driver: { ...fixture.driver, driverSha256 },
    monitoring: {
      ...fixture.monitoring,
      startedAt: STARTED,
      lastObservedAt: STARTED,
    },
  });
  const snapshot = {
    version: "v1" as const,
    kind: "release_state_snapshot" as const,
    stateHead: null,
    sequence: 3,
    updatedAt: STARTED,
    releases: [],
    hostedRuntimes: [],
    hostedReleases: [],
    githubCooldowns: [],
    vpsReleases: [record],
  };
  return {
    readRepair: () =>
      Promise.resolve(
        portOk({ status: "absent", currentHead: null, ref: null }),
      ),
    readRelease: () =>
      Promise.resolve(portOk({
        status: "found" as const,
        snapshot,
        head: STATE_HEAD,
        ref: "refs/heads/sentinel-state/release",
      })),
  };
}

function hostOptions(
  tree: Awaited<ReturnType<typeof writeVpsDriverTree>>,
  now: () => number,
): TrustedVpsReleaseHostOptionsV1 {
  return {
    clock: { now },
    stateRead: monitoringState(tree.moduleSha256),
    stateWrite: {
      writeRelease: () => {
        throw new Error("sampling must not write release state");
      },
    },
    repository: fixture.request.target.repository,
    environment: "production",
    controllerSha: fixture.driver.controllerSha as GitSha,
    targetRoot: TARGET,
    pinnedDriver: {
      releaseRoot: tree.releaseRoot,
      identity: tree.identity,
      moduleSha256: tree.moduleSha256,
    },
    policy: fixture.policy,
    logsLagMs: 0,
    timeoutKinds: [],
    upstreamWideKinds: [],
    verifySource: () => Promise.resolve(false),
    journalCoverage: () => Promise.reject(new Error("no coverage expected")),
    readInferenceProof: () => Promise.resolve(null),
    wait: () => Promise.resolve(),
    deadline: STARTED + 3_600_000,
  };
}
const requests = [0, 1, 2].map((index) => ({
  id: `candidate-${index}`,
  identity: candidate,
  acceptedAt: STARTED + 1_000 + index,
  terminalAt: STARTED + 2_000 + index,
  status: index === 2 ? 503 : 200,
}));
const window = {
  identity: candidate,
  windowStart: STARTED,
  windowEnd: STARTED + 30_000,
};

Deno.test("VPS driver interface: vendored upstream sources are the exact pinned Git blobs", async () => {
  for (const [revision, blobs] of Object.entries(UPSTREAM_BLOBS)) {
    for (const file of Object.keys(blobs)) {
      await upstreamSource(
        revision as keyof typeof UPSTREAM_BLOBS,
        file as Parameters<typeof upstreamSource>[1],
      );
    }
  }
  const storage = await upstreamSource(
    JOINED_DRIVER_SHA,
    "vps-metrics-storage.ts",
  );
  assert.match(
    storage,
    /export function createVpsJoinFileStorage\(\s*root: string,\s*policy: VpsMetricsRetention,\s*cipher: VpsJoinCipher,\s*current: \(scope: VpsMetricsScope\) => Promise<VpsMetricsScope>,\s*now = Date\.now\s*\): VpsJoinStorage/,
  );
  assert.match(
    await upstreamSource(JOINED_DRIVER_SHA, "deploy-lock.ts"),
    /from "bun:ffi"/,
  );
});

Deno.test("VPS driver interface: the pinned 21e4a2a9 window interface composes unchanged", async () => {
  const tree = await writeVpsDriverTree(
    WINDOW_DRIVER_SHA,
    await windowDriverFiles(),
  );
  const hook = installVpsDriverHook({ create: () => ({}) });
  try {
    const runs: [string, string[], string][] = [];
    const coverage: unknown[][] = [];
    const now = STARTED + 90_000;
    const options = hostOptions(tree, () => now);
    const composed = await composeTrustedVpsReleaseHost({
      ...options,
      journalCoverage: (...args: unknown[]) => {
        coverage.push(args);
        return Promise.resolve(
          journalCoverage(args[0] as number, args[1] as number),
        );
      },
      platform: {
        fetch,
        run: (program, args, cwd) => {
          runs.push([program, args, cwd]);
          const [start, end] = journalRange(args);
          return Promise.resolve(journalRows(requests, start, end));
        },
      },
    });
    assert.ok(composed.ok, "the currently pinned driver keeps composing");
    assert.equal(
      composed.value.metricsWork,
      undefined,
      "no joined tick contract",
    );
    const sample = await composed.value.port.sampleMetrics(window);
    assert.ok(sample.ok && sample.value.coverage === "complete");
    assert.equal(sample.value.requestCount, 3);
    assert.equal(sample.value.fiveXxCount, 1);
    assert.deepEqual(runs.map(([program, , cwd]) => [program, cwd]), [[
      "journalctl",
      TARGET,
    ]]);
    assert.deepEqual(journalRange(runs[0][1]), [
      STARTED - 30_000,
      STARTED + 60_000,
    ]);
    assert.deepEqual(coverage, [[STARTED - 30_000, STARTED + 60_000]]);
    assert.deepEqual(hook.evaluated, ["driver"]);
  } finally {
    await tree.cleanup();
  }
});

Deno.test("VPS driver interface: the #1027 joined interface gets all five options, a tick budget, exact windows and the bounded runner", async () => {
  const tree = await writeVpsDriverTree(
    JOINED_DRIVER_SHA,
    await joinedDriverFiles(),
  );
  const hook = installVpsDriverHook({ create: () => ({}) });
  try {
    const runs: [readonly string[], VpsQueryLimits, string][] = [];
    const coverage: unknown[][] = [];
    const now = STARTED + 90_000;
    const options = hostOptions(tree, () => now);
    const retention = {
      evidenceMaxAgeMs: 172_800_000,
      evidenceMaxBytes: 16_777_216,
    };
    const compose = () =>
      composeTrustedVpsReleaseHost({
        ...options,
        telemetry: { retention, cipher },
        journalCoverage: (...args: unknown[]) => {
          coverage.push(args);
          return Promise.resolve(
            journalCoverage(args[0] as number, args[1] as number),
          );
        },
        platform: {
          fetch,
          run: () => Promise.reject(new Error("no generic command expected")),
          journal: (args, limits, cwd) => {
            runs.push([args, limits, cwd]);
            const [start, end] = journalRange(args);
            return Promise.resolve(journalRows(requests, start, end));
          },
        },
      });
    const cipher = await testCipher();
    const untimed = await compose();
    assert.ok(untimed.ok, "the joined driver composes");
    const missingTick = await untimed.value.port.sampleMetrics(window);
    assert.ok(missingTick.ok && missingTick.value.coverage === "incomplete");
    assert.equal(runs.length, 0, "no journal work outside a begun tick");

    const composed = await compose();
    assert.ok(composed.ok);
    const work = composed.value.metricsWork;
    assert.ok(work, "the controller receives the tick contract");
    work.beginTick(now);
    const sample = await composed.value.port.sampleMetrics(window);
    assert.ok(sample.ok && sample.value.coverage === "complete");
    assert.equal(sample.value.requestCount, 3);
    assert.equal(sample.value.fiveXxCount, 1);
    assert.deepEqual(await work.progress(window), {
      state: "complete",
      reason: null,
    });
    assert.deepEqual(
      runs.map(([args, limits, cwd]) => [
        journalRange(args),
        limits,
        cwd,
      ]),
      [[
        [STARTED, STARTED + 30_000],
        { deadline: now + 20_000, maxBytes: 1_048_576, maxEntries: 8192 },
        TARGET,
      ]],
    );
    assert.deepEqual(coverage, [[STARTED, STARTED + 30_000, runs[0][1]]]);
    assert.deepEqual(hook.storageRoots, [TARGET, TARGET]);
    const sealed = hook.sealed.get(fixture.driver.operationId);
    assert.equal(
      sealed?.sequence,
      2,
      "one sealed checkpoint per operation, advanced by compare-and-swap",
    );
    assert.ok(
      !new TextDecoder().decode(sealed.bytes).includes("candidate-0"),
      "the join checkpoint is sealed",
    );

    const wide = await composed.value.port.sampleMetrics({
      ...window,
      windowEnd: STARTED + 60_000,
    });
    assert.equal(wide.ok, false, "only exact 30 s windows are sampled");
    const outside = await composed.value.port.sampleMetrics({
      ...window,
      windowStart: STARTED - 30_000,
      windowEnd: STARTED,
    });
    assert.ok(
      outside.ok && outside.value.coverage === "incomplete",
      "a candidate window before the monitoring scope is refused",
    );
  } finally {
    await tree.cleanup();
  }
});

Deno.test("VPS driver interface: a Bun-only driver or join storage graph is refused before evaluation", async (t) => {
  const deployLock = await upstreamSource(JOINED_DRIVER_SHA, "deploy-lock.ts");
  const journalStandIn =
    `export { acquireDeployLock } from "./deploy-lock.ts";\nexport function withVpsDeployLock(root, work) { return work(); }\n`;
  const cases: [
    string,
    string[],
    (files: Record<string, string>) => Promise<void>,
  ][] = [
    ["e50c298b driver shares the bun:ffi deploy lock", [], (files) => {
      files["ops/vps-release-driver.ts"] =
        `import { withVpsDeployLock } from "./vps-release-journal.ts";\nexport const lock = withVpsDeployLock;\n${FAKE_DRIVER}`;
      return Promise.resolve();
    }],
    ["e50c298b join file storage", ["driver"], async (files) => {
      files["ops/vps-metrics-storage.ts"] = await upstreamSource(
        JOINED_DRIVER_SHA,
        "vps-metrics-storage.ts",
      );
      files["ops/io.ts"] = "export const missing = () => false;\n";
    }],
  ];
  for (const [name, evaluated, edit] of cases) {
    await t.step(name, async () => {
      const files = {
        ...await joinedDriverFiles(),
        "ops/vps-release-journal.ts": journalStandIn,
        "ops/deploy-lock.ts": deployLock,
      };
      await edit(files);
      const tree = await writeVpsDriverTree(JOINED_DRIVER_SHA, files);
      const hook = installVpsDriverHook({ create: () => ({}) });
      try {
        const result = await composeTrustedVpsReleaseHost({
          ...hostOptions(tree, () => STARTED + 90_000),
          telemetry: {
            retention: { evidenceMaxAgeMs: 1_000, evidenceMaxBytes: 1_000 },
            cipher: await testCipher(),
          },
        });
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.equal(result.error.kind, "unavailable");
          assert.equal(
            result.error.detail,
            "trusted VPS driver needs a host that can load Bun-only modules",
          );
        }
        assert.equal(hook.storageRoots.length, 0, "no storage was created");
        assert.deepEqual(hook.evaluated, evaluated, "nothing Bun-only ran");
      } finally {
        await tree.cleanup();
      }
    });
  }
});

Deno.test("VPS driver interface: a mismatched interface or absent telemetry custody is unavailable", async (t) => {
  const mismatched =
    `export class VpsJournalMetrics { constructor(a, b, c, d, e, f) {} sample() {} }\nexport function createVpsJournalReader(run, root, coverage) { return { coverage }; }\nexport const runVpsJournalCommand = (args, limits, cwd) => Promise.resolve("");\n`;
  for (
    const [name, files, telemetry, message] of [
      [
        "joined constructor without the tick contract",
        { "ops/vps-release-metrics.ts": mismatched },
        true,
        "trusted VPS metrics capability is unavailable",
      ],
      [
        "joined driver without owner retention and cipher",
        {},
        false,
        "trusted VPS telemetry capabilities are unavailable",
      ],
    ] as const
  ) {
    await t.step(name, async () => {
      const tree = await writeVpsDriverTree(JOINED_DRIVER_SHA, {
        ...await joinedDriverFiles(),
        ...files,
      });
      installVpsDriverHook({ create: () => ({}) });
      try {
        const options = hostOptions(tree, () => STARTED + 90_000);
        const result = await composeTrustedVpsReleaseHost(
          telemetry
            ? {
              ...options,
              telemetry: {
                retention: { evidenceMaxAgeMs: 1_000, evidenceMaxBytes: 1_000 },
                cipher: await testCipher(),
              },
            }
            : options,
        );
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.detail, message);
      } finally {
        await tree.cleanup();
      }
    });
  }
});

Deno.test("VPS driver interface: 6c3afe42 pins the six-argument journal argv, checkpoint schema 2, the state-read bound and a Deno lock", async () => {
  const reader = await upstreamSource(DENO_DRIVER_SHA, "vps-journal-reader.ts");
  assert.match(
    reader,
    /`--until=@\$\{end \/ 1000\}`, "--output=json", "--all", "--no-pager"\], limits, root\)/,
  );
  assert.match(
    reader,
    /args\.length !== 6 \|\|[^;]*args\[3\] !== "--output=json" \|\|\s*args\[4\] !== "--all" \|\|\s*args\[5\] !== "--no-pager"\s*\)\s*throw new Error\("VPS journal command refused"\)/,
  );
  const types = await upstreamSource(DENO_DRIVER_SHA, "vps-metrics-types.ts");
  assert.match(types, /export type VpsJoinCheckpoint = \{\s*schema: 2;/);
  assert.match(types, /export const VPS_METRICS_STATE_READ_MS = 10_000;/);
  assert.match(
    await upstreamSource(DENO_DRIVER_SHA, "vps-metrics-join.ts"),
    /item\.schema !== 2 \|\|/,
  );
  const storage = await upstreamSource(
    DENO_DRIVER_SHA,
    "vps-metrics-storage.ts",
  );
  assert.match(
    storage,
    /export function createVpsJoinFileStorage\(\s*root: string,\s*policy: VpsMetricsRetention,\s*cipher: VpsJoinCipher,\s*current: \(scope: VpsMetricsScope\) => Promise<VpsMetricsScope>,\s*now = Date\.now,\s*stateReadMs = VPS_METRICS_STATE_READ_MS\s*\): VpsJoinStorage/,
  );
  assert.match(
    storage,
    /const cutoff = Date\.now\(\) - policy\.evidenceMaxAgeMs;/,
    "each save prunes the shared directory by the one owner retention",
  );
  const lock = await upstreamSource(DENO_DRIVER_SHA, "deploy-lock.ts");
  assert.doesNotMatch(lock, /["']bun:/);
  assert.match(lock, /while \(!file\.tryLockSync\(true\)\)/);
  assert.match(lock, /info\.uid !== deno\.uid\(\)/);

  const tree = await writeVpsDriverTree(
    DENO_DRIVER_SHA,
    await denoDriverFiles(),
  );
  try {
    const module = await import(
      new URL(`file://${tree.releaseRoot}/ops/vps-journal-reader.ts`).href
    ) as {
      runVpsJournalCommand(
        args: readonly string[],
        limits: VpsQueryLimits,
        cwd: string,
      ): Promise<string>;
    };
    const limits = { deadline: Date.now() + 1_000, maxBytes: 1, maxEntries: 1 };
    const range = ["--since=@1", "--until=@2"];
    for (
      const args of [
        ["--unit=ai-ubq-fi.service", ...range, "--output=json", "--no-pager"],
        [
          "--unit=ai-ubq-fi.service",
          ...range,
          "--output=json",
          "--no-pager",
          "--all",
        ],
      ]
    ) {
      assert.throws(
        () => module.runVpsJournalCommand(args, limits, TARGET),
        /VPS journal command refused/,
        `refused before any child: ${args.join(" ")}`,
      );
    }
  } finally {
    await tree.cleanup();
  }
});

Deno.test("VPS driver interface: the #1155/#1162 joined interface reads six-argument slices, keeps the 10 s state-read default and one retention", async () => {
  const tree = await writeVpsDriverTree(
    DENO_DRIVER_SHA,
    await denoDriverFiles(),
  );
  const created: Record<string, unknown>[] = [];
  const hook = installVpsDriverHook({
    create: (deps) => {
      created.push(deps);
      return {};
    },
  });
  try {
    const runs: (readonly string[])[] = [];
    const now = STARTED + 90_000;
    const retention = {
      evidenceMaxAgeMs: 172_800_000,
      evidenceMaxBytes: 16_777_216,
    };
    const cipher = await testCipher();
    const checkpoints: { schema?: unknown }[] = [];
    const composed = await composeTrustedVpsReleaseHost({
      ...hostOptions(tree, () => now),
      telemetry: {
        retention,
        cipher: {
          seal: (plain, data) => {
            checkpoints.push(JSON.parse(new TextDecoder().decode(plain)));
            return cipher.seal(plain, data);
          },
          open: cipher.open,
        },
      },
      journalCoverage: (start, end) =>
        Promise.resolve(journalCoverage(start, end)),
      platform: {
        fetch,
        run: () => Promise.reject(new Error("no generic command expected")),
        journal: (args) => {
          runs.push(args);
          const [start, end] = journalRange(args);
          return Promise.resolve(journalRows(requests, start, end));
        },
      },
    });
    assert.ok(composed.ok, "the Deno-loadable driver composes");
    const work = composed.value.metricsWork;
    assert.ok(work, "the controller receives the tick contract");
    work.beginTick(now);
    const sample = await composed.value.port.sampleMetrics(window);
    assert.ok(sample.ok && sample.value.coverage === "complete");
    assert.equal(sample.value.requestCount, 3);
    assert.equal(sample.value.fiveXxCount, 1);
    assert.deepEqual(runs, [[
      "--unit=ai-ubq-fi.service",
      `--since=@${STARTED / 1000}`,
      `--until=@${(STARTED + 30_000) / 1000}`,
      "--output=json",
      "--all",
      "--no-pager",
    ]]);
    assert.deepEqual(
      hook.storageCalls,
      [{ arity: 5, policy: retention }],
      "no stateReadMs override; storage prunes by the metrics' own retention",
    );
    assert.ok(checkpoints.length > 0);
    assert.ok(
      checkpoints.every((checkpoint) => checkpoint.schema === 2),
      "the sealed join checkpoint is schema 2",
    );
    assert.equal(created.length, 1);
    assert.equal(
      "preparePayload" in created[0],
      false,
      "without an owner preparation the driver keeps its own",
    );
  } finally {
    await tree.cleanup();
  }
});

Deno.test("VPS driver interface: an owner preparePayload reaches the pinned driver unchanged; a non-function is unavailable", async () => {
  const tree = await writeVpsDriverTree(
    DENO_DRIVER_SHA,
    await denoDriverFiles(),
  );
  const created: Record<string, unknown>[] = [];
  installVpsDriverHook({
    create: (deps) => {
      created.push(deps);
      return {};
    },
  });
  try {
    const telemetry = {
      retention: { evidenceMaxAgeMs: 1_000, evidenceMaxBytes: 1_000 },
      cipher: await testCipher(),
    };
    const preparePayload = () =>
      Promise.reject(new Error("no preparation expected"));
    const options = hostOptions(tree, () => STARTED + 90_000);
    const composed = await composeTrustedVpsReleaseHost({
      ...options,
      telemetry,
      preparePayload,
    });
    assert.ok(composed.ok);
    assert.equal(created.length, 1);
    assert.equal(created[0].preparePayload, preparePayload);
    const invalid = await composeTrustedVpsReleaseHost({
      ...options,
      telemetry,
      preparePayload: "bun" as unknown as typeof preparePayload,
    });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
      assert.equal(
        invalid.error.detail,
        "trusted VPS release capabilities are unavailable",
      );
    }
    assert.equal(created.length, 1, "no driver for an invalid preparation");
  } finally {
    await tree.cleanup();
  }
});
