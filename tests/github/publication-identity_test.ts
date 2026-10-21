import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { DenoGitExecutor } from "../../src/github/git-executor.ts";
import {
  httpRespond,
  issueWire,
  makePort,
  pullWire,
  refWire,
  SHA1,
  SHA2,
  SHA3,
} from "./helpers.ts";
import type { ScriptEntry } from "./helpers.ts";

const request = {
  title: "fix the bug",
  headRef: "sentinel/fix-1",
  baseRef: "development",
  body: "Resolves #123",
  expectedBase: SHA2,
  expectedHeadRef: SHA1,
};

Deno.test("publication identity: create, reuse and ambiguous discovery bind the request", async (t) => {
  const mismatches: { name: string; overrides: Record<string, unknown> }[] = [
    { name: "head", overrides: { head: { ref: request.headRef, sha: SHA3 } } },
    { name: "author", overrides: { user: { login: "octocat" } } },
    {
      name: "base branch",
      overrides: { base: { ref: "another-base", sha: SHA2 } },
    },
    { name: "closing link", overrides: { body: "Resolves #456" } },
  ];
  for (const mode of ["create", "reuse", "ambiguous"] as const) {
    for (const mismatch of mismatches) {
      await t.step(`${mode}: ${mismatch.name}`, async () => {
        const observed = pullWire({
          body: request.body,
          ...mismatch.overrides,
        });
        const script: ScriptEntry[] = [
          httpRespond(
            "GET",
            "/git/ref/heads/sentinel/fix-1",
            200,
            refWire(SHA1),
          ),
          httpRespond(
            "GET",
            "/pulls?head=",
            200,
            mode === "reuse" ? [observed] : [],
          ),
        ];
        if (mode === "create") {
          script.push(
            httpRespond(
              "POST",
              "/repos/Ubiquity-Sentinel/sentinel/pulls",
              201,
              observed,
            ),
          );
        } else if (mode === "ambiguous") {
          script.push({
            kind: "throw",
            method: "POST",
            urlPart: "/repos/Ubiquity-Sentinel/sentinel/pulls",
          });
          script.push(httpRespond("GET", "/pulls?head=", 200, [observed]));
        }
        const { port, transport } = makePort({ script });
        const result = await port.createPullRequest(request);
        assert.equal(
          result.ok,
          false,
          "mismatched publication cannot be acknowledged",
        );
        if (!result.ok) assert.equal(result.error.kind, "conflict");
        assert.equal(
          transport.requests.filter((call) => call.method === "POST").length,
          mode === "reuse" ? 0 : 1,
        );
      });
    }
  }
  for (
    const [name, overrides] of [
      ["head branch", { head: { ref: "foreign/other", sha: SHA1 } }],
      ["closed PR", { state: "closed" }],
      ["merged PR", {
        state: "closed",
        merged_at: "2026-09-07T02:00:00Z",
        merge_commit_sha: SHA3,
      }],
    ] as const
  ) {
    await t.step(`create: ${name}`, async () => {
      const { port } = makePort({
        script: [
          httpRespond(
            "GET",
            "/git/ref/heads/sentinel/fix-1",
            200,
            refWire(SHA1),
          ),
          httpRespond("GET", "/pulls?head=", 200, []),
          httpRespond(
            "POST",
            "/repos/Ubiquity-Sentinel/sentinel/pulls",
            201,
            pullWire({ body: request.body, ...overrides }),
          ),
        ],
      });
      const result = await port.createPullRequest(request);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.kind, "conflict");
    });
  }
});

