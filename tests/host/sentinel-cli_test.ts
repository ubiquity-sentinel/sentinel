import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

const source = fileURLToPath(
  new URL("../../ops/sentinel-cli.ts", import.meta.url),
);
const repository = "Ubiquity-Sentinel/sentinel";
const workflowId = 357012162;
const sha = "a".repeat(40);
const run = {
  id: 9001,
  workflow_id: workflowId,
  head_branch: "sentinel-supervisor",
  head_sha: sha,
  run_attempt: 2,
  event: "workflow_dispatch",
  created_at: new Date().toISOString(),
  display_title: "sentinel-supervisor request __NONCE__",
  status: "completed",
  conclusion: "success",
};
type Reply = {
  command: string;
  value: unknown;
  code?: number;
  raw?: boolean;
  sequence?: unknown[];
  delayMs?: number;
};
const runsCommand =
  `api --paginate --slurp repos/${repository}/actions/workflows/${workflowId}/runs?event=workflow_dispatch&head_sha=${sha}&per_page=100`;
const protocol =
  `name: sentinel-supervisor\nrun-name: \${{ inputs.sentinel_dispatch_request && format('sentinel-supervisor request {0}', inputs.sentinel_dispatch_request) || '' }}\non:\n  workflow_dispatch:\n    inputs:\n      sentinel_dispatch_request:\n        description: Internal operator dispatch identity\n        required: false\n        type: string\n        default: ""\npermissions:\n  contents: read\n`;

function contents(text: string, path = ".github/workflows/supervisor.yml") {
  const bytes = Buffer.from(text, "utf8");
  return {
    type: "file",
    path,
    encoding: "base64",
    content: bytes.toString("base64"),
    sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes)
      .digest("hex"),
  };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function dispatchReplies(runs: unknown[] | null): Reply[] {
  return [
    {
      command: `api repos/${repository}/actions/workflows/supervisor.yml`,
      value: { id: workflowId, path: ".github/workflows/supervisor.yml" },
    },
    {
      command: `api repos/${repository}/git/ref/heads/sentinel-supervisor`,
      value: {
        ref: "refs/heads/sentinel-supervisor",
        object: { type: "commit", sha },
      },
    },
    {
      command:
        `api --method POST repos/${repository}/actions/workflows/supervisor.yml/dispatches -f ref=sentinel-supervisor`,
      value: "",
      raw: true,
    },
    {
      command: `api repos/${repository}/actions/workflows/${workflowId}/runs`,
      value: { workflow_runs: runs },
    },
    {
      command:
        `api repos/${repository}/contents/.github/workflows/supervisor.yml?ref=${sha}`,
      value: contents(protocol),
    },
    {
      command:
        `api --method POST repos/${repository}/actions/workflows/supervisor.yml/dispatches --input -`,
      value: "",
      raw: true,
    },
    {
      command: runsCommand,
      value: [{ total_count: runs?.length ?? 0, workflow_runs: runs }],
    },
    {
      command: `api repos/${repository}/actions/runs/9001/attempts/2`,
      value: run,
    },
    { command: `api repos/${repository}/actions/runs/9001`, value: run },
  ];
}

function receiptReplies(): Reply[] {
  return [
    { command: `api repos/${repository}/actions/runs/9001`, value: run },
    {
      command: `api repos/${repository}/actions/workflows/${workflowId}`,
      value: { id: workflowId, path: ".github/workflows/supervisor.yml" },
    },
    { command: `api repos/${repository}/git/commits/${sha}`, value: { sha } },
    {
      command: `api repos/${repository}/actions/runs/9001/attempts/2`,
      value: run,
    },
    {
      command: `run view 9001 -R ${repository} --attempt 2 --log`,
      value: "hosted_runtime_terminal exact-bound-test-receipt",
      raw: true,
    },
  ];
}

