/**
 * The `commit` step and the trusted run's identity (docs/backup-ci-spec.md
 * §9.1, §9.5): `pass.json` must hash to the reported digest and bind the
 * run; the legs ref is fast-forwarded only to a descendant (a refused or
 * diverged ref records `legs_ref_behind` and dispatches nothing); one store
 * commit holds results, refusals and `dispatched` entries with their tree
 * artifacts; a unit without a tree artifact is `dispatch_failed`; each leg
 * is dispatched at `sentinel-backup-legs` with string inputs. The run's own
 * identity must be the backup workflow at sentinel-supervisor. Synthetic.
 */
import assert from "node:assert/strict";
import {
  backupCiBytesDigest,
  type BackupCiCommitFileV1,
  backupCiCommitPath,
  backupCiUnitDigest,
  parseBackupCiCommitFile,
} from "../../src/contracts/backup-ci.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  advanceBackupCiLegs,
  commitBackupCiPass,
  createBackupCiLegDispatcher,
} from "../../ops/backup-ci-dispatch.ts";
import {
  backupCiIdentity,
  parseBackupCiCalibrationCommits,
} from "../../ops/backup-ci-main.ts";
import type { BackupCiPassFileV1 } from "../../ops/backup-ci-pass.ts";
import {
  type BackupCiApiV1,
  createBackupCiApi,
} from "../../ops/backup-ci-plan-reads.ts";
import { wakeBackupCiReceipt } from "../../src/host/backup-ci-completion.ts";
import type { BackupCiStoreView } from "../../ops/backup-ci-store-writer.ts";
import {
  H,
  key,
  LAUNCHER,
  REPOSITORY,
  result,
  T0,
  unit,
} from "../github/backup-ci-fixtures.ts";

const REPO = "ubiquity-sentinel/sentinel";
const OLD = "d".repeat(40);

function api(state: {
  legs: string | null;
  compare?: { status: string; behind_by: number };
  patch?: number;
  dispatch?: number;
}) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const fake: BackupCiApiV1 = {
    get(path) {
      if (path === `/repos/${REPO}/git/ref/heads/sentinel-backup-legs`) {
        return Promise.resolve(
          state.legs === null ? null : { object: { sha: state.legs } },
        );
      }
      if (path.startsWith(`/repos/${REPO}/compare/`)) {
        return Promise.resolve(state.compare ?? null);
      }
      return Promise.resolve(null);
    },
    send(method, path, body) {
      sent.push({ method, path, body });
      if (path.endsWith("/dispatches")) {
        return Promise.resolve({ status: state.dispatch ?? 204, body: null });
      }
      return Promise.resolve({ status: state.patch ?? 200, body: null });
    },
    redirected: () => Promise.resolve(null),
  };
  return { api: fake, sent };
}

function passFile(units = 1): BackupCiPassFileV1 {
  const u = unit();
  return {
    version: 1,
    kind: "sentinel_backup_ci_pass",
    runId: 9001,
    launcherSha: LAUNCHER,
    mode: "on",
    runnerId: u.plan.runnerId,
    createdAt: T0,
    files: [{
      repository: REPOSITORY,
      commit: H,
      coverage: [],
      results: [result(key({ checkName: "lint" }))],
      noEvidence: [],
    }],
    comparisons: [],
    units: units === 0 ? [] : [{
      slot: 0,
      repository: REPOSITORY,
      unit: u,
      unitDigest: backupCiUnitDigest(u),
      treeSha256: "a".repeat(64),
    }],
  };
}

async function commit(
  pass: BackupCiPassFileV1,
  state: Parameters<typeof api>[0],
  over: {
    digest?: string;
    trees?: (string | undefined)[];
    views?: (BackupCiCommitFileV1 | null)[];
    storeOutcome?: "committed" | "unchanged" | "failed";
    missingSelfAuthority?: boolean;
  } = {},
) {
  const bytes = new TextEncoder().encode(canonicalStringify(pass));
  const { api: fake, sent } = api(state);
  const written: Map<string, unknown>[] = [];
  const legSent: { method: string; path: string; body: unknown }[] = [];
  const log: string[] = [];
  const out = await commitBackupCiPass({
    passBytes: bytes,
    expectedDigest: over.digest ?? backupCiBytesDigest(bytes),
    trees: over.trees ?? ["7001", undefined],
    githubSha: LAUNCHER,
    runId: 9001,
    now: () => T0 + 1000,
    api: fake,
    legDispatcher: over.missingSelfAuthority ? null : {
      dispatch(body) {
        assert(written.length > 0, "durable store admission precedes App POST");
        legSent.push({
          method: "POST",
          path: `/repos/${REPO}/actions/workflows/backup-ci-leg.yml/dispatches`,
          body,
        });
        return Promise.resolve((state.dispatch ?? 204) === 204);
      },
    },
    repository: REPO,
    async writeStore(mutate) {
      for (const existing of over.views ?? [null]) {
        const view = {
          read: () => Promise.resolve(existing),
        } as unknown as BackupCiStoreView;
        written.push(await mutate(view));
      }
      if (over.storeOutcome === "unchanged") {
        return { kind: "unchanged", tip: null };
      }
      if (over.storeOutcome === "failed") {
        return { kind: "failed", detail: "CAS conflict" };
      }
      return {
        kind: "committed",
        commit: "1".repeat(40) as never,
        parent: null,
        attempts: 1,
      };
    },
    log: (l) => log.push(l),
  });
  const path = backupCiCommitPath("ubiquity", "passport.ubq.fi", H);
  const file = written[0]?.get(path) as BackupCiCommitFileV1 | undefined;
  return {
    out,
    sent: [...sent, ...legSent],
    nativeSent: sent,
    legSent,
    written,
    file: file === undefined ? undefined : parseBackupCiCommitFile(file),
    log,
  };
}

