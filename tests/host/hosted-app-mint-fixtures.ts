/** Runs the actual unbundled mint and post entrypoints with synthetic HTTP only. */
import assert from "node:assert/strict";

export const mintAction = ".github/actions/sentinel-app-token";
export const syntheticToken = "sentinel-fixture-installation-token";
const nodeMinimumMinor = 4;
let nodePromise: Promise<{ path: string; version: string }> | undefined;

export function mintNode(): Promise<{ path: string; version: string }> {
  return nodePromise ??= (async () => {
    const result = await new Deno.Command("node", {
      args: [
        "--input-type=module",
        "--eval",
        "console.log(JSON.stringify({path:process.execPath,version:process.version}))",
      ],
      clearEnv: true,
      env: { PATH: Deno.env.get("PATH") ?? "" },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.deepEqual(result.code, 0);
    const value = JSON.parse(new TextDecoder().decode(result.stdout));
    assert(typeof value.path === "string" && value.path.startsWith("/"));
    assert(typeof value.version === "string");
    const match = /^v24\.(\d+)\.(\d+)$/.exec(value.version);
    assert(match !== null && Number(match[1]) >= nodeMinimumMinor);
    return { path: value.path, version: value.version };
  })();
}

/** GitHub's file-command protocol, including the real core-generated delimiter. */
export function readFileCommands(text: string): Record<string, string> {
  const lines = text.split("\n");
  const values: Record<string, string> = {};
  for (let index = 0; index < lines.length;) {
    const line = lines[index++];
    if (line === "") continue;
    const marker = line.indexOf("<<");
    assert(marker > 0);
    const name = line.slice(0, marker);
    const delimiter = line.slice(marker + 2);
    const content: string[] = [];
    while (index < lines.length && lines[index] !== delimiter) {
      content.push(lines[index++]);
    }
    assert.deepEqual(lines[index++], delimiter);
    assert(!(name in values));
    values[name] = content.join("\n");
  }
  return values;
}

export interface MintFixtureOptions {
  response?: Record<string, unknown>;
  installation?: Record<string, unknown>;
  rejectGrantOutput?: boolean;
  failRequest?: "installation" | "mint" | "revoke";
}

export async function runMintFixture(options: MintFixtureOptions = {}) {
  const node = await mintNode();
  const parent = `${Deno.cwd()}/.sentinel-artifacts`;
  await Deno.mkdir(parent, { recursive: true });
  const dir = await Deno.makeTempDir({ dir: parent, prefix: "app-mint-" });
  const paths = {
    config: `${dir}/config.json`,
    preload: `${dir}/preload.mjs`,
    output: `${dir}/output`,
    state: `${dir}/state`,
    trace: `${dir}/trace`,
  };
  try {
    await Deno.writeTextFile(paths.preload, nodePreload);
    for (const path of [paths.output, paths.state, paths.trace]) {
      await Deno.writeTextFile(path, "");
    }
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await Deno.writeTextFile(
      paths.config,
      JSON.stringify({
        token: syntheticToken,
        expiresAt,
        ...options,
      }),
    );
    const env = {
      PATH: Deno.env.get("PATH") ?? "",
      HOME: dir,
      TMPDIR: dir,
      TMP: dir,
      TEMP: dir,
      GITHUB_REPOSITORY: "Ubiquity-Sentinel/sentinel",
      GITHUB_REPOSITORY_OWNER: "ubiquity",
      GITHUB_OUTPUT: paths.output,
      GITHUB_STATE: paths.state,
      "INPUT_CLIENT-ID": "Iv23liHUJNXds9mU3j7Q",
      INPUT_OWNER: "ubiquity",
      INPUT_REPOSITORIES: "Ubiquity-Sentinel/sentinel,ubiquity/ai.ubq.fi",
      "INPUT_SKIP-TOKEN-REVOKE": "false",
      "INPUT_GITHUB-API-URL": "https://api.github.com",
      SENTINEL_MINT_FIXTURE_CONFIG: paths.config,
      SENTINEL_MINT_FIXTURE_TRACE: paths.trace,
    };
    const execute = (entry: "main" | "post", extra: Record<string, string>) =>
      new Deno.Command(node.path, {
        args: ["--import", paths.preload, `${mintAction}/${entry}.js`],
        cwd: Deno.cwd(),
        clearEnv: true,
        env: { ...env, ...extra, SENTINEL_MINT_FIXTURE_PHASE: entry },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
    const main = await execute("main", {});
    const output = readFileCommands(await Deno.readTextFile(paths.output));
    const state = readFileCommands(await Deno.readTextFile(paths.state));
    // Runner restores exactly the values produced by the real GITHUB_STATE file.
    const post = await execute("post", {
      STATE_token: state.token ?? "",
      STATE_expiresAt: state.expiresAt ?? "",
    });
    const trace = (await Deno.readTextFile(paths.trace)).trim().split("\n")
      .filter(Boolean).map((line) => JSON.parse(line));
    for (const row of trace.filter((row) => row.kind === "runtime")) {
      assert.deepEqual(row.path, node.path);
      assert.deepEqual(row.version, node.version);
    }
    return {
      node,
      main: {
        code: main.code,
        stdout: new TextDecoder().decode(main.stdout),
        stderr: new TextDecoder().decode(main.stderr),
      },
      post: {
        code: post.code,
        stdout: new TextDecoder().decode(post.stdout),
        stderr: new TextDecoder().decode(post.stderr),
      },
      output,
      state,
      trace,
      expiresAt,
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const nodePreload = `
import fs, { appendFileSync, readFileSync } from "node:fs";
import { generateKeyPairSync, verify } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
const config = JSON.parse(readFileSync(process.env.SENTINEL_MINT_FIXTURE_CONFIG, "utf8"));
const trace = (value) => appendFileSync(process.env.SENTINEL_MINT_FIXTURE_TRACE, JSON.stringify(value) + "\\n");
trace({kind:"runtime",path:process.execPath,version:process.version});
const append = fs.appendFileSync.bind(fs);
fs.appendFileSync = (path, data, ...args) => {
  if(config.rejectGrantOutput && path === process.env.GITHUB_OUTPUT && String(data).startsWith("mint-grant<<")) {
    trace({kind:"grantWriteRefused"});
    throw new Error("sensitive-fixture-exception-must-not-be-logged");
  }
  return append(path, data, ...args);
};
syncBuiltinESMExports();
const {privateKey, publicKey} = generateKeyPairSync("rsa", {
  modulusLength:2048,
  publicKeyEncoding:{type:"spki",format:"pem"},
  privateKeyEncoding:{type:"pkcs8",format:"pem"}
});
process.env["INPUT_PRIVATE-KEY"] = privateKey;
globalThis.fetch = async (url, init = {}) => {
  const target = new URL(typeof url === "string" ? url : url.url ?? url.href);
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  const authorization = headers.get("authorization") ?? "";
  if(target.origin !== "https://api.github.com") throw new Error("Unexpected fixture destination");
  const requestKind = method === "GET" ? "installation" : method === "POST" ? "mint" : "revoke";
  if(config.failRequest === requestKind) {
    trace({kind:"refusedRequest",requestKind});
    return new Response(JSON.stringify({message:"sensitive-fixture-api-error-must-not-be-logged"}),{status:401,headers:{"content-type":"application/json"}});
  }
  let data;
  if(method === "GET" && target.pathname === "/repos/Ubiquity-Sentinel/sentinel/installation") {
    const jwt = authorization.replace(/^bearer /i, "").split(".");
    const valid = jwt.length === 3 && verify("RSA-SHA256", Buffer.from(jwt[0] + "." + jwt[1]), publicKey, Buffer.from(jwt[2], "base64url"));
    if(!valid) throw new Error("Fixture expected actual App-signed authentication");
    trace({kind:"installation",appAuthenticated:true});
    data = {id:155687488,app_id:4682172,app_slug:"ubiquity-sentinel",...config.installation};
  } else if(method === "POST" && target.pathname === "/app/installations/155687488/access_tokens") {
    const body = JSON.parse(init.body);
    trace({kind:"mint",body});
    data = {
      token:config.token,expires_at:config.expiresAt,
      permissions:{contents:"write",metadata:"read",actions:"write",pull_requests:"write",issues:"write",checks:"write",statuses:"write",merge_queues:"write",workflows:"write",deployments:"write"},
      repositories:[{id:101,name:"sentinel"},{id:102,name:"ai.ubq.fi"}],
      repository_selection:"selected",
      ...config.response
    };
  } else if(method === "DELETE" && target.pathname === "/installation/token") {
    if(!authorization.endsWith(config.token)) throw new Error("Fixture expected minted token revocation");
    trace({kind:"revoke",sameToken:true});
    return new Response(null,{status:204});
  } else throw new Error("Unexpected fixture request");
  return new Response(JSON.stringify(data),{status:200,headers:{"content-type":"application/json"}});
};
`;
