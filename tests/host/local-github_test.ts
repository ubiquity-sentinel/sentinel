import assert from "node:assert/strict";
import {
  composeLocalGitHub,
  createLocalRepositoryConfig,
  LocalSessionTracker,
  readAuthenticatedLogin,
  refreshDevelopment,
  scopeLocalRepairIssues,
} from "../../src/host/local.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  type GitHubCooldownGateV1,
  type GitHubIssueV1,
  portError,
  portOk,
  type PortResultV1,
} from "../../src/contracts/ports.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { FakeClock, FakeGithub, MemoryState } from "../repair/helpers.ts";
import {
  gitRun,
  makeRemoteCtx,
  SHA1,
  T0,
  testGitEnv,
} from "../state/helpers.ts";
import {
  countingGate,
  GIT_FAILED_TEXT,
  POISON_OPTIONS,
  POISON_SCRATCH,
  POISON_SOURCE,
  seededState,
} from "./local-test-helpers.ts";

Deno.test(
  "local refresh: durable refusal and a throwing gate stop before any Git or network",
  async () => {
    const clock = new FakeClock(T0);
    const state = await seededState();
    const gate = new DurableGitHubCooldownGate({ state, clock });
    const recorded = await gate.recordRateLimit(0, {
      kind: "primary",
      observedAt: T0,
      retryNotBefore: T0 + 60_000,
      observationId: "b".repeat(64),
      fallback: false,
    });
    assert.equal(recorded.ok, true);

    // Refused admission: the static failure is thrown before any fetch, and
    // the poison paths never produce a SHA.
    await assert.rejects(
      refreshDevelopment(POISON_SOURCE, POISON_OPTIONS, POISON_SCRATCH, gate),
      (error: unknown) =>
        error instanceof Error && error.message.includes(GIT_FAILED_TEXT),
    );

    // A gate restarted from the same durable state refuses identically.
    const restarted = new DurableGitHubCooldownGate({ state, clock });
    await assert.rejects(
      refreshDevelopment(
        POISON_SOURCE,
        POISON_OPTIONS,
        POISON_SCRATCH,
        restarted,
      ),
      (error: unknown) =>
        error instanceof Error && error.message.includes(GIT_FAILED_TEXT),
    );

    // A gate that faults on its FIRST operation proves no Git command ran
    // before admission: the synthetic fault is the only observed error.
    const throwing: GitHubCooldownGateV1 = {
      beforeRequest: () => Promise.reject(new Error("synthetic gate fault")),
      recordRateLimit: () => Promise.resolve(portOk(undefined)),
    };
    await assert.rejects(
      refreshDevelopment(
        POISON_SOURCE,
        POISON_OPTIONS,
        POISON_SCRATCH,
        throwing,
      ),
      /synthetic gate fault/,
    );
  },
);

Deno.test(
  "local login: 429 Retry-After is persisted exactly once before the static failure and survives a restart",
  async () => {
    const clock = new FakeClock(T0);
    const state = await seededState();
    const events: string[] = [];
    const inner = new DurableGitHubCooldownGate({ state, clock });
    const http: HttpTransportV1 = () => {
      events.push("http");
      return Promise.resolve({
        status: 429,
        headers: new Headers({ "retry-after": "3600" }),
        bodyText: "",
      });
    };
    await assert.rejects(
      readAuthenticatedLogin(
        "dummy-token",
        http,
        countingGate(inner, events),
        clock,
      ),
      /authenticated GitHub login is unavailable/,
    );
    // Admission first, exactly one response, exactly one persistence.
    assert.deepEqual(events, [
      "beforeRequest:0",
      "http",
      "recordRateLimit:0",
    ]);

    // The persisted durable refusal survives a restarted gate: zero HTTP.
    const restarted = new DurableGitHubCooldownGate({ state, clock });
    let restartedHttp = 0;
    await assert.rejects(
      readAuthenticatedLogin(
        "dummy-token",
        () => {
          restartedHttp++;
          return Promise.resolve({
            status: 200,
            headers: new Headers(),
            bodyText: JSON.stringify({ login: "owner" }),
          });
        },
        restarted,
        clock,
      ),
      /authenticated GitHub login is unavailable/,
    );
    assert.equal(restartedHttp, 0);
  },
);

