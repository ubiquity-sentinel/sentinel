/**
 * The vendored mint's explicitly selected tolerance of an inaccessible listed
 * repository, through the actual unbundled main/post entrypoints with
 * synthetic HTTP only (same preparation as `hosted-app-mint_test.ts`).
 */
import assert from "node:assert/strict";
import {
  mintAction,
  mintNode,
  readFileCommands,
} from "./hosted-app-mint-fixtures.ts";

const NAMES = [
  "ai.ubq.fi",
  "prospector",
  "passport.ubq.fi",
  "ubiquibar",
  "stake.ubq.fi",
  "work.ubq.fi",
  "pay.ubq.fi",
  "xp.ubq.fi",
  "permit3",
  "ts-template",
  "demo.ubq.fi",
  "card-issuance",
];
const REFUSAL =
  "There is at least one repository that does not exist or is not accessible to the parent installation.";

async function runTolerant(options: {
  names?: string[];
  inaccessible?: string[];
  transferred?: string[];
  extraRepository?: string;
  tolerate?: string;
  hint?: string;
  permissions?: Record<string, string>;
}) {
  const node = await mintNode();
  const parent = `${Deno.cwd()}/.sentinel-artifacts`;
  await Deno.mkdir(parent, { recursive: true });
  const dir = await Deno.makeTempDir({ dir: parent, prefix: "app-tolerant-" });
  const paths = {
    config: `${dir}/config.json`,
    preload: `${dir}/preload.mjs`,
    output: `${dir}/output`,
    state: `${dir}/state`,
    trace: `${dir}/trace`,
  };
  try {
    await Deno.writeTextFile(paths.preload, preload);
    for (const path of [paths.output, paths.state, paths.trace]) {
      await Deno.writeTextFile(path, "");
    }
    await Deno.writeTextFile(
      paths.config,
      JSON.stringify({
        inaccessible: options.inaccessible ?? [],
        transferred: options.transferred ?? [],
        extraRepository: options.extraRepository ?? null,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        refusal: REFUSAL,
      }),
    );
    const env: Record<string, string> = {
      PATH: Deno.env.get("PATH") ?? "",
      HOME: dir,
      TMPDIR: dir,
      GITHUB_REPOSITORY: "ubiquity-sentinel/sentinel",
      GITHUB_REPOSITORY_OWNER: "ubiquity-sentinel",
      GITHUB_OUTPUT: paths.output,
      GITHUB_STATE: paths.state,
      "INPUT_CLIENT-ID": "Iv23liHUJNXds9mU3j7Q",
      INPUT_OWNER: "ubiquity",
      INPUT_REPOSITORIES: (options.names ?? NAMES).join(","),
      "INPUT_SKIP-TOKEN-REVOKE": "false",
      "INPUT_GITHUB-API-URL": "https://api.github.com",
      SENTINEL_MINT_FIXTURE_CONFIG: paths.config,
      SENTINEL_MINT_FIXTURE_TRACE: paths.trace,
    };
    if (options.tolerate !== undefined) {
      env["INPUT_TOLERATE-INACCESSIBLE-REPOSITORIES"] = options.tolerate;
    }
    if (options.hint !== undefined) {
      env["INPUT_KNOWN-UNAVAILABLE"] = options.hint;
    }
    for (const [name, level] of Object.entries(options.permissions ?? {})) {
      env[`INPUT_PERMISSION-${name.toUpperCase()}`] = level;
    }
    const execute = (entry: "main" | "post", extra: Record<string, string>) =>
      new Deno.Command(node.path, {
        args: ["--import", paths.preload, `${mintAction}/${entry}.js`],
        cwd: Deno.cwd(),
        clearEnv: true,
        env: { ...env, ...extra },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
    const main = await execute("main", {});
    const output = readFileCommands(await Deno.readTextFile(paths.output));
    const state = readFileCommands(await Deno.readTextFile(paths.state));
    const mainTrace = await readTrace(paths.trace);
    await Deno.writeTextFile(paths.trace, "");
    const post = await execute("post", {
      STATE_token: state.token ?? "",
      STATE_expiresAt: state.expiresAt ?? "",
    });
    return {
      code: main.code,
      stdout: new TextDecoder().decode(main.stdout),
      postCode: post.code,
      output,
      requests: mainTrace,
      postRequests: await readTrace(paths.trace),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function readTrace(path: string): Promise<Record<string, unknown>[]> {
  return (await Deno.readTextFile(path)).trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Synthetic GitHub: a mint naming any inaccessible repository is refused; a
 * transferred repository's lookup answers the other account's installation,
 * as a followed redirect would.
 */
const preload = `
import { appendFileSync, readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
const config = JSON.parse(readFileSync(process.env.SENTINEL_MINT_FIXTURE_CONFIG, "utf8"));
const trace = (value) => appendFileSync(process.env.SENTINEL_MINT_FIXTURE_TRACE, JSON.stringify(value) + "\\n");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" } });
process.env["INPUT_PRIVATE-KEY"] = privateKey;
let mints = 0;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const installation = { id: 155687488, app_id: 4682172, app_slug: "ubiquity-sentinel", account: { login: "Ubiquity" } };
const foreign = { id: 999, app_id: 4682172, app_slug: "ubiquity-sentinel", account: { login: "other-org" } };
globalThis.fetch = async (url, init = {}) => {
  const target = new URL(typeof url === "string" ? url : url.url ?? url.href);
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  if (target.origin !== "https://api.github.com") throw new Error("Unexpected fixture destination");
  const lookup = /^\\/repos\\/ubiquity\\/([^/]+)\\/installation$/.exec(target.pathname);
  if (method === "GET" && lookup !== null) {
    trace({ kind: "lookup", repository: lookup[1], redirect: init.redirect ?? null });
    if (config.transferred.includes(lookup[1])) return json(foreign);
    return config.inaccessible.includes(lookup[1]) ? json({ message: "Not Found" }, 404) : json(installation);
  }
  if (method === "GET" && target.pathname === "/users/ubiquity/installation") {
    trace({ kind: "ownerLookup", redirect: init.redirect ?? null });
    return json(installation);
  }
  if (method === "POST" && target.pathname === "/app/installations/999/access_tokens") {
    trace({ kind: "foreignMint" });
    return json({ token: "foreign-token", expires_at: config.expiresAt, permissions: { contents: "write" },
      repositories: [{ id: 5, name: "ai.ubq.fi" }], repository_selection: "selected" });
  }
  if (method === "POST" && target.pathname === "/app/installations/155687488/access_tokens") {
    const body = JSON.parse(init.body);
    if (body.repositories.some((name) => config.inaccessible.includes(name) || config.transferred.includes(name))) {
      trace({ kind: "refused", body });
      return json({ message: config.refusal }, 422);
    }
    const token = "fixture-token-" + ++mints;
    trace({ kind: "mint", body, token });
    const names = [...body.repositories, ...(config.extraRepository ? [config.extraRepository] : [])];
    return json({ token, expires_at: config.expiresAt,
      permissions: { contents: "write", metadata: "read", issues: "write", ...(body.permissions ?? {}) },
      repositories: names.map((name, index) => ({ id: 1000 + index, name })),
      repository_selection: "selected" });
  }
  if (method === "DELETE" && target.pathname === "/installation/token") {
    trace({ kind: "revoke", token: (headers.get("authorization") ?? "").replace(/^token /, "") });
    return new Response(null, { status: 204 });
  }
  throw new Error("Unexpected fixture request");
};
`;

const mints = (requests: Record<string, unknown>[]) =>
  requests.filter((row) => row.kind === "mint");
const asked = (row: Record<string, unknown>) =>
  (row.body as { repositories: string[] }).repositories;
const without = (...dropped: string[]) =>
  NAMES.filter((name) => !dropped.includes(name));

Deno.test("tolerant App mint: one inaccessible listed repository costs only that repository", async () => {
  const run = await runTolerant({
    inaccessible: ["passport.ubq.fi"],
    tolerate: "true",
  });
  assert.equal(run.code, 0);
  const minted = mints(run.requests);
  const final = minted.at(-1)!;
  assert.equal(run.output.token, final.token);
  assert.equal(
    run.output["unavailable-repositories"],
    "ubiquity/passport.ubq.fi",
  );
  assert.deepEqual(asked(final), without("passport.ubq.fi"));
  assert.deepEqual(
    JSON.parse(run.output["mint-grant"]).repositoryNames,
    without("passport.ubq.fi"),
  );
  for (const row of run.requests.filter((row) => row.body !== undefined)) {
    assert.ok(asked(row).every((name) => NAMES.includes(name)));
  }
  // Every probe token was revoked in main; the final one only by post.
  const revoked = run.requests.filter((row) => row.kind === "revoke")
    .map((row) => row.token);
  assert.deepEqual(revoked, minted.slice(0, -1).map((row) => row.token));
  assert.deepEqual(run.postRequests, [{ kind: "revoke", token: final.token }]);
  assert.match(
    run.stdout,
    /::warning::repositories_unavailable: 1 of 12 listed repositories dropped from this token: ubiquity\/passport\.ubq\.fi/,
  );
  // Tokens appear only in the runner's own mask commands; no response text.
  const unmasked = run.stdout.split("\n").filter((line) =>
    !line.startsWith("::add-mask::")
  ).join("\n");
  assert.doesNotMatch(unmasked, /fixture-token|not accessible/);
});

Deno.test("tolerant App mint: a reachable list is the upstream request pair with no extra request", async () => {
  for (const tolerate of ["true", undefined]) {
    const run = await runTolerant({ tolerate });
    assert.equal(run.code, 0);
    assert.deepEqual(run.requests.map((row) => row.kind), ["lookup", "mint"]);
    // Only the tolerant lookup refuses to follow a redirect.
    assert.equal(run.requests[0].redirect, tolerate ? "manual" : null);
    assert.deepEqual(asked(run.requests[1]), NAMES);
    assert.equal(run.output.token, "fixture-token-1");
    assert.equal("unavailable-repositories" in run.output, false);
    assert.doesNotMatch(run.stdout, /::warning::/);
    assert.deepEqual(run.postRequests, [{
      kind: "revoke",
      token: "fixture-token-1",
    }]);
  }
});

Deno.test("tolerant App mint: without the explicit input an inaccessible repository still fails the mint", async () => {
  for (const tolerate of [undefined, "false", "yes"]) {
    const run = await runTolerant({
      inaccessible: ["ubiquibar"],
      tolerate,
      hint: "ubiquity/ubiquibar",
    });
    assert.equal(run.code, 1);
    assert.equal(run.output.token, undefined);
    assert.deepEqual(run.requests.map((row) => row.kind), [
      "lookup",
      "refused",
    ]);
    assert.deepEqual(asked(run.requests[1]), NAMES);
    assert.match(run.stdout, /::error::Sentinel App token mint failed/);
  }
});

Deno.test("tolerant App mint: a first name transferred to another account is only dropped, never followed", async () => {
  const run = await runTolerant({
    transferred: ["ai.ubq.fi"],
    tolerate: "true",
  });
  assert.equal(run.code, 0);
  assert.deepEqual(run.requests.slice(0, 2), [
    { kind: "lookup", repository: "ai.ubq.fi", redirect: "manual" },
    { kind: "ownerLookup", redirect: "manual" },
  ]);
  assert.equal(run.requests.some((row) => row.kind === "foreignMint"), false);
  assert.equal(run.output["installation-id"], "155687488");
  assert.equal(run.output["unavailable-repositories"], "ubiquity/ai.ubq.fi");
  const final = mints(run.requests).at(-1)!;
  assert.equal(run.output.token, final.token);
  assert.deepEqual(asked(final), without("ai.ubq.fi"));
  assert.deepEqual(
    JSON.parse(run.output["mint-grant"]).repositoryNames,
    without("ai.ubq.fi"),
  );
});

Deno.test("tolerant App mint: an unreachable first name and dropped names keep the rest and the same permissions", async () => {
  const run = await runTolerant({
    inaccessible: ["ai.ubq.fi", "stake.ubq.fi", "permit3"],
    tolerate: "true",
    permissions: { contents: "write" },
  });
  assert.equal(run.code, 0);
  assert.deepEqual(run.requests.slice(0, 2).map((row) => row.kind), [
    "lookup",
    "ownerLookup",
  ]);
  assert.deepEqual(
    asked(mints(run.requests).at(-1)!),
    without("ai.ubq.fi", "stake.ubq.fi", "permit3"),
  );
  assert.equal(
    run.output["unavailable-repositories"],
    "ubiquity/ai.ubq.fi,ubiquity/stake.ubq.fi,ubiquity/permit3",
  );
  for (const row of run.requests.filter((row) => row.body !== undefined)) {
    assert.deepEqual(
      (row.body as { permissions: unknown }).permissions,
      { contents: "write" },
    );
  }
  assert.match(run.stdout, /3 of 12 listed repositories dropped/);
});

Deno.test("tolerant App mint: more than three, or more than a quarter of the list, unreachable fails closed", async () => {
  for (
    const [names, inaccessible, ok] of [
      [NAMES, ["prospector", "ubiquibar", "xp.ubq.fi"], true],
      [NAMES, ["prospector", "ubiquibar", "xp.ubq.fi", "permit3"], false],
      [NAMES.slice(0, 8), ["prospector", "ubiquibar"], true],
      [NAMES.slice(0, 8), ["prospector", "ubiquibar", "xp.ubq.fi"], false],
      [NAMES.slice(0, 4), ["prospector"], true],
      [NAMES.slice(0, 3), ["prospector"], false],
      [["prospector", "ubiquibar"], ["prospector", "ubiquibar"], false],
    ] as const
  ) {
    const run = await runTolerant({
      names: [...names],
      inaccessible: [...inaccessible],
      tolerate: "true",
    });
    assert.equal(run.code, ok ? 0 : 1, `${names.length}/${inaccessible}`);
    if (ok) {
      assert.equal(
        run.output["unavailable-repositories"],
        inaccessible.map((name) => `ubiquity/${name}`).join(","),
      );
    } else {
      assert.equal(run.output.token, undefined);
      assert.equal("unavailable-repositories" in run.output, false);
      assert.match(run.stdout, /::error::Sentinel App token mint failed/);
      // Every probe token was revoked; nothing is left for post.
      assert.deepEqual(
        run.requests.filter((row) => row.kind === "revoke").map((r) => r.token),
        mints(run.requests).map((row) => row.token),
      );
      assert.deepEqual(run.postRequests, []);
    }
  }
});

Deno.test("tolerant App mint: an earlier job's hint only removes listed names and lets later jobs mint directly", async () => {
  const run = await runTolerant({
    inaccessible: ["passport.ubq.fi"],
    tolerate: "true",
    hint: "ubiquity/passport.ubq.fi,other-org/prospector,not-listed",
  });
  assert.equal(run.code, 0);
  assert.deepEqual(run.requests.map((row) => row.kind), ["lookup", "mint"]);
  assert.deepEqual(asked(run.requests[1]), without("passport.ubq.fi"));
  assert.equal(
    run.output["unavailable-repositories"],
    "ubiquity/passport.ubq.fi",
  );
  // A stale hint costs only the hinted name for this run.
  const stale = await runTolerant({ tolerate: "true", hint: "ubiquibar" });
  assert.equal(stale.code, 0);
  assert.deepEqual(asked(stale.requests[1]), without("ubiquibar"));
  // A hint past the bound fails before any request.
  const wide = await runTolerant({
    tolerate: "true",
    hint: "prospector,ubiquibar,xp.ubq.fi,permit3",
  });
  assert.equal(wide.code, 1);
  assert.deepEqual(wide.requests, []);
});

Deno.test("tolerant App mint: a token naming a repository outside the request is revoked and fails", async () => {
  const run = await runTolerant({
    tolerate: "true",
    extraRepository: "outside-the-request",
  });
  assert.equal(run.code, 1);
  assert.equal(run.output.token, undefined);
  assert.deepEqual(run.requests.map((row) => row.kind), [
    "lookup",
    "mint",
    "revoke",
  ]);
  assert.equal(run.requests[2].token, run.requests[1].token);
  assert.deepEqual(run.postRequests, []);
});