async function invoke(args: string[], replies: Reply[]) {
  const root = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-test-local-cli-",
  });
  try {
    const calls = `${root}/calls`;
    const state = `${root}/state.json`;
    await Deno.writeTextFile(
      `${root}/gh.ts`,
      `
const replies = ${JSON.stringify(replies)};
const command = Deno.args.join(" ");
await Deno.writeTextFile(${
        JSON.stringify(calls)
      }, command + "\\n", { append: true });
const saved = await Deno.readTextFile(${
        JSON.stringify(state)
      }).then(JSON.parse).catch(() => ({ nonce: "missing", counts: {} }));
if (Deno.args.includes("--input")) {
  const body = JSON.parse(await new Response(Deno.stdin.readable).text());
  saved.nonce = body.inputs?.sentinel_dispatch_request;
  saved.body = body;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(saved.nonce)) Deno.exit(72);
}
const reply = replies.find((entry) => entry.command === command);
if (!reply) Deno.exit(71);
const count = saved.counts[command] ?? 0;
saved.counts[command] = count + 1;
await Deno.writeTextFile(${JSON.stringify(state)}, JSON.stringify(saved));
if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
const value = reply.sequence ? reply.sequence[Math.min(count, reply.sequence.length - 1)] : reply.value;
console.log((reply.raw ? String(value) : JSON.stringify(value)).replaceAll("__NONCE__", saved.nonce));
Deno.exit(reply.code ?? 0);
`,
    );
    const script = `#!/bin/sh\nexec ${
      quote(Deno.execPath())
    } run --frozen --cached-only --allow-read=. --allow-write=. ${
      quote(`${root}/gh.ts`)
    } "$@"\n`;
    await Deno.writeTextFile(`${root}/gh`, script);
    await Deno.chmod(`${root}/gh`, 0o755);
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--frozen",
        "--cached-only",
        "--allow-run=gh",
        source,
        ...args,
      ],
      clearEnv: true,
      env: { PATH: root },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: result.code,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
      calls: await Deno.readTextFile(calls).catch(() => ""),
      state: await Deno.readTextFile(state).then(JSON.parse).catch(() => null),
    };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function assertUnverified(result: Awaited<ReturnType<typeof invoke>>) {
  assert.equal(result.code, 1);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.dispatch, "accepted");
  assert.equal(observed.execution, "unverified");
  assert.equal(observed.ref, "sentinel-supervisor");
  assert.equal(observed.observedSourceSha, sha);
  assert.equal(observed.workflowId, workflowId);
  assert.equal(
    "id" in observed || "runId" in observed || "run" in observed,
    false,
  );
  assert.match(result.calls, /--method POST.*--input -/);
  assert.equal(result.state.body.ref, "sentinel-supervisor");
  assert.doesNotMatch(result.calls, /run list|run view/);
  return observed;
}

Deno.test("operator dispatch rejects unrelated ref, source, workflow and missing attempt", async (t) => {
  for (
    const mismatch of [
      { head_branch: "unrelated-ref" },
      { head_sha: "b".repeat(40) },
      { workflow_id: workflowId + 1 },
      { run_attempt: undefined },
    ]
  ) {
    await t.step(JSON.stringify(mismatch), async () => {
      const result = await invoke(
        ["dispatch", "supervisor"],
        dispatchReplies([{ ...run, ...mismatch }]),
      );
      const observed = assertUnverified(result);
      assert.equal(observed.reason, "run_identity_mismatch");
    });
  }
});

Deno.test("operator nonce protocol binds a positive dispatch and exact native attempt", async () => {
  const result = await invoke(
    ["dispatch", "supervisor"],
    dispatchReplies([run]),
  );
  assert.equal(result.code, 0, result.stderr);
  const bound = JSON.parse(result.stdout);
  assert.equal(bound.dispatch, "accepted");
  assert.equal(bound.execution, "verified");
  assert.equal(bound.id, 9001);
  assert.equal(bound.attempt, 2);
  assert.equal(bound.requestId, result.state.nonce);
  assert.deepEqual(result.state.body, {
    ref: "sentinel-supervisor",
    inputs: { sentinel_dispatch_request: bound.requestId },
  });
  assert.match(result.calls, /actions\/runs\/9001\/attempts\/2/);
});

Deno.test("operator nonce never claims a concurrent run with a wrong request nonce", async () => {
  const result = await invoke(
    ["run", "supervisor", "--timeout-min", "0"],
    dispatchReplies([{
      ...run,
      display_title: "sentinel-supervisor request other-request",
    }]),
  );
  assert.equal(result.code, 1);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.dispatch, "accepted");
  assert.equal(observed.execution, "pending");
  assert.equal("id" in observed, false);
  assert.equal(observed.matchingRuns, 0);
  assert.equal(observed.reason, "dispatch_run_pending");
});

