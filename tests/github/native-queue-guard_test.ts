import assert from "node:assert/strict";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { GitHubBranchRuleWireV1 } from "../../src/github/wire.ts";
import { createNativeQueueGuard } from "../../src/github/native-queue-guard.ts";
import { createPrepareBaseRefresh } from "../../src/host/local-base-refresh.ts";
import { MemoryState } from "../repair/helpers.ts";
import { POLICY, SHA4 } from "../host/merge-queue-proof-fixtures.ts";
import { FakeGitExecutor, makePort } from "./helpers.ts";
import { completedCleanReceipt, mergeRequest } from "./merge-helpers.ts";
import {
  entryWire,
  PULL,
  QUEUE_REPO,
  response,
  SHA1,
  SHA2,
  SHA3,
} from "./merge-queue-fixtures.ts";
import {
  pullFactsWire,
  readerFixture,
  UNTIL,
} from "./queue-delivery-reader-fixtures.ts";

async function fixture() {
  const flags = {
    active: true,
    unavailable: false,
    member: false,
    merged: false,
    wrongHead: false,
    drift: false,
    rules: 0,
  };
  const base = await readerFixture({
    intercept: (request) => {
      if (request.url.endsWith("/graphql")) {
        return response(pullFactsWire({
          merged: flags.merged,
          mergeCommit: flags.merged ? { oid: SHA4 } : null,
          mergedBy: null,
          ...(flags.member
            ? {
              isInMergeQueue: true,
              mergeQueueEntry: entryWire({
                enqueuer: {
                  __typename: "User",
                  id: "USER_OWNER",
                  login: "owner",
                },
              }),
            }
            : {}),
          ...(flags.wrongHead ? { headRefOid: SHA3 } : {}),
        }));
      }
      return undefined;
    },
  });
  const state = new MemoryState();
  state.repair = base.snapshot;
  state.repairHead = SHA1;
  base.client.readBranchRules = () => {
    flags.rules++;
    return Promise.resolve(
      flags.unavailable
        ? portError("unavailable", "synthetic rule read failure")
        : portOk(
          flags.active
            ? [{ type: "merge_queue" } as GitHubBranchRuleWireV1]
            : [],
        ),
    );
  };
  const realReadPull = base.client.readQueuePull.bind(base.client);
  base.client.readQueuePull = async (...args) => {
    const result = await realReadPull(...args);
    if (flags.drift) state.repairHead = SHA3;
    return result;
  };
  const options = {
    repository: QUEUE_REPO,
    client: base.client,
    reader: base.reader,
    state,
    clock: base.clock,
    policy: POLICY,
    mode: "off" as const,
    proofActivated: false,
  };
  return {
    ...base,
    flags,
    state,
    options,
    guard: createNativeQueueGuard(options),
    inspect: {
      record: base.facts.record,
      operation: "publication" as const,
      deadline: UNTIL,
    },
  };
}