Deno.test(
  "local login: 403 primary reset is persisted before the static failure and survives a restart",
  async () => {
    const clock = new FakeClock(T0);
    const state = await seededState();
    const resetSeconds = Math.floor((T0 + 90_000) / 1000);
    const events: string[] = [];
    const inner = new DurableGitHubCooldownGate({ state, clock });
    const http: HttpTransportV1 = () => {
      events.push("http");
      return Promise.resolve({
        status: 403,
        headers: new Headers({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetSeconds),
        }),
        bodyText: "",
      });
    };
    await assert.rejects(
      readAuthenticatedLogin(
        "dummy-token",
        http,
        countingGate(inner, events),
        clock,
      ),
      /authenticated GitHub login is unavailable/,
    );
    assert.deepEqual(events, [
      "beforeRequest:0",
      "http",
      "recordRateLimit:0",
    ]);
    const read = await state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (read.ok && read.value.status === "found") {
      assert.equal(read.value.snapshot.githubCooldowns.length, 1);
      assert.equal(
        read.value.snapshot.githubCooldowns[0]?.installationId,
        0,
      );
      assert.equal(
        read.value.snapshot.githubCooldowns[0]?.retryNotBefore,
        resetSeconds * 1000,
      );
    }

    const restarted = new DurableGitHubCooldownGate({ state, clock });
    let restartedHttp = 0;
    await assert.rejects(
      readAuthenticatedLogin(
        "dummy-token",
        () => {
          restartedHttp++;
          return Promise.resolve({
            status: 200,
            headers: new Headers(),
            bodyText: JSON.stringify({ login: "owner" }),
          });
        },
        restarted,
        clock,
      ),
      /authenticated GitHub login is unavailable/,
    );
    assert.equal(restartedHttp, 0);
  },
);

Deno.test(
  "local login: failed or throwing persistence is a static failure with no follow-on request; generic 403 invents no throttle",
  async () => {
    const clock = new FakeClock(T0);
    const state = await seededState();

    // Generic 403 without a confirmed limit: classifier returns null, so
    // nothing is persisted and no throttle is invented.
    const genericEvents: string[] = [];
    const genericGate = countingGate(
      new DurableGitHubCooldownGate({ state, clock }),
      genericEvents,
    );
    let genericHttp = 0;
    await assert.rejects(
      readAuthenticatedLogin(
        "dummy-token",
        () => {
          genericHttp++;
          genericEvents.push("http");
          return Promise.resolve({
            status: 403,
            headers: new Headers(),
            bodyText: "",
          });
        },
        genericGate,
        clock,
      ),
      /authenticated GitHub login is unavailable/,
    );
    assert.equal(genericHttp, 1);
    assert.deepEqual(genericEvents, ["beforeRequest:0", "http"]);

    // Failed (returned) and throwing persistence: the confirmed response is
    // persisted exactly once, then the static failure is thrown and no
    // follow-on request is attempted.
    for (const mode of ["return", "throw"] as const) {
      const events: string[] = [];
      let httpCalls = 0;
      const failingState = {
        readRepair: state.readRepair.bind(state),
        readRelease: state.readRelease.bind(state),
        writeRepair: mode === "return"
          ? () =>
            Promise.resolve(
              portError("unavailable", "synthetic state failure"),
            )
          : () => {
            throw new Error("synthetic write fault");
          },
      };
      const failingGate = countingGate(
        new DurableGitHubCooldownGate({ state: failingState, clock }),
        events,
      );
      await assert.rejects(
        readAuthenticatedLogin(
          "dummy-token",
          () => {
            httpCalls++;
            events.push("http");
            return Promise.resolve({
              status: 429,
              headers: new Headers({ "retry-after": "3600" }),
              bodyText: "",
            });
          },
          failingGate,
          clock,
        ),
        /authenticated GitHub login is unavailable/,
        mode,
      );
      assert.equal(httpCalls, 1, mode);
      assert.deepEqual(events, [
        "beforeRequest:0",
        "http",
        "recordRateLimit:0",
      ], mode);
    }
  },
);