Deno.test("one store commit, then one leg dispatch with string inputs", async () => {
  const { out, sent, file, nativeSent, legSent } = await commit(passFile(), {
    legs: LAUNCHER,
  });
  assert.equal(out.code, 0);
  assert.equal(out.counts.dispatched, 1);
  assert.equal(nativeSent.filter((s) => s.method === "POST").length, 0);
  assert.equal(legSent.length, 1);
  assert.deepEqual(
    file?.entries.map((e) => [e.state, e.key.checkName]).sort(),
    [
      ["dispatched", "deno"],
      ["result", "lint"],
    ],
  );
  const d = file!.entries.find((e) => e.state === "dispatched");
  assert(d?.state === "dispatched");
  assert.deepEqual(d.tree, { artifactId: 7001, sha256: "a".repeat(64) });
  assert.equal(d.dispatchedAt, T0 + 1000);
  const dispatch = sent.find((s) => s.path.endsWith("/dispatches"))!;
  assert.equal(
    dispatch.path,
    `/repos/${REPO}/actions/workflows/backup-ci-leg.yml/dispatches`,
  );
  const u = unit();
  assert.deepEqual(dispatch.body, {
    ref: "sentinel-backup-legs",
    inputs: {
      unit: u.unitId,
      unit_digest: backupCiUnitDigest(u),
      plan_run: "9001",
      tree_artifact: "7001",
      tree_sha256: "a".repeat(64),
      runs_on: "ubuntu-latest",
      job_minutes: "70",
    },
  });
  assert(
    !sent.some((s) => s.method === "PATCH"),
    "an equal legs ref is not moved",
  );
});

Deno.test("the App capability sends only the fixed leg POST with the App header", async () => {
  const requests: {
    url: string;
    method: string;
    auth: string | null;
    body: unknown;
  }[] = [];
  const dispatcher = createBackupCiLegDispatcher("synthetic-self-app-token", (
    input,
    init,
  ) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      auth: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)),
    });
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  assert(dispatcher !== null);
  assert.deepEqual(Object.keys(dispatcher), ["dispatch"]);
  assert.equal(await dispatcher.dispatch({ ref: "development" }), false);
  assert.equal(requests.length, 0);
  const body = {
    ref: "sentinel-backup-legs",
    inputs: { unit: "a".repeat(24) },
  };
  assert.equal(await dispatcher.dispatch(body), true);
  assert.deepEqual(requests, [{
    url:
      "https://api.github.com/repos/ubiquity-sentinel/sentinel/actions/workflows/backup-ci-leg.yml/dispatches",
    method: "POST",
    auth: "Bearer synthetic-self-app-token",
    body,
  }]);
});

Deno.test("missing App authority refuses before legs-ref movement, store admission or native fallback", async () => {
  assert.equal(createBackupCiLegDispatcher(""), null);
  assert.equal(createBackupCiLegDispatcher("   "), null);
  const refused = await commit(passFile(), { legs: OLD }, {
    missingSelfAuthority: true,
  });
  assert.equal(refused.out.code, 1);
  assert.equal(refused.nativeSent.length, 0);
  assert.equal(refused.legSent.length, 0);
  assert.equal(refused.written.length, 0);
  assert(refused.log.includes("backup-ci:commit:self_dispatch_unavailable"));
  const ingest = await commit(passFile(0), { legs: LAUNCHER }, {
    missingSelfAuthority: true,
  });
  assert.equal(ingest.out.code, 0);
  assert.equal(ingest.out.counts.receipt_advanced, 1);
  assert.equal(ingest.legSent.length, 0);
});