Deno.test("native queue: fresh no-rule dark path works without queue permission, unknown rules hold", async () => {
  const f = await fixture();
  f.flags.active = false;
  assert.deepEqual(await f.guard.inspect(f.inspect), {
    status: "allow",
    basis: "inactive_no_rule",
  });
  assert.equal(f.requests.length, 0, "no queue-permission query in dark state");
  f.flags.unavailable = true;
  assert.equal((await f.guard.inspect(f.inspect)).status, "hold");
  assert.equal(f.flags.rules, 2, "negative rule evidence is never cached");
});
Deno.test("native queue: owner entry after a long session blocks every mutation and resume", async () => {
  const f = await fixture();
  assert.equal((await f.guard.inspect(f.inspect)).status, "allow");
  f.clock.advance(29 * 60_000);
  f.flags.member = true;
  for (
    const operation of [
      "publication",
      "refresh",
      "conflict",
      "merge",
      "resume",
    ] as const
  ) {
    const decision = await f.guard.inspect({
      ...f.inspect,
      operation,
      deadline: f.clock.now() + 30_000,
    });
    assert.equal(decision.status, "hold", operation);
    if (decision.status === "hold") {
      assert.equal(
        decision.reason,
        operation === "merge" ? "queue_required" : "member",
      );
    }
  }
});
Deno.test("native queue: absent entry never authorizes a direct merge under effective queue rule", async () => {
  const f = await fixture();
  assert.deepEqual(
    await f.guard.inspect({ ...f.inspect, operation: "merge" }),
    { status: "hold", reason: "queue_required", pull: null },
  );
  assert.equal(f.requests.length, 0);
});
Deno.test("native queue: removed membership, mode off and old custody never release a retained hold", async () => {
  const f = await fixture();
  f.flags.active = false;
  for (
    const extra of [
      {
        wait: { reason: "backoff" as const, since: f.clock.now(), until: null },
      },
      {
        intent: {
          kind: "merge" as const,
          key: "merge-queue:v1:malformed",
          startedAt: f.clock.now(),
          branch: PULL.headRef,
          expectedHead: SHA2,
          observedBase: SHA1,
          pr: 7,
          requestId: null,
          resultId: null,
        },
      },
    ]
  ) {
    const record = { ...f.facts.record, ...extra };
    f.snapshot.work = [record];
    const result = await f.guard.inspect({ ...f.inspect, record });
    assert.equal(result.status, "hold");
    if (result.status === "hold") assert.equal(result.reason, "custody");
  }
  assert.equal(f.flags.rules, 0);
});
Deno.test("native queue: exact head, merged state and state CAS drift refuse native-absent grant", async (t) => {
  for (const flag of ["wrongHead", "merged", "drift"] as const) {
    await t.step(flag, async () => {
      const f = await fixture();
      f.flags[flag] = true;
      assert.equal((await f.guard.inspect(f.inspect)).status, "hold");
    });
  }
});
Deno.test("native queue: immutable proof activation survives lowering enqueue mode to off", async () => {
  const f = await fixture();
  f.flags.active = false;
  const guard = createNativeQueueGuard({ ...f.options, proofActivated: true });
  f.flags.member = true;
  assert.equal((await guard.inspect(f.inspect)).status, "hold");
  assert.ok(f.requests.some((request) => request.url.endsWith("/graphql")));
});
Deno.test("native queue: a genuinely PR-less operation ref may be preserved with complete empty discovery", async () => {
  const f = await fixture();
  f.client.listPullRequestsByHeadRef = () => Promise.resolve(portOk([]));
  assert.deepEqual(
    await f.guard.inspectEffect({
      operation: "publication",
      branch: `sentinel-candidates/${"a".repeat(64)}`,
      expectedHead: null,
      deadline: UNTIL,
    }),
    { status: "allow", basis: "native_absent" },
  );
  f.client.listPullRequestsByHeadRef = () => {
    f.state.repairHead = SHA3;
    return Promise.resolve(portOk([]));
  };
  assert.equal(
    (await f.guard.inspectEffect({
      operation: "publication",
      branch: "candidate",
      deadline: UNTIL,
    })).status,
    "hold",
    "empty discovery cannot authorize against changed authoritative state",
  );
  f.client.listPullRequestsByHeadRef = () =>
    Promise.resolve(portError("unavailable", "synthetic incomplete discovery"));
  assert.equal(
    (await f.guard.inspectEffect({
      operation: "publication",
      branch: "candidate",
      deadline: UNTIL,
    })).status,
    "hold",
  );
});
Deno.test("native queue: gateway ports without native capability have zero publication/merge effects", async () => {
  const git = new FakeGitExecutor();
  const { port, transport } = makePort({
    repository: QUEUE_REPO,
    nativeQueue: null,
    git,
  });
  assert.equal(
    (await port.pushHead("refs/heads/candidate", SHA2, null)).ok,
    false,
  );
  assert.equal(
    (await port.createPullRequest({
      headRef: "candidate",
      baseRef: "development",
      expectedBase: SHA1,
      expectedHeadRef: SHA2,
      title: "repair",
      body: "Resolves #1",
    })).ok,
    false,
  );
  assert.equal(
    (await port.mergePullRequest(
      mergeRequest({
        review: completedCleanReceipt({ repository: QUEUE_REPO }),
      }),
    )).ok,
    false,
  );
  assert.equal(git.pushes.length, 0);
  assert.equal(transport.requests.length, 0);
});
Deno.test("native queue: owner entry just before push prevents git mutation and already-advertised adoption", async () => {
  const f = await fixture();
  const git = new FakeGitExecutor();
  const ref = `refs/heads/${PULL.headRef}`;
  git.refs.set(ref, SHA2);
  git.isAncestor = () => {
    f.flags.member = true;
    return Promise.resolve(portOk(true));
  };
  const { port } = makePort({
    repository: QUEUE_REPO,
    nativeQueue: f.guard,
    git,
  });
  assert.equal((await port.pushHead(ref, SHA3, SHA2)).ok, false);
  assert.equal(git.pushes.length, 0);
  assert.equal(
    (await port.pushHead(ref, SHA2, SHA2)).ok,
    false,
    "equal advertised head is guarded too",
  );
});
Deno.test("native queue: owner entry after push leaves publication unconfirmed", async () => {
  const f = await fixture();
  const git = new FakeGitExecutor();
  const ref = `refs/heads/${PULL.headRef}`;
  git.refs.set(ref, SHA2);
  const originalPush = git.push.bind(git);
  git.push = async (...args) => {
    const result = await originalPush(...args);
    f.flags.member = true;
    return result;
  };
  const { port } = makePort({
    repository: QUEUE_REPO,
    nativeQueue: f.guard,
    git,
  });
  assert.equal((await port.pushHead(ref, SHA3, SHA2)).ok, false);
  assert.equal(git.pushes.length, 1);
});
Deno.test("native queue: final refresh read prevents integration after owner enqueue during object restoration", async () => {
  const f = await fixture();
  let integrations = 0;
  const git = new FakeGitExecutor();
  const refresh = createPrepareBaseRefresh({
    repository: QUEUE_REPO,
    clock: f.clock,
    git: {
      ...git,
      isAncestor: git.isAncestor.bind(git),
      readRemoteRef: git.readRemoteRef.bind(git),
      push: git.push.bind(git),
      integrateBase: () => {
        integrations++;
        return Promise.resolve(portOk(SHA3));
      },
    },
    observer: {
      nativeQueue: f.guard,
      readPullRequest: () =>
        Promise.resolve(portOk({
          number: 7,
          title: "repair",
          body: "Resolves #1",
          state: "open",
          head: SHA2,
          base: SHA1,
          mergeSha: null,
          headRef: PULL.headRef,
          baseRef: "development",
          author: "publisher",
          createdAt: f.clock.now(),
          updatedAt: f.clock.now(),
          mergedAt: null,
          reviewDecision: "none",
        })),
      readRef: () =>
        Promise.resolve(portOk({ ref: "refs/heads/development", sha: SHA3 })),
    },
    baseBranch: "development",
    trustedPrAuthor: "publisher",
    ensureBaseObjects: () => {
      f.flags.member = true;
      return Promise.resolve(portOk(undefined));
    },
  });
  assert.equal(
    (await refresh({
      pullRequestNumber: 7,
      branch: PULL.headRef,
      expectedHead: SHA2,
      previousBase: SHA1,
      expectedBase: SHA3,
    })).ok,
    false,
  );
  assert.equal(integrations, 0);
});
Deno.test("native queue: dark delivery grants full immutable binding, activation/queue rule cannot fall back", async () => {
  const f = await fixture();
  f.flags.active = false;
  f.client.readQueueLegacyPull = () =>
    Promise.resolve({
      status: "complete",
      value: {
        mergedBy: {
          type: "Bot",
          nodeId: "BOT_7",
          login: "ubiquity-sentinel[bot]",
        },
        pull: {
          number: 7,
          title: "repair",
          body: "Resolves #1",
          state: "merged",
          head: SHA2,
          base: SHA1,
          mergeSha: SHA4,
          headRef: PULL.headRef,
          baseRef: "development",
          author: "ubiquity-sentinel[bot]",
          createdAt: f.clock.now(),
          updatedAt: f.clock.now(),
          mergedAt: f.clock.now(),
          reviewDecision: "none",
        },
      },
    });
  const request = {
    record: f.facts.record,
    receipt: f.facts.receipt,
    revision: SHA4,
    deadline: UNTIL,
  };
  const grant = await f.guard.proveDelivery(request);
  assert.deepEqual(grant, {
    status: "legacy_direct",
    binding: f.facts.binding,
    revision: SHA4,
  });
  assert.ok(f.requests.every((request) => !request.url.endsWith("/graphql")));
  f.flags.active = true;
  assert.notEqual(
    (await f.guard.proveDelivery(request)).status,
    "legacy_direct",
  );
  f.flags.active = false;
  const activated = createNativeQueueGuard({
    ...f.options,
    proofActivated: true,
  });
  assert.notEqual(
    (await activated.proveDelivery(request)).status,
    "legacy_direct",
  );
});