Deno.test("operator dispatch refuses multiple matches without selecting list order", async () => {
  const second = { ...run, id: 9002, created_at: "1970-01-01T00:00:00Z" };
  for (const runs of [[run, second], [second, run]]) {
    const observed = assertUnverified(
      await invoke(["dispatch", "supervisor"], dispatchReplies(runs)),
    );
    assert.equal(observed.reason, "multiple_matching_runs");
  }
});

Deno.test("operator dispatch preserves acceptance when run observations are absent or unavailable", async (t) => {
  for (const runs of [[], null]) {
    await t.step(JSON.stringify(runs), async () => {
      const result = await invoke(
        ["dispatch", "supervisor"],
        dispatchReplies(runs),
      );
      if (runs === null) {
        assert.equal(
          assertUnverified(result).reason,
          "observation_unavailable",
        );
      } else {
        assert.equal(result.code, 0, result.stderr);
        const observed = JSON.parse(result.stdout);
        assert.equal(observed.execution, "pending");
        assert.equal(observed.reason, "dispatch_run_pending");
      }
    });
  }
});

Deno.test("operator run and wait never fall back to an unrelated successful run", async (t) => {
  for (
    const args of [
      ["run", "supervisor"],
      ["wait", "supervisor", "--dispatch", "--timeout-min", "1"],
    ]
  ) {
    await t.step(args.join(" "), async () => {
      assertUnverified(
        await invoke(
          args,
          dispatchReplies([{ ...run, head_branch: "unrelated-ref" }]),
        ),
      );
    });
  }
  const wait = await invoke(["wait", "supervisor"], []);
  assert.equal(wait.code, 1);
  assert.match(wait.stderr, /wait has no bound run identity/);
  assert.equal(wait.calls, "");
});

Deno.test("operator dispatch refuses unverified workflow or source before effects", async (t) => {
  for (
    const [index, value] of [
      [0, { id: workflowId, path: ".github/workflows/foreign.yml" }],
      [1, {
        ref: "refs/heads/sentinel-supervisor",
        object: { type: "commit", sha: "short" },
      }],
    ] as const
  ) {
    await t.step(String(index), async () => {
      const replies = dispatchReplies([]);
      replies[index] = { ...replies[index], value };
      const result = await invoke(["dispatch", "supervisor"], replies);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.doesNotMatch(result.calls, /--method POST/);
    });
  }
});

Deno.test("operator receipts bind exact run, workflow, ref, source and native attempt", async () => {
  const result = await invoke(["receipts", "9001"], receiptReplies());
  assert.equal(result.code, 0, result.stderr);
  const [identity, receipt] = result.stdout.trim().split("\n");
  assert.deepEqual(JSON.parse(identity), {
    target: "supervisor",
    id: 9001,
    workflowId,
    ref: "sentinel-supervisor",
    sha,
    attempt: 2,
  });
  assert.equal(receipt, "hosted_runtime_terminal exact-bound-test-receipt");
  assert.match(
    result.calls,
    /run view 9001 -R Ubiquity-Sentinel\/sentinel --attempt 2 --log/,
  );
});

Deno.test("operator receipts reject wrong run, workflow, ref, source and attempt before logs", async (t) => {
  for (
    const [index, value] of [
      [0, { ...run, id: 9002 }],
      [0, { ...run, head_branch: "development" }],
      [0, { ...run, head_sha: "short" }],
      [1, { id: workflowId + 1, path: ".github/workflows/supervisor.yml" }],
      [1, { id: workflowId, path: ".github/workflows/foreign.yml" }],
      [2, { sha: "b".repeat(40) }],
      [3, { ...run, run_attempt: 1 }],
      [3, { ...run, head_sha: "b".repeat(40) }],
    ] as const
  ) {
    await t.step(`${index}:${JSON.stringify(value)}`, async () => {
      const replies = receiptReplies();
      replies[index] = { ...replies[index], value };
      const result = await invoke(["receipts", "9001"], replies);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.doesNotMatch(result.calls, /run view/);
    });
  }
});