Deno.test("closure identity: initial, successful and ambiguous observations bind the issue", async (t) => {
  for (const state of ["open", "closed"] as const) {
    await t.step(`initial mismatched ${state} issue`, async () => {
      const { port, transport } = makePort({
        script: [
          httpRespond(
            "GET",
            "/issues/7",
            200,
            issueWire({
              number: 8,
              state,
              closed_at: state === "closed" ? "2026-09-07T02:00:00Z" : null,
            }),
          ),
        ],
      });
      const result = await port.closeIssue(7);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.kind, "conflict");
      assert.equal(
        transport.requests.filter((call) => call.method === "PATCH").length,
        0,
      );
    });
  }
  for (const mode of ["success", "ambiguous"] as const) {
    await t.step(`${mode}: response names another issue`, async () => {
      const wrong = issueWire({
        number: 8,
        state: "closed",
        closed_at: "2026-09-07T02:00:00Z",
      });
      const script: ScriptEntry[] = [
        httpRespond("GET", "/issues/7", 200, issueWire({ number: 7 })),
      ];
      if (mode === "success") {
        script.push(httpRespond("PATCH", "/issues/7", 200, wrong));
      } else {
        script.push({ kind: "throw", method: "PATCH", urlPart: "/issues/7" });
        script.push(httpRespond("GET", "/issues/7", 200, wrong));
      }
      const { port, transport } = makePort({ script });
      const result = await port.closeIssue(7);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(
          result.error.kind,
          mode === "success" ? "conflict" : "unavailable",
        );
      }
      assert.equal(
        transport.requests.filter((call) => call.method === "PATCH").length,
        1,
      );
    });
  }
});

Deno.test("publication identity: real Git candidate survives a rejected API identity", async () => {
  const tmp = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-publication-identity-",
  });
  const work = `${tmp}/work`;
  const remote = `${tmp}/remote.git`;
  const git = async (args: string[]): Promise<string> => {
    const result = await new Deno.Command("git", {
      args: [
        "-c",
        "user.name=Identity regression",
        "-c",
        "user.email=identity@example.test",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      clearEnv: true,
      env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  };
  try {
    await git(["init", "-q", "--bare", remote]);
    await git(["init", "-q", "-b", "development", work]);
    await Deno.writeTextFile(`${work}/value.ts`, "export const value = 0;\n");
    await git(["-C", work, "add", "value.ts"]);
    await git(["-C", work, "commit", "-q", "-m", "base"]);
    const base = await git(["-C", work, "rev-parse", "HEAD"]) as GitSha;
    await Deno.writeTextFile(`${work}/value.ts`, "export const value = 1;\n");
    await git(["-C", work, "commit", "-q", "-am", "candidate"]);
    const head = await git(["-C", work, "rev-parse", "HEAD"]) as GitSha;
    const executor = new DenoGitExecutor({ localDir: work, remoteUrl: remote });
    const exactRequest = {
      ...request,
      expectedBase: base,
      expectedHeadRef: head,
    };
    const observed = {
      head: { ref: request.headRef, sha: head },
      base: { ref: request.baseRef, sha: base },
    };
    const publicationScript = (body: string): ScriptEntry[] => [
      httpRespond("GET", "/git/ref/heads/sentinel/fix-1", 200, refWire(head)),
      httpRespond("GET", "/pulls?head=", 200, []),
      httpRespond(
        "POST",
        "/repos/Ubiquity-Sentinel/sentinel/pulls",
        201,
        pullWire({ ...observed, body }),
      ),
    ];
    const bad = makePort({
      git: executor,
      script: publicationScript("Resolves #456"),
    });
    const pushed = await bad.port.pushHead("heads/sentinel/fix-1", head, null);
    assert.deepEqual(pushed, { ok: true, value: "applied" });
    const refused = await bad.port.createPullRequest(exactRequest);
    assert.equal(
      refused.ok,
      false,
      "a durable candidate cannot acknowledge the wrong closing link",
    );
    const preserved = await executor.readRemoteRef("heads/sentinel/fix-1");
    assert.deepEqual(preserved, { ok: true, value: head });
    const good = makePort({
      git: executor,
      script: publicationScript(request.body),
    });
    const accepted = await good.port.createPullRequest(exactRequest);
    assert.deepEqual(accepted, {
      ok: true,
      value: { outcome: "applied", number: 1, head },
    });
    assert.equal(
      bad.transport.requests.filter((call) => call.method === "POST").length,
      1,
    );
    assert.equal(
      good.transport.requests.filter((call) => call.method === "POST").length,
      1,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
