/**
 * Owner-pinned ai.ubq.fi driver trees for the VPS bridge tests. The metrics
 * interface files are the exact upstream bytes (each checked against its Git
 * blob id); only the native driver, the join storage and the journal are
 * fakes, so a composition the real driver interface would reject fails here.
 */
import assert from "node:assert/strict";
import type { VpsIdentity } from "../../src/contracts/vps-release-wire.ts";

/** ai.ubq.fi 21e4a2a9: the driver revision the bridge verifies today. */
export const WINDOW_DRIVER_SHA = "21e4a2a94b3de80a67cb95159ff3249723efca8f";
/** ai.ubq.fi e50c298b: the merge of ubiquity/ai.ubq.fi#1027. */
export const JOINED_DRIVER_SHA = "e50c298ba7c4da720b432c782b7b1989c6f58e22";
/**
 * ai.ubq.fi 6c3afe42: the merge of ubiquity/ai.ubq.fi#1162, after #1155
 * (2de00a80). Deno-loadable driver graph, six-argument journalctl argv with
 * `--all`, join checkpoint schema 2 and the `stateReadMs` storage bound.
 */
export const DENO_DRIVER_SHA = "6c3afe42cc2399c9496da7eec47328b6ae3cbaf1";
/** `git rev-parse <revision>:ops/<file>` in ubiquity/ai.ubq.fi. */
export const UPSTREAM_BLOBS = {
  [WINDOW_DRIVER_SHA]: {
    "vps-release-contract.ts": "1bf9fc987fc69747ea1d53b279be45de8ff63c6d",
    "vps-release-metrics.ts": "b1e981e9111beef7fb50586257ed387927c497b2",
  },
  [JOINED_DRIVER_SHA]: {
    // Byte-identical at both revisions; vendored once.
    "vps-release-contract.ts": "1bf9fc987fc69747ea1d53b279be45de8ff63c6d",
    "vps-release-metrics.ts": "6e8d65cbb636003387d26e006b9810fd42786665",
    "vps-metrics-types.ts": "10dec017cab2fbf1e27f51527bab6110a992fe8b",
    "vps-metrics-join.ts": "b9014f40d4bc02ad0cb09a44347cbbd41cb672ff",
    "vps-journal-reader.ts": "0792c5a881136ee2a507a44e9e07646c52d77ec2",
    "vps-metrics-storage.ts": "55ed61ff77dd43455af8ce36fd45e9fdc5614fb7",
    "deploy-lock.ts": "046524bf4640d051c0bb9c13694b2e3bfd2e07da",
  },
  [DENO_DRIVER_SHA]: {
    "vps-release-contract.ts": "1bf9fc987fc69747ea1d53b279be45de8ff63c6d",
    "vps-release-metrics.ts": "d28dad35713769bd53ad8d7b53723661ff5582a8",
    "vps-metrics-types.ts": "6e6fc80116e1413e7becb50e3207f9c0a0551039",
    "vps-metrics-join.ts": "e32fa8f6ced518045c951c3f994dbdc9d86c46ec",
    "vps-journal-reader.ts": "2f14911c957b0b8a70f55a5fa9724242f19cca41",
    "vps-metrics-storage.ts": "a35faac27faa2924dab4ecae391df6d935e2e10f",
    "vps-release-journal.ts": "2610fb5b2e2dc5f836cb7ddd604350bab29b02d2",
    "deploy-lock.ts": "a4edfb81e8e6a007016aa4e08f92d0d6c61683b3",
    "io.ts": "968241986a614be5ce0146a2e8840828438c9066",
  },
} as const;
type Revision = keyof typeof UPSTREAM_BLOBS;
type UpstreamFile = {
  [R in Revision]: keyof (typeof UPSTREAM_BLOBS)[R];
}[Revision];

async function gitBlobId(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const all = new Uint8Array(header.byteLength + bytes.byteLength);
  all.set(header);
  all.set(bytes, header.byteLength);
  return hex(await crypto.subtle.digest("SHA-1", all));
}
function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}

