import assert from "node:assert/strict";
import { join } from "node:path";
import { correctAgentJobHead } from "../../ops/agent-jobs-correct.ts";
import type { AgentJobRunner, AgentJobV1 } from "../../ops/agent-jobs-plan.ts";

const hostRunner: AgentJobRunner = Deno.build.os === "darwin"
  ? "macos-arm64"
  : Deno.build.arch === "aarch64"
  ? "linux-arm64"
  : "linux-x64";
const hostSupported =
  Deno.build.os === "darwin" && Deno.build.arch === "aarch64" ||
  Deno.build.os === "linux";

type Scenario = "changed" | "no-diff" | "wrong-profile" | "escaped" | "timeout";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await new Deno.Command("git", {
    cwd,
    args: [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).output();
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

async function withCorrection(
  scenario: Scenario,
  check: (
    context: {
      input: Parameters<typeof correctAgentJobHead>[0];
      received: string;
      stateBefore: string;
      root: string;
    },
  ) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-test-local-job-correction-",
  });
  const path = Deno.env.get("PATH") ?? "/usr/bin:/bin";
  const source = join(root, "source");
  const workRoot = join(root, "private-round");
  const received = join(root, "receipts");
  try {
    await Deno.mkdir(source);
    await git(source, "init", "--initial-branch=main", "--template=");
    await Deno.writeTextFile(join(source, "file.txt"), "original\n");
    await git(source, "add", ".");
    await git(source, "commit", "-m", "base");
    await Deno.mkdir(join(source, ".codex"));
    await Deno.writeTextFile(
      join(source, ".codex", "config.toml"),
      'approval_policy = "on-request"\n',
    );
    await Deno.writeTextFile(join(source, "file.txt"), "rejected\n");
    await git(source, "add", ".");
    await git(source, "commit", "-m", "rejected");
    const headSha = await git(source, "rev-parse", "HEAD");
    const stateBefore = await git(source, "show-ref");

    const bin = join(root, "bin");
    await Deno.mkdir(bin);
    await Deno.writeTextFile(
      join(bin, "codex"),
      [
        "#!/usr/bin/env -S deno run --no-config --allow-read --allow-write --allow-env=CODEX_HOME",
        `const scenario = ${JSON.stringify(scenario)};`,
        `const receipt = ${JSON.stringify(received)};`,
        `const head = ${JSON.stringify(headSha)};`,
        fakeAppServer,
      ].join("\n"),
      { mode: 0o700 },
    );
    Deno.env.set("PATH", `${bin}:${path}`);
    const job: AgentJobV1 = {
      id: "job-001",
      repository: "ubiquity/a",
      base: "main",
      prompt: "Preserve the rejected work and fulfill the original request.",
      setup: [`touch "${join(root, "setup-executed")}"`],
      minutes: 1,
      model: "vendor/selected",
      reasoningEffort: "high",
      pr: false,
      runner: hostRunner,
    };
    await check({
      input: {
        job,
        sourcePath: source,
        headSha,
        feedback: "P0: preserve the existing work plus the missing behavior.",
        workRoot,
        deadlineAtMs: Date.now() + (scenario === "timeout" ? 1_500 : 15_000),
        modelToken: "dummy-no-inference",
        baseUrl: "http://127.0.0.1:1/v1",
        defaultModel: "different-default",
      },
      received,
      stateBefore,
      root,
    });
  } finally {
    Deno.env.set("PATH", path);
    await Deno.remove(root, { recursive: true });
  }
}

