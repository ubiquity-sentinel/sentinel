import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portError } from "../../src/contracts/ports.ts";
import { composeLocalGitHub } from "../../src/host/local-github.ts";
import { LocalSessionTracker } from "../../src/host/local-client.ts";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import { createTargetConfigV1 } from "../../src/host/targets.ts";
import { candidatePreservationRef } from "../../src/repair/keys.ts";
import { FakeClock, MemoryState } from "../repair/helpers.ts";
import { T0 } from "../state/helpers.ts";
import { membershipWire } from "../github/merge-queue-fixtures.ts";
import {
  BRANCH,
  candidateRecord,
  FakeGate,
  gitRun,
  makeCandidateCtx,
  snapshot,
  TRUSTED_PATH,
} from "./actions-candidates-fixture.ts";
import {
  CANDIDATE_OPERATION_KEY,
  CANDIDATE_TASK_ID,
  PRESERVATION_ID,
  submittedReservation,
} from "./actions-candidates-preservation-fixture.ts";

Deno.test("target policy: composed gateway candidate preserver rejects deployment authority before publication", async () => {
  const ctx = await makeCandidateCtx();
  try {
    const sourcePath = `${ctx.tmp}/work`;
    // Give every configured protected ancestor a stable base directory. A
    // missing-directory setup refusal must not masquerade as deployment-path
    // protection; the baseline must reach the fake publication effect.
    const config = createTargetConfigV1(createLocalRepositoryConfig(), {
      slug: "ubiquity/ai.ubq.fi",
      owner: "ubiquity",
      name: "ai.ubq.fi",
    }, "development");
    const ancestors = new Set<string>();
    for (const path of config.protectedPaths) {
      const segments = path.replace(/\/$/, "").split("/");
      for (let length = 1; length < segments.length; length++) {
        ancestors.add(segments.slice(0, length).join("/"));
      }
    }
    for (const path of ancestors) {
      await Deno.mkdir(`${sourcePath}/${path}`, { recursive: true });
      await Deno.writeTextFile(
        `${sourcePath}/${path}/.fixture-directory`,
        "stable fixture ancestor\n",
      );
    }
    await Deno.mkdir(`${sourcePath}/ops`, { recursive: true });
    await Deno.writeTextFile(
      `${sourcePath}/ops/existing.ts`,
      "export const trusted = 1;\n",
    );
    assert.equal((await gitRun(sourcePath, ["add", "-A"], ctx.env)).ok, true);
    assert.equal(
      (await gitRun(sourcePath, [
        "commit",
        "-q",
        "-m",
        "base already owns ops directory",
      ], ctx.env)).ok,
      true,
    );
    ctx.base = (await gitRun(sourcePath, ["rev-parse", "HEAD"], ctx.env)).stdout
      .trim() as GitSha;
    await Deno.writeTextFile(
      `${sourcePath}/ops/deploy.ts`,
      "export const candidate = 1;\n",
    );
    assert.equal(
      (await gitRun(sourcePath, ["add", "ops/deploy.ts"], ctx.env)).ok,
      true,
    );
    assert.equal(
      (await gitRun(sourcePath, [
        "commit",
        "-q",
        "-m",
        "candidate changes deploy authority",
      ], ctx.env)).ok,
      true,
    );
    const head = (await gitRun(sourcePath, ["rev-parse", "HEAD"], ctx.env))
      .stdout.trim() as GitSha;
    const repository = {
      owner: "ubiquity",
      name: "ai.ubq.fi",
      installationId: 155_687_488,
    };
    const ref = await candidatePreservationRef(
      repository,
      CANDIDATE_TASK_ID,
      CANDIDATE_OPERATION_KEY,
    );
    const candidate = {
      operationKey: CANDIDATE_OPERATION_KEY,
      base: ctx.base,
      head,
      ref,
    };
    const record = candidateRecord(ctx, {
      repository,
      target: {
        base: ctx.base,
        branch: BRANCH,
        checkpoint: null,
        head,
        pr: 12,
        candidateState: { preserved: null, publishedHead: null },
      },
      intent: {
        kind: "candidate_preservation",
        key: CANDIDATE_OPERATION_KEY,
        startedAt: T0,
        branch: ref,
        expectedHead: head,
        observedBase: ctx.base,
        pr: null,
        requestId: PRESERVATION_ID,
        resultId: null,
      },
    });
    const state = new MemoryState();
    state.repair = snapshot([record], [
      submittedReservation(record, { repository }),
    ]);
    const before = structuredClone(state.repair);
    const reads: string[] = [];
    const gate = new FakeGate();
    const port = composeLocalGitHub({
      clock: new FakeClock(T0),
      state,
      gate,
      http: (request) => {
        const path = new URL(request.url).pathname;
        reads.push(`${request.method} ${path}`);
        if (path === "/graphql") {
          assert.equal(request.method, "POST");
          const query = JSON.parse(request.body ?? "{}");
          assert.match(query.query, /^query\(/);
          assert.match(query.query, /pullRequest\(number:\$number\)/);
          assert.deepEqual(query.variables, {
            owner: repository.owner,
            name: repository.name,
            number: record.target.pr,
          });
          return Promise.resolve({
            status: 200,
            headers: new Headers(),
            bodyText: JSON.stringify(membershipWire(null, {
              id: "PR_12",
              number: record.target.pr,
              headRefName: record.target.branch,
              headRefOid: head,
              baseRefOid: ctx.base,
              author: {
                __typename: "Bot",
                id: "BOT_SYNTHETIC_AUTHOR",
                login: "ubiquity-sentinel[bot]",
              },
              mergedBy: null,
            })),
          });
        }
        assert.equal(request.method, "GET");
        if (path === "/repos/ubiquity/ai.ubq.fi/rules/branches/development") {
          return Promise.resolve({
            status: 200,
            headers: new Headers(),
            bodyText: "[]",
          });
        }
        assert.ok(path.startsWith("/repos/ubiquity/ai.ubq.fi/git/ref/"));
        return Promise.resolve({
          status: 404,
          headers: new Headers(),
          bodyText: "",
        });
      },
      token: "dummy-token",
      login: "ubiquity-sentinel[bot]",
      invocationId: "target-policy",
      stateRoot: ctx.tmp,
      sourcePath,
      scratch: `${ctx.tmp}/home`,
      reviewCheckout: `${ctx.tmp}/review`,
      reviewClientHome: `${ctx.tmp}/clients`,
      reviewTmpDir: `${ctx.tmp}/tmp`,
      reviewDenoDir: `${ctx.tmp}/deno`,
      trustedPath: TRUSTED_PATH,
      codexExecutable: "/usr/bin/false",
      tracker: new LocalSessionTracker(),
      repository,
      baseBranch: "development",
    });
    let publicationCalls = 0;
    // Exact production preserver; only the external publication effect is
    // replaced, so a broken protection cannot reach any network transport.
    port.pushHead = () => {
      publicationCalls++;
      return Promise.resolve(
        portError("unavailable", "fixture refuses publication"),
      );
    };
    const result = await port.preserveCandidate!({
      taskId: CANDIDATE_TASK_ID,
      candidate,
      publishedHead: null,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.kind, "invalid", JSON.stringify(result));
      assert.match(
        result.error.detail ?? "",
        /protected/i,
        JSON.stringify(result),
      );
    }
    assert.equal(publicationCalls, 0);
    assert.deepEqual(reads, [
      "GET /repos/ubiquity/ai.ubq.fi/rules/branches/development",
      `GET /repos/ubiquity/ai.ubq.fi/git/ref/${ref.slice("refs/".length)}`,
    ]);
    assert.deepEqual(
      state.repair,
      before,
      "protection never rewrites authoritative state",
    );
    assert.ok(
      gate.admissions.every((scope) => scope === repository.installationId),
    );
  } finally {
    await ctx.cleanup();
  }
});