// ---------------------------------------------------------------------------
// Local issue scope: only actual coding tasks are admitted. The concrete port
// instance, its unrelated methods and the class `this` binding stay intact.
// ---------------------------------------------------------------------------

/** FakeGithub with injectable per-method faults; reuses every other method. */
class FaultyIssueGithub extends FakeGithub {
  listFault: PortResultV1<never> | null = null;
  readFault: PortResultV1<never> | null = null;
  override listOpenIssues(): Promise<PortResultV1<GitHubIssueV1[]>> {
    if (this.listFault !== null) return Promise.resolve(this.listFault);
    return super.listOpenIssues();
  }
  override readIssue(
    issueNumber: number,
  ): Promise<PortResultV1<GitHubIssueV1 | null>> {
    if (this.readFault !== null) return Promise.resolve(this.readFault);
    return super.readIssue(issueNumber);
  }
}

// Exact literals, deliberately not imported from the host module: the contract
// is these standalone first lines, so a typo in either copy must fail here.
const LOCAL_REPAIR_MARKER = "<!-- sentinel:repair -->";

const LOCAL_SKIP_MARKER = "<!-- sentinel:skip -->";

Deno.test(
  "local issue scope: every open issue is admitted unless it opts out",
  async () => {
    const github = new FakeGithub({
      openIssues: [
        { number: 1, body: `${LOCAL_REPAIR_MARKER}\n` },
        { number: 2, body: LOCAL_REPAIR_MARKER },
        { number: 3, body: "unmarked prose" },
        { number: 4, body: "" },
        { number: 5, body: "unmarked but labelled", labels: ["bug"] },
        { number: 6, body: `${LOCAL_SKIP_MARKER}\nskip me` },
        { number: 7, body: LOCAL_SKIP_MARKER },
        { number: 8, body: `${LOCAL_SKIP_MARKER}\r\nskip me` },
        { number: 9, body: `${LOCAL_SKIP_MARKER} extra\nnot a skip` },
        { number: 10, body: ` ${LOCAL_SKIP_MARKER}\nnot a skip` },
        { number: 11, body: `intro\n${LOCAL_SKIP_MARKER}\nnot a skip` },
        { number: 12, body: "skip by label", labels: ["sentinel:skip"] },
        {
          number: 13,
          body: "skip by mixed-case label",
          labels: ["Sentinel:Skip"],
        },
        {
          number: 14,
          body: `${LOCAL_SKIP_MARKER}\nskip by marker and label`,
          labels: ["sentinel:skip"],
        },
      ],
    });
    const scoped = scopeLocalRepairIssues(github);
    assert.equal(scoped, github, "the same concrete port instance is scoped");
    const listed = await scoped.listOpenIssues();
    assert.ok(listed.ok);
    assert.deepEqual(
      listed.ok ? listed.value.map((issue) => issue.number) : [],
      [1, 2, 3, 4, 5, 9, 10, 11],
    );
    assert.deepEqual(github.calls, ["listOpenIssues"]);
  },
);

Deno.test(
  "local issue scope: read re-check admits by default and nulls opt-outs",
  async () => {
    const plain: Partial<GitHubIssueV1> = {
      number: 11,
      body: "ordinary issue body",
    };
    const github = new FakeGithub({
      issues: [
        plain,
        { number: 12, body: "skipped upstream\n" },
      ],
    });
    const scoped = scopeLocalRepairIssues(github);
    const admitted = await scoped.readIssue(11);
    assert.ok(admitted.ok);
    assert.equal(admitted.value?.number, 11);
    assert.deepEqual(await scoped.readIssue(99), portOk(null));

    // The loop re-reads the real source before admission: adding the opt-out to
    // the FakeGithub record revokes eligibility instead of consuming budget.
    plain.body = `${LOCAL_SKIP_MARKER}\nnow skipped`;
    assert.deepEqual(await scoped.readIssue(11), portOk(null));
  },
);