Deno.test("operator receipt output retains its eighty-line bound and explicit pattern", async () => {
  const replies = receiptReplies();
  replies[4].value = Array.from(
    { length: 100 },
    (_, index) => `hosted_runtime_terminal ${index}`,
  ).join("\n");
  const bounded = await invoke(["receipts", "9001"], replies);
  assert.equal(bounded.code, 0, bounded.stderr);
  const lines = bounded.stdout.trim().split("\n");
  assert.equal(lines.length, 81);
  assert.equal(lines[1], "hosted_runtime_terminal 20");
  assert.equal(lines.at(-1), "hosted_runtime_terminal 99");
  replies[4].value = "hosted_runtime_terminal hidden\ncustom-pattern selected";
  const filtered = await invoke([
    "receipts",
    "9001",
    "--grep",
    "custom-pattern",
  ], replies);
  assert.equal(filtered.code, 0, filtered.stderr);
  assert.equal(
    filtered.stdout.trim().split("\n")[1],
    "custom-pattern selected",
  );
});

Deno.test("operator status JSON remains read-only across all three targets", async () => {
  const fields = "databaseId,status,conclusion,createdAt,event,headSha,url";
  const observation = {
    databaseId: 9001,
    status: "completed",
    conclusion: "success",
    createdAt: "2026-10-13T00:00:00Z",
    event: "workflow_dispatch",
    headSha: sha,
    url: "https://github.com/Ubiquity-Sentinel/sentinel/actions/runs/9001",
  };
  const replies = [
    ...["observe.yml", "supervisor.yml", "repair.yml"].map((workflow) => ({
      command:
        `run list -R ${repository} --workflow ${workflow} --limit 3 --json ${fields}`,
      value: [observation],
    })),
    {
      command:
        `pr list -R ${repository} --state merged --limit 5 --json number,mergedAt,author`,
      value: [],
    },
  ];
  const result = await invoke(["status", "--json"], replies);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(Object.keys(JSON.parse(result.stdout).runs), [
    "observe",
    "supervisor",
    "repair",
  ]);
  assert.doesNotMatch(result.calls, /--method POST|dispatches|run view/);
});

Deno.test("operator nonce pending acceptance progresses through exact run wait and receipts", async () => {
  const replies = dispatchReplies([run]);
  replies[6].sequence = [[{ total_count: 0, workflow_runs: [] }], [{
    total_count: 1,
    workflow_runs: [run],
  }]];
  const result = await invoke([
    "wait",
    "supervisor",
    "--dispatch",
    "--timeout-min",
    "0.05",
  ], replies);
  assert.equal(result.code, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.execution, "verified");
  assert.equal(observed.status, "completed");
  assert.equal(observed.conclusion, "success");
  assert.equal(observed.id, 9001);
  assert.equal(observed.requestId, result.state.nonce);
  const receipt = await invoke(
    ["receipts", String(observed.id)],
    receiptReplies(),
  );
  assert.equal(receipt.code, 0, receipt.stderr);
  assert.equal(
    JSON.parse(receipt.stdout.split("\n")[0]).attempt,
    observed.attempt,
  );
});

Deno.test("operator nonce refuses incompatible source and ref movement before posting", async (t) => {
  for (const mode of ["incompatible", "integrity", "changed"]) {
    await t.step(mode, async () => {
      const replies = dispatchReplies([run]);
      if (mode === "incompatible") {
        replies[4].value = contents(
          protocol.replace("sentinel_dispatch_request:", "unrelated_input:"),
        );
      } else if (mode === "integrity") {
        replies[4].value = { ...contents(protocol), sha: "b".repeat(40) };
      } else {replies[1].sequence = [replies[1].value, {
          ref: "refs/heads/sentinel-supervisor",
          object: { type: "commit", sha: "b".repeat(40) },
        }];}
      const result = await invoke(["dispatch", "supervisor"], replies);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.doesNotMatch(result.calls, /--method POST/);
    });
  }
});

Deno.test("operator nonce refuses source movement after accepted POST", async () => {
  const replies = dispatchReplies([run]);
  replies[1].sequence = [replies[1].value, replies[1].value, {
    ref: "refs/heads/sentinel-supervisor",
    object: { type: "commit", sha: "b".repeat(40) },
  }];
  assert.equal(
    assertUnverified(await invoke(["dispatch", "supervisor"], replies)).reason,
    "source_changed",
  );
});