/** Exact upstream bytes, refused unless they are the recorded Git blob. */
export async function upstreamSource(
  revision: Revision,
  file: UpstreamFile,
): Promise<string> {
  const blobs: Record<string, string> = UPSTREAM_BLOBS[revision];
  const expected = blobs[file];
  assert.ok(expected, `no pinned upstream blob for ${revision}:${file}`);
  const directory = file === "vps-release-contract.ts"
    ? WINDOW_DRIVER_SHA
    : revision;
  const bytes = await Deno.readFile(
    new URL(
      `../fixtures/vps/ai.ubq.fi/${directory.slice(0, 8)}/ops/${file}.txt`,
      import.meta.url,
    ),
  );
  assert.equal(await gitBlobId(bytes), expected, `${revision}:ops/${file}`);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Test-owned native effects; the fixture driver module only forwards here. */
export type VpsDriverFixtureHook = {
  create(deps: Record<string, unknown>): unknown;
  run(program: string, args: string[], cwd: string): Promise<string>;
  evaluated: string[];
  storageRoots: string[];
  /** Argument count and retention of each join storage construction. */
  storageCalls: { arity: number; policy: unknown }[];
  sealed: Map<string, { sequence: number; bytes: Uint8Array }>;
};
const HOOK = Symbol.for("sentinel.test.vps-driver-fixture");
export function installVpsDriverHook(
  hook: Partial<VpsDriverFixtureHook> = {},
): VpsDriverFixtureHook {
  const installed: VpsDriverFixtureHook = {
    create: () => {
      throw new Error("no fake native driver installed");
    },
    run: () => Promise.reject(new Error("no native command authorized")),
    evaluated: [],
    storageRoots: [],
    storageCalls: [],
    sealed: new Map(),
    ...hook,
  };
  (globalThis as Record<symbol, unknown>)[HOOK] = installed;
  return installed;
}

const hookRead = `const hook = globalThis[Symbol.for("${HOOK.description}")];`;
/** Fake driver module: no native effect, only the test hook. */
export const FAKE_DRIVER = `${hookRead}
hook.evaluated.push("driver");
export function createVpsDeploymentDriver(deps) { return hook.create(deps); }
export function runVpsCommand(program, args, cwd) { return hook.run(program, args, cwd); }
`;
/**
 * A driver revision whose join storage lock loads under Deno: the upstream
 * createVpsJoinFileStorage signature and CAS, kept in memory.
 */
export const DENO_STORAGE =
  `import { canonicalVps } from "./vps-release-contract.ts";
${hookRead}
hook.evaluated.push("storage");
export function createVpsJoinFileStorage(root, policy, cipher, current, now = Date.now, stateReadMs) {
  hook.storageRoots.push(root);
  hook.storageCalls.push({ arity: arguments.length, policy });
  return {
    load: (scope) => Promise.resolve(hook.sealed.get(scope.operationId)?.bytes ?? null),
    save: async (scope, expected, bytes) => {
      if (canonicalVps(await current(scope)) !== canonicalVps(scope) || bytes.byteLength > policy.evidenceMaxBytes) return false;
      if ((hook.sealed.get(scope.operationId)?.sequence ?? null) !== expected) return false;
      hook.sealed.set(scope.operationId, { sequence: (expected ?? 0) + 1, bytes });
      return true;
    },
  };
}
`;

export async function windowDriverFiles(): Promise<Record<string, string>> {
  return {
    "ops/vps-release-driver.ts": FAKE_DRIVER,
    "ops/vps-release-contract.ts": await upstreamSource(
      WINDOW_DRIVER_SHA,
      "vps-release-contract.ts",
    ),
    "ops/vps-release-metrics.ts": await upstreamSource(
      WINDOW_DRIVER_SHA,
      "vps-release-metrics.ts",
    ),
  };
}
/** The real #1027 metrics graph with a Deno-loadable storage stand-in. */
export async function joinedDriverFiles(): Promise<Record<string, string>> {
  const files: Record<string, string> = {
    "ops/vps-release-driver.ts": FAKE_DRIVER,
    "ops/vps-metrics-storage.ts": DENO_STORAGE,
  };
  for (
    const file of [
      "vps-release-contract.ts",
      "vps-release-metrics.ts",
      "vps-metrics-types.ts",
      "vps-metrics-join.ts",
      "vps-journal-reader.ts",
    ] as const
  ) files[`ops/${file}`] = await upstreamSource(JOINED_DRIVER_SHA, file);
  return files;
}
/** The real #1155/#1162 metrics graph with the same storage stand-in. */
export async function denoDriverFiles(): Promise<Record<string, string>> {
  const files: Record<string, string> = {
    "ops/vps-release-driver.ts": FAKE_DRIVER,
    "ops/vps-metrics-storage.ts": DENO_STORAGE,
  };
  for (
    const file of [
      "vps-release-contract.ts",
      "vps-release-metrics.ts",
      "vps-metrics-types.ts",
      "vps-metrics-join.ts",
      "vps-journal-reader.ts",
    ] as const
  ) files[`ops/${file}`] = await upstreamSource(DENO_DRIVER_SHA, file);
  return files;
}

export interface VpsDriverTreeV1 {
  releaseRoot: string;
  identity: VpsIdentity;
  moduleSha256: string;
  cleanup(): Promise<void>;
}
/** Writes an immutable release tree inside the repository and pins its digest. */
export async function writeVpsDriverTree(
  gitSha: string,
  files: Record<string, string>,
): Promise<VpsDriverTreeV1> {
  const repository = decodeURIComponent(
    new URL("../../", import.meta.url)
      .pathname,
  ).replace(/\/$/, "");
  const tmp = await Deno.realPath(
    await Deno.makeTempDir({
      dir: repository,
      prefix: "sentinel-release-test-vps-driver-",
    }),
  );
  const releaseRoot = `${tmp}/releases/${gitSha}`;
  for (const [path, text] of Object.entries(files)) {
    const full = `${releaseRoot}/${path}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, text);
  }
  const entries: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const names: string[] = [];
    for await (
      const entry of Deno.readDir(`${releaseRoot}/${relative}`)
    ) names.push(entry.name);
    names.sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      const path = relative ? `${relative}/${name}` : name;
      const stat = await Deno.lstat(`${releaseRoot}/${path}`);
      const mode = (stat.mode ?? 0) & 0o777;
      if (stat.isDirectory) {
        entries.push(JSON.stringify([path, "directory", mode]));
        await walk(path);
      } else {
        entries.push(JSON.stringify([
          path,
          "file",
          mode,
          await sha256(await Deno.readFile(`${releaseRoot}/${path}`)),
        ]));
      }
    }
  };
  await walk("");
  return {
    releaseRoot,
    identity: {
      runtime: "vps",
      gitSha,
      deploymentId: `vps-${gitSha}`,
      sourceArchiveSha256: "b".repeat(64),
      immutableTreeSha256: await sha256(
        new TextEncoder().encode(entries.join("\n")),
      ),
    },
    moduleSha256: await sha256(
      await Deno.readFile(`${releaseRoot}/ops/vps-release-driver.ts`),
    ),
    cleanup: () => Deno.remove(tmp, { recursive: true }).catch(() => {}),
  };
}

/** Real AES-GCM sealing bound to the driver's associated data. */
export async function testCipher(): Promise<{
  seal(plain: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
  open(sealed: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
}> {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return {
    seal: async (plain, data) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const body = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: new Uint8Array(data) },
          key,
          new Uint8Array(plain),
        ),
      );
      const out = new Uint8Array(12 + body.byteLength);
      out.set(iv);
      out.set(body, 12);
      return out;
    },
    open: async (sealed, data) =>
      new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: sealed.slice(0, 12),
            additionalData: new Uint8Array(data),
          },
          key,
          sealed.slice(12),
        ),
      ),
  };
}

export type FakeJournalRequest = {
  id: string;
  identity: VpsIdentity;
  acceptedAt: number;
  terminalAt: number;
  status?: number;
};
/** journalctl --output=json rows for the fixed unit and one boot. */
export function journalRows(
  requests: readonly FakeJournalRequest[],
  start: number,
  end: number,
): string {
  const rows: { at: number; line: string }[] = [];
  for (const request of requests) {
    const base = {
      request_id: request.id,
      git_sha: request.identity.gitSha,
      deno_revision: request.identity.deploymentId,
    };
    for (
      const [kind, at, body] of [
        ["accepted", request.acceptedAt, base],
        ["terminal", request.terminalAt, {
          ...base,
          status: request.status ?? 200,
          stream: false,
          failure_kind: null,
          admission_stage: "accepted",
        }],
      ] as const
    ) {
      if (at < start || at >= end) continue;
      rows.push({
        at,
        line: JSON.stringify({
          _SYSTEMD_UNIT: "ai-ubq-fi.service",
          _BOOT_ID: "boot-fixture",
          __CURSOR: `cursor-${request.id}-${kind}`,
          __REALTIME_TIMESTAMP: String(at * 1000),
          MESSAGE: `[ai.ubq.fi] request_${kind} ${JSON.stringify(body)}`,
        }),
      });
    }
  }
  return rows.sort((left, right) => left.at - right.at).map((row) =>
    `${row.line}\n`
  ).join("");
}
/** Independent completeness proof the owner's coverage readback returns. */
export function journalCoverage(start: number, end: number) {
  return {
    complete: true as const,
    unit: "ai-ubq-fi.service" as const,
    windowStart: start,
    windowEnd: end,
    bootId: "boot-fixture",
    firstCursor: `first-${start}`,
    lastCursor: `last-${end}`,
    digest: "c".repeat(64),
  };
}
/**
 * Parses exactly one of the fixed journalctl argv shapes the pinned readers
 * build: five arguments through #1027, six with `--all` since #1155.
 */
export function journalRange(args: readonly string[]): [number, number] {
  assert.ok(args.length === 5 || args.length === 6, args.join(" "));
  assert.equal(args[0], "--unit=ai-ubq-fi.service");
  assert.equal(args[3], "--output=json");
  if (args.length === 6) assert.equal(args[4], "--all");
  assert.equal(args.at(-1), "--no-pager");
  const since = /^--since=@(\d+(?:\.\d+)?)$/.exec(args[1]);
  const until = /^--until=@(\d+(?:\.\d+)?)$/.exec(args[2]);
  assert.ok(since && until, `unexpected journal range ${args.join(" ")}`);
  return [
    Math.round(Number(since[1]) * 1000),
    Math.round(Number(until[1]) * 1000),
  ];
}