const fakeAppServer = `
const encoder = new TextEncoder();
const send = (msg) => Deno.stdout.writeSync(encoder.encode(JSON.stringify(msg) + "\\n"));
const must = (condition) => { if (!condition) Deno.exit(1); };
const config = await Deno.readTextFile(Deno.env.get("CODEX_HOME") + "/config.toml");
must(config.includes('approval_policy = "never"'));
must(config.includes('default_permissions = "sentinel-local"'));
must(config.includes('".git" = "read"'));
must(config.includes('plugins = false'));
must(config.includes('enabled = false'));
must(config.includes('inherit = "none"'));
must(!config.includes("dummy-no-inference"));
must(Deno.args[0] === "app-server" && Deno.args[1] === "-c");
let checkout;
let buffer = "";
const receive = async ({id, method, params}) => {
  const reply = (result) => send({jsonrpc: "2.0", id, result});
  if (method === "initialize") return reply({ userAgent: "test-app-server" });
  if (method === "initialized") return;
  if (method === "thread/start") {
    checkout = params.cwd;
    must(Deno.cwd() !== checkout);
    must(Deno.args[2] === 'projects.' + JSON.stringify(checkout) + '.trust_level="untrusted"');
    must(params.model === "vendor/selected" && params.modelProvider === "uos");
    must(params.config.model_reasoning_effort === "high");
    must(params.approvalPolicy === "never" && params.permissions === "sentinel-local");
    return reply({
      thread: { id: "thread-1" },
      model: params.model,
      modelProvider: params.modelProvider,
      reasoningEffort: params.config.model_reasoning_effort,
      approvalPolicy: params.approvalPolicy,
      activePermissionProfile: { id: scenario === "wrong-profile" ? "full-access" : params.permissions },
    });
  }
  if (method === "command/exec") {
    must(params.cwd === checkout && params.permissionProfile === "sentinel-local");
    const [executable, file, destination] = params.command;
    if (executable === "/usr/bin/touch") {
      await Deno.writeTextFile(file, "");
      return reply({exitCode: 0, stdout: ""});
    }
    if (executable === "/bin/cat" && scenario === "escaped") {
      return reply({exitCode: 0, stdout: await Deno.readTextFile(file)});
    }
    must(executable === "/bin/cat" || (executable === "/bin/cp" && destination));
    return reply({exitCode: 1, stdout: ""});
  }
  if (method === "turn/start") {
    must(params.threadId === "thread-1" && params.model === "vendor/selected" && params.effort === "high");
    const prompt = params.input[0].text;
    must(prompt.includes(head) && prompt.includes("fulfill the original request") && prompt.includes("P0: preserve"));
    must(await Deno.readTextFile(checkout + "/file.txt") === "rejected\\n");
    await Deno.writeTextFile(receipt, "start\\n");
    if (scenario === "changed") {
      await Deno.writeTextFile(checkout + "/file.txt", "rejected\\ncorrected\\n");
    }
    if (scenario !== "timeout") {
      // A completion for another turn cannot satisfy this request. The exact
      // completion arrives before the start acknowledgement.
      send({jsonrpc: "2.0", method: "turn/completed", params: {threadId: "thread-1", turn: {id: "different", status: "failed"}}});
      send({jsonrpc: "2.0", method: "turn/completed", params: {threadId: "thread-1", turn: {id: "turn-1", status: "completed"}}});
    }
    return reply({turn: {id: "turn-1"}});
  }
  if (method === "turn/interrupt") {
    must(params.threadId === "thread-1" && params.turnId === "turn-1");
    await Deno.writeTextFile(receipt, "interrupt\\n", { append: true });
    return reply({});
  }
  Deno.exit(1);
};
for await (const fragment of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
  buffer += fragment;
  let end;
  while ((end = buffer.indexOf("\\n")) !== -1) {
    await receive(JSON.parse(buffer.slice(0, end)));
    buffer = buffer.slice(end + 1);
  }
}
`;

Deno.test({
  name:
    "agent job correction imports only a changed committed child of the rejected head",
  ignore: !hostSupported,
  fn: () =>
    withCorrection(
      "changed",
      async ({ input, received, stateBefore, root }) => {
        const corrected = await correctAgentJobHead(input);
        assert.match(corrected, /^[0-9a-f]{40}$/);
        assert.equal(
          await git(
            input.sourcePath,
            "rev-list",
            "--parents",
            "-n",
            "1",
            corrected,
          ),
          `${corrected} ${input.headSha}`,
        );
        assert.equal(
          await git(input.sourcePath, "show", `${corrected}:file.txt`),
          "rejected\ncorrected",
        );
        assert.equal(
          await git(
            input.sourcePath,
            "diff",
            "--name-only",
            input.headSha,
            corrected,
          ),
          "file.txt",
        );
        assert.equal(await git(input.sourcePath, "show-ref"), stateBefore);
        assert.equal(await Deno.readTextFile(received), "start\n");
        await assert.rejects(
          Deno.stat(join(root, "setup-executed")),
          Deno.errors.NotFound,
        );
        assert.deepEqual(
          await Array.fromAsync(Deno.readDir(input.workRoot)),
          [],
        );
      },
    ),
});

for (
  const [scenario, detail, started] of [
    ["no-diff", /correction made no tree changes/, true],
    [
      "wrong-profile",
      /model or permission profile was not acknowledged/,
      false,
    ],
    ["escaped", /sandbox exposed a host file/, false],
    ["timeout", /correction deadline exhausted/, true],
  ] as const
) {
  Deno.test({
    name: `agent job correction refuses ${scenario} without importing work`,
    ignore: !hostSupported,
    fn: () =>
      withCorrection(scenario, async ({ input, received, stateBefore }) => {
        await assert.rejects(correctAgentJobHead(input), detail);
        assert.equal(await git(input.sourcePath, "show-ref"), stateBefore);
        assert.equal(
          await git(input.sourcePath, "rev-parse", "HEAD"),
          input.headSha,
        );
        assert.deepEqual(
          await Array.fromAsync(Deno.readDir(input.workRoot)),
          [],
        );
        if (started) {
          assert.match(await Deno.readTextFile(received), /^start\n/);
        } else {
          await assert.rejects(Deno.stat(received), Deno.errors.NotFound);
        }
      }),
  });
}