Deno.test("operator nonce checks later pages and refuses incomplete pagination", async (t) => {
  for (const complete of [true, false]) {
    await t.step(String(complete), async () => {
      const replies = dispatchReplies([run]);
      replies[6].value = [{ total_count: 2, workflow_runs: [run] }];
      if (complete) {
        (replies[6].value as unknown[]).push({
          total_count: 2,
          workflow_runs: [{ ...run, id: 9002 }],
        });
      }
      const observed = assertUnverified(
        await invoke(["dispatch", "supervisor"], replies),
      );
      assert.equal(
        observed.reason,
        complete ? "multiple_matching_runs" : "run_observation_incomplete",
      );
    });
  }
});

Deno.test("operator nonce refuses a changed current native attempt", async () => {
  const replies = dispatchReplies([run]);
  replies[8].value = { ...run, run_attempt: 3 };
  assert.equal(
    assertUnverified(await invoke(["dispatch", "supervisor"], replies)).reason,
    "run_identity_mismatch",
  );
});

Deno.test("operator nonce missing name and queued or failed run never pass bounded completion", async (t) => {
  for (const mode of ["missing", "queued", "failed", "complete"]) {
    await t.step(mode, async () => {
      const replies = dispatchReplies([{
        ...run,
        ...(mode === "missing" ? { display_title: undefined } : {}),
      }]);
      if (mode === "queued") {
        replies[7].value = { ...run, status: "queued", conclusion: null };
      }
      if (mode === "failed") {
        replies[7].value = { ...run, conclusion: "failure" };
      }
      const result = await invoke(
        ["run", "supervisor", "--timeout-min", "0"],
        replies,
      );
      assert.equal(result.code, mode === "complete" ? 0 : 1, result.stderr);
      const observed = JSON.parse(result.stdout);
      assert.equal(
        observed.execution,
        mode === "missing" ? "pending" : "verified",
      );
      assert.equal(observed.id, mode === "missing" ? undefined : 9001);
    });
  }
});

Deno.test("operator nonce wait deadline stops a stalled owned gh metadata process", async () => {
  const replies = dispatchReplies([run]);
  replies[6].delayMs = 5000;
  const result = await invoke(
    ["run", "supervisor", "--timeout-min", "0.02"],
    replies,
  );
  const observed = assertUnverified(result);
  assert.equal(observed.reason, "observation_unavailable");
  assert.equal(result.state.counts[runsCommand], 1);
});

Deno.test("operator nonce ambiguous submission preserves request identity without claiming acceptance", async () => {
  const replies = dispatchReplies([run]);
  replies[5].code = 1;
  const result = await invoke(["dispatch", "supervisor"], replies);
  assert.equal(result.code, 1);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.dispatch, "unavailable");
  assert.equal(observed.execution, "unverified");
  assert.equal(observed.requestId, result.state.nonce);
  assert.equal("id" in observed, false);
  assert.equal(result.state.counts[runsCommand], undefined);
});

Deno.test("operator nonce authenticates actual YAML bytes for all three operator targets", async (t) => {
  for (const target of ["supervisor", "observe", "repair"] as const) {
    await t.step(target, async () => {
      const id = {
        supervisor: workflowId,
        observe: 353743351,
        repair: 353743354,
      }[target];
      const ref = target === "supervisor"
        ? "sentinel-supervisor"
        : "development";
      const path = `.github/workflows/${target}.yml`;
      const text = await Deno.readTextFile(
        new URL(`../../${path}`, import.meta.url),
      );
      const native = {
        ...run,
        workflow_id: id,
        head_branch: ref,
        display_title: `sentinel-${target} request __NONCE__`,
      };
      const replies = dispatchReplies([native]).map((reply) => ({
        ...reply,
        command: reply.command.replaceAll("supervisor.yml", `${target}.yml`)
          .replaceAll(`/workflows/${workflowId}`, `/workflows/${id}`)
          .replaceAll("heads/sentinel-supervisor", `heads/${ref}`),
      }));
      replies[0].value = { id, path };
      replies[1].value = {
        ref: `refs/heads/${ref}`,
        object: { type: "commit", sha },
      };
      replies[4].value = contents(text, path);
      replies[7].value = native;
      replies[8].value = native;
      const result = await invoke(["dispatch", target], replies);
      assert.equal(result.code, 0, result.stderr);
      const observed = JSON.parse(result.stdout);
      assert.equal(observed.execution, "verified");
      assert.equal(observed.workflowId, id);
      assert.equal(observed.ref, ref);
      assert.equal(observed.requestId, result.state.nonce);
      assert.equal(result.state.body.ref, ref);
    });
  }
});