Deno.test(
  "local issue scope: port errors pass through and other methods keep behavior",
  async () => {
    const github = new FaultyIssueGithub();
    const listFault = portError("rate_limited", "list fault");
    const readFault = portError("unavailable", "read fault");
    github.listFault = listFault;
    github.readFault = readFault;
    const scoped = scopeLocalRepairIssues(github);
    assert.equal(await scoped.listOpenIssues(), listFault);
    assert.equal(await scoped.readIssue(1), readFault);

    const other = new FakeGithub();
    const scopedOther = scopeLocalRepairIssues(other);
    const ref = await scopedOther.readRef("refs/heads/development");
    assert.ok(ref.ok, "an unrelated class method still works");
    assert.equal(ref.ok ? ref.value?.sha : null, SHA1);
    assert.deepEqual(other.calls, ["readRef:refs/heads/development"]);
  },
);

Deno.test(
  "base refresh fetches a newly advanced target base before integration",
  async () => {
    // The fixture root stays under the worktree so the registered read
    // permission covers it, and it is made absolute so nested Git children
    // never duplicate a relative path.
    const root = await Deno.realPath(
      await Deno.makeTempDir({ dir: ".", prefix: "sentinel-base-refresh-" }),
    );
    const env = testGitEnv(`${root}/home`);
    const mirror = `${root}/mirror`;
    const pullPath = "/repos/ubiquity-sentinel/sentinel/pulls/7";
    const refPath =
      "/repos/ubiquity-sentinel/sentinel/git/ref/heads/development";
    const trustedAuthor = "ubiquity-sentinel[bot]";
    const branch = "sentinel/repair-base-refresh";
    const requests: string[] = [];
    const admissions: number[] = [];
    // The API observation of the configured base. It is deliberately advanced
    // independently of the real remote branch below so a concurrent movement
    // can be exercised without a second fixture.
    let observedBase = "";
    try {
      await Deno.mkdir(`${root}/home`, { recursive: true });
      // The target's authenticated remote holds only the FIRST base.
      const remote = await makeRemoteCtx(root, env);
      await Deno.writeTextFile(`${remote.work}/base-0.txt`, "base-0\n");
      assert.equal((await gitRun(remote.work, ["add", "-A"], env)).ok, true);
      assert.equal(
        (await gitRun(remote.work, ["commit", "-q", "-m", "base 0"], env)).ok,
        true,
      );
      const base0 = (await gitRun(remote.work, ["rev-parse", "HEAD"], env))
        .stdout.trim();
      const firstPush = await gitRun(
        remote.work,
        ["push", "-q", "origin", "HEAD:refs/heads/development"],
        env,
      );
      assert.equal(firstPush.ok, true, firstPush.stderr);

      // The private mirror is prepared BEFORE the new base exists, and the
      // original candidate is produced locally on top of the first base.
      const cloned = await gitRun(root, [
        "clone",
        "-q",
        "--no-hardlinks",
        "--no-checkout",
        remote.bare,
        mirror,
      ], env);
      assert.equal(cloned.ok, true, cloned.stderr);
      assert.equal(
        (await gitRun(mirror, [
          "checkout",
          "-q",
          "-B",
          "development",
          base0,
        ], env)).ok,
        true,
      );
      assert.equal(
        (await gitRun(mirror, ["checkout", "-q", "-b", branch, base0], env))
          .ok,
        true,
      );
      await Deno.writeTextFile(`${mirror}/candidate.txt`, "candidate\n");
      assert.equal((await gitRun(mirror, ["add", "-A"], env)).ok, true);
      assert.equal(
        (await gitRun(mirror, ["commit", "-q", "-m", "candidate"], env)).ok,
        true,
      );
      const candidate = (await gitRun(mirror, ["rev-parse", "HEAD"], env))
        .stdout.trim();

      // The composed port's remote is the fixed GitHub URL. The fixture
      // rewrites exactly that URL to the local bare repository and refuses
      // every un-rewritten https transport, so no unexpected rewrite can
      // reach the network.
      assert.equal(
        (await gitRun(mirror, [
          "config",
          `url.file://${remote.bare}.insteadOf`,
          "https://github.com/ubiquity-sentinel/sentinel.git",
        ], env)).ok,
        true,
      );
      assert.equal(
        (await gitRun(mirror, ["config", "protocol.https.allow", "never"], env))
          .ok,
        true,
      );

      // The new base is created ONLY AFTER mirror preparation and is genuinely
      // absent from the mirror before the refresh runs.
      await Deno.writeTextFile(`${remote.work}/base-1.txt`, "base-1\n");
      assert.equal((await gitRun(remote.work, ["add", "-A"], env)).ok, true);
      assert.equal(
        (await gitRun(remote.work, ["commit", "-q", "-m", "base 1"], env)).ok,
        true,
      );
      const base1 = (await gitRun(remote.work, ["rev-parse", "HEAD"], env))
        .stdout.trim();
      const secondPush = await gitRun(
        remote.work,
        ["push", "-q", "origin", "HEAD:refs/heads/development"],
        env,
      );
      assert.equal(secondPush.ok, true, secondPush.stderr);
      observedBase = base1;
      assert.equal(
        (await gitRun(mirror, ["cat-file", "-e", `${base1}^{commit}`], env))
          .ok,
        false,
        "the newly advanced base must be absent before the refresh",
      );

      // THE production composition over the fixed repository identity, with
      // the exact hardcoded GitHub remote routed to the local fixture.
      const clock = new FakeClock(T0);
      const gate: GitHubCooldownGateV1 = {
        beforeRequest: (installationId) => {
          admissions.push(installationId);
          return Promise.resolve(portOk(undefined));
        },
        recordRateLimit: () => Promise.resolve(portOk(undefined)),
      };
      const stateRoot = `${root}/state`;
      await Deno.mkdir(stateRoot, { recursive: true });
      const http: HttpTransportV1 = (request) => {
        const path = new URL(request.url).pathname;
        requests.push(`${request.method} ${path}`);
        if (request.method === "GET" && path.endsWith("/pulls/7")) {
          return Promise.resolve({
            status: 200,
            headers: new Headers(),
            bodyText: JSON.stringify({
              number: 7,
              title: "Sentinel repair",
              body: "Refs 264",
              state: "open",
              head: { ref: branch, sha: candidate },
              base: { ref: "development", sha: observedBase },
              user: { login: trustedAuthor },
              created_at: "2026-09-22T00:00:00Z",
              updated_at: "2026-09-22T00:00:00Z",
              merged_at: null,
              merge_commit_sha: null,
              review_decision: "none",
            }),
          });
        }
        if (
          request.method === "GET" &&
          path.endsWith("/git/ref/heads/development")
        ) {
          return Promise.resolve({
            status: 200,
            headers: new Headers(),
            bodyText: JSON.stringify({
              ref: "refs/heads/development",
              object: { sha: observedBase, type: "commit" },
            }),
          });
        }
        return Promise.reject(new Error(`unscripted request: ${path}`));
      };
      const compose = (name: string) =>
        composeLocalGitHub({
          clock,
          state: new MemoryState(),
          gate,
          http,
          token: "dummy-token",
          login: trustedAuthor,
          invocationId: "base-refresh-composition",
          stateRoot,
          sourcePath: mirror,
          scratch: `${root}/scratch`,
          reviewCheckout: `${root}/review`,
          reviewClientHome: `${root}/clients`,
          reviewTmpDir: `${root}/tmp`,
          reviewDenoDir: `${root}/deno`,
          trustedPath: Deno.env.get("PATH") ?? "/usr/bin:/bin",
          codexExecutable: "/usr/bin/false",
          tracker: new LocalSessionTracker(),
          repository: { ...createLocalRepositoryConfig().repository, name },
          baseBranch: "development",
        });
      const prepare = compose("sentinel").prepareBaseRefresh;
      assert.ok(
        prepare !== undefined,
        "the composed port carries the base-refresh capability",
      );
      if (prepare === undefined) return;
      const request = {
        pullRequestNumber: 7,
        branch,
        expectedHead: candidate as GitSha,
        previousBase: base0 as GitSha,
        expectedBase: base1 as GitSha,
      };

      // The refresh fetches the newly advanced base from THIS target's own
      // authenticated remote before the deterministic integration, and the
      // original candidate survives as the first parent.
      const prepared = await prepare(request);
      assert.equal(prepared.ok, true, JSON.stringify(prepared));
      if (!prepared.ok) return;
      const parents = (await gitRun(mirror, [
        "rev-list",
        "--parents",
        "-n",
        "1",
        prepared.value,
      ], env)).stdout.trim().split(" ");
      assert.deepEqual(parents, [prepared.value, candidate, base1]);
      assert.equal(
        (await gitRun(mirror, ["rev-parse", `${candidate}^{commit}`], env))
          .stdout.trim(),
        candidate,
        "the original candidate object is preserved",
      );
      assert.equal(
        (await gitRun(mirror, ["cat-file", "-e", `${base1}^{commit}`], env))
          .ok,
        true,
        "the newly advanced base is now local",
      );
      assert.ok(admissions.length > 0, "the shared cooldown gate was admitted");
      assert.ok(
        admissions.every((id) => id === 0),
        "every admission is scoped to this repository's installation",
      );
      assert.ok(requests.includes(`GET ${pullPath}`));
      assert.ok(requests.includes(`GET ${refPath}`));

      // A concurrent advance the API observation has not seen is a bounded
      // conflict: the fetched branch head is not the observed base, so nothing
      // is integrated and no unobserved base is adopted.
      await Deno.writeTextFile(`${remote.work}/base-2.txt`, "base-2\n");
      assert.equal((await gitRun(remote.work, ["add", "-A"], env)).ok, true);
      assert.equal(
        (await gitRun(remote.work, ["commit", "-q", "-m", "base 2"], env)).ok,
        true,
      );
      const thirdPush = await gitRun(
        remote.work,
        ["push", "-q", "origin", "HEAD:refs/heads/development"],
        env,
      );
      assert.equal(thirdPush.ok, true, thirdPush.stderr);
      const conflicted = await prepare(request);
      assert.equal(conflicted.ok, false);
      if (!conflicted.ok) {
        assert.equal(conflicted.error.kind, "conflict");
      }

      // A failed fetch fails closed: the fixed remote rewrite now points at an
      // absent fixture, and the adapter still observed the exact PR/base
      // first, so the refusal comes from the fetch step before integration.
      assert.equal(
        (await gitRun(mirror, [
          "config",
          `url.file://${remote.bare}.insteadOf`,
          `file://${root}/absent-target.git`,
        ], env)).ok,
        true,
      );
      const unavailable = await prepare(request);
      assert.equal(unavailable.ok, false);
      if (!unavailable.ok) {
        assert.equal(unavailable.error.kind, "unavailable");
      }

      // Own-repository scope: a port composed for another repository fetches
      // from THAT repository's own remote (routed here to its own local
      // fixture) and refuses a head that is not the observed base. The
      // un-rewritten https transport stays refused by the fixture policy.
      await Deno.mkdir(`${root}/foreign`, { recursive: true });
      const foreign = await makeRemoteCtx(`${root}/foreign`, env);
      await Deno.writeTextFile(`${foreign.work}/foreign.txt`, "foreign\n");
      assert.equal((await gitRun(foreign.work, ["add", "-A"], env)).ok, true);
      assert.equal(
        (await gitRun(foreign.work, ["commit", "-q", "-m", "foreign"], env))
          .ok,
        true,
      );
      const foreignBase = (await gitRun(foreign.work, [
        "rev-parse",
        "HEAD",
      ], env)).stdout.trim();
      const foreignPush = await gitRun(
        foreign.work,
        ["push", "-q", "origin", "HEAD:refs/heads/development"],
        env,
      );
      assert.equal(foreignPush.ok, true, foreignPush.stderr);
      assert.notEqual(foreignBase, base1);
      assert.equal(
        (await gitRun(mirror, [
          "config",
          `url.file://${foreign.bare}.insteadOf`,
          "https://github.com/ubiquity-sentinel/other.git",
        ], env)).ok,
        true,
      );
      const foreignPrepare = compose("other").prepareBaseRefresh;
      assert.ok(foreignPrepare !== undefined);
      if (foreignPrepare !== undefined) {
        const foreignRefused = await foreignPrepare(request);
        assert.equal(foreignRefused.ok, false);
        if (!foreignRefused.ok) {
          assert.equal(foreignRefused.error.kind, "conflict");
        }
      }
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
);