Deno.test("actual native and App API headers stay separated through commit and receipt wake", async () => {
  const calls: { path: string; method: string; auth: string | null }[] = [];
  let committed = false;
  const fetcher: typeof fetch = (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    calls.push({
      path,
      method,
      auth: new Headers(init?.headers).get("authorization"),
    });
    if (path.endsWith("/backup-ci-leg.yml/dispatches")) {
      assert(committed, "App POST follows the successful CAS");
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (method === "POST") {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(
      Response.json(
        path.endsWith("/sentinel-backup-legs")
          ? { object: { sha: LAUNCHER } }
          : { full_name: REPO, default_branch: "development" },
      ),
    );
  };
  const native = createBackupCiApi("synthetic-native-token", fetcher);
  const pass = passFile();
  const bytes = new TextEncoder().encode(canonicalStringify(pass));
  const out = await commitBackupCiPass({
    passBytes: bytes,
    expectedDigest: backupCiBytesDigest(bytes),
    trees: ["7001"],
    githubSha: LAUNCHER,
    runId: 9001,
    now: () => T0 + 1000,
    api: native,
    legDispatcher: createBackupCiLegDispatcher(
      "synthetic-self-app-token",
      fetcher,
    ),
    repository: REPO,
    async writeStore(mutate) {
      await mutate(
        { read: () => Promise.resolve(null) } as unknown as BackupCiStoreView,
      );
      committed = true;
      return { kind: "committed", commit: H, parent: null, attempts: 1 };
    },
    log: () => {},
  });
  assert.equal(out.code, 0);
  assert.equal((await wakeBackupCiReceipt(out, native)).decision, "requested");
  assert.equal(
    calls.filter((x) => x.auth === "Bearer synthetic-self-app-token").length,
    1,
  );
  for (const call of calls) {
    assert.equal(
      call.auth,
      call.path.endsWith("/backup-ci-leg.yml/dispatches")
        ? "Bearer synthetic-self-app-token"
        : "Bearer synthetic-native-token",
    );
  }
});

Deno.test("receipt wake count requires newly accepted evidence on the committed CAS view", async () => {
  const pass = passFile(0);
  const fresh = await commit(pass, { legs: LAUNCHER });
  assert.equal(fresh.out.counts.receipt_advanced, 1);
  assert.equal(
    (await commit(pass, { legs: LAUNCHER }, { views: [fresh.file!] })).out
      .counts.receipt_advanced,
    0,
  );
  assert.equal(
    (await commit(pass, { legs: LAUNCHER }, { views: [null, fresh.file!] })).out
      .counts.receipt_advanced,
    0,
    "CAS retry uses the newest view",
  );
  for (const storeOutcome of ["unchanged", "failed"] as const) {
    assert.equal(
      (await commit(pass, { legs: LAUNCHER }, { storeOutcome })).out.counts
        .receipt_advanced,
      0,
    );
  }
  const calibration = structuredClone(pass);
  calibration.files[0].results[0].purpose = "calibration";
  assert.equal(
    (await commit(calibration, { legs: LAUNCHER })).out.counts.receipt_advanced,
    0,
  );
  const planning = passFile();
  planning.files = [];
  assert.equal(
    (await commit(planning, { legs: LAUNCHER })).out.counts.receipt_advanced,
    0,
  );
  const observationOnly = passFile(0);
  observationOnly.files[0].results = [];
  const observed = await commit(observationOnly, { legs: LAUNCHER });
  assert.equal(observed.out.code, 0);
  assert.equal(observed.file!.entries.length, 0);
  assert.equal(observed.file!.workflows.length, 0);
  assert.equal(
    observed.out.counts.receipt_advanced,
    0,
    "scan age bookkeeping never wakes reconciliation",
  );
  const conflict = structuredClone(pass);
  conflict.files[0].results[0].resultDigest = "9".repeat(64);
  const refused = await commit(conflict, { legs: LAUNCHER }, {
    views: [fresh.file!],
  });
  assert.equal(
    refused.out.counts.receipt_advanced,
    0,
    "a refused conflicting result is no new evidence",
  );
});

Deno.test("a pass digest or binding mismatch writes and dispatches nothing", async () => {
  const bad = await commit(passFile(), { legs: LAUNCHER }, {
    digest: "0".repeat(64),
  });
  assert.equal(bad.out.code, 1);
  assert.equal(bad.file, undefined);
  assert.equal(bad.sent.length, 0);
  const other = await commit({ ...passFile(), runId: 1 }, { legs: LAUNCHER });
  assert.equal(other.out.code, 1);
  assert.equal(other.sent.length, 0);
});

Deno.test("the legs ref moves only forward; a refusal records legs_ref_behind", async () => {
  const forward = await commit(passFile(), {
    legs: OLD,
    compare: { status: "ahead", behind_by: 0 },
  });
  const patch = forward.sent.find((s) => s.method === "PATCH")!;
  assert.equal(
    patch.path,
    `/repos/${REPO}/git/refs/heads/sentinel-backup-legs`,
  );
  assert.deepEqual(patch.body, { sha: LAUNCHER, force: false });
  assert.equal(forward.out.counts.dispatched, 1);
  for (
    const state of [
      { legs: OLD, compare: { status: "diverged", behind_by: 2 } },
      { legs: OLD, compare: { status: "ahead", behind_by: 0 }, patch: 422 },
      { legs: null },
    ]
  ) {
    const behind = await commit(passFile(), state);
    assert.equal(behind.out.code, 0);
    assert(!behind.sent.some((s) => s.path.endsWith("/dispatches")));
    assert.equal(behind.out.counts.legs_ref_behind, 1);
    const entry = behind.file!.entries.find((e) => e.key.checkName === "deno");
    assert(
      entry?.state === "no_evidence" && entry.reason === "legs_ref_behind" &&
        entry.legRuns === 0,
    );
    assert(behind.log.includes("backup-ci:legs_ref_needs_manual_advance"));
  }
  assert.equal(
    await advanceBackupCiLegs(api({ legs: LAUNCHER }).api, REPO, LAUNCHER),
    true,
  );
});

Deno.test("a unit whose tree upload failed is dispatch_failed", async () => {
  const { out, sent, file } = await commit(passFile(), { legs: LAUNCHER }, {
    trees: [undefined, undefined],
  });
  assert.equal(out.counts.dispatch_failed, 1);
  assert(!sent.some((s) => s.path.endsWith("/dispatches")));
  const entry = file!.entries.find((e) => e.key.checkName === "deno");
  assert(entry?.state === "no_evidence" && entry.reason === "dispatch_failed");
});

Deno.test("the trusted run's identity must be the backup workflow at sentinel-supervisor", async () => {
  const env: Record<string, string> = {
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REPOSITORY: REPO,
    GITHUB_REF: "refs/heads/sentinel-supervisor",
    GITHUB_SHA: LAUNCHER,
  };
  const run = {
    path: ".github/workflows/backup-ci.yml",
    event: "workflow_dispatch",
    head_branch: "sentinel-supervisor",
    head_sha: LAUNCHER,
    repository: { full_name: REPO, id: 4242 },
    head_repository: { full_name: REPO },
  };
  const reader = (body: unknown): BackupCiApiV1 => ({
    get: (path) =>
      Promise.resolve(
        path === `/repos/${REPO}/actions/runs/123/attempts/1` ? body : null,
      ),
    send: () => Promise.resolve(null),
    redirected: () => Promise.resolve(null),
  });
  assert.equal(await backupCiIdentity(reader(run), (n) => env[n]), 4242);
  for (
    const change of [
      { path: ".github/workflows/supervisor.yml" },
      { event: "push" },
      { head_branch: "development" },
      { head_sha: "9".repeat(40) },
      { head_repository: { full_name: "fork/sentinel" } },
    ]
  ) {
    assert.equal(
      await backupCiIdentity(reader({ ...run, ...change }), (n) => env[n]),
      null,
      JSON.stringify(change),
    );
  }
  const changes: Record<string, string>[] = [
    { GITHUB_RUN_ATTEMPT: "2" },
    { GITHUB_REF: "refs/heads/development" },
    { GITHUB_REPOSITORY: "x/y" },
  ];
  for (const change of changes) {
    const changed: Record<string, string> = { ...env, ...change };
    assert.equal(await backupCiIdentity(reader(run), (n) => changed[n]), null);
  }
});

Deno.test("calibration commits are exact SHAs per target", async () => {
  const committed = parseBackupCiCalibrationCommits(
    JSON.parse(await Deno.readTextFile("ops/backup-ci-calibration.json")),
  );
  assert.deepEqual([...committed.keys()], ["ubiquity/passport.ubq.fi"]);
  const parsed = parseBackupCiCalibrationCommits({
    version: 1,
    targets: { "ubiquity/passport.ubq.fi": [H, H] },
  });
  assert.deepEqual(parsed.get("ubiquity/passport.ubq.fi"), [H]);
  for (
    const bad of [
      { version: 2, targets: {} },
      { version: 1, targets: { "ubiquity/passport.ubq.fi": ["main"] } },
      { version: 1, targets: {}, extra: 1 },
    ]
  ) assert.throws(() => parseBackupCiCalibrationCommits(bad));
});
