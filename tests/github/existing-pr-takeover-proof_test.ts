import assert from "node:assert/strict";
import { portError } from "../../src/contracts/ports.ts";
import type { TakeoverCustodyProof } from "../../src/contracts/existing-pr-takeover.ts";
import type { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { createTakeoverProofPort } from "../../src/github/existing-pr-takeover-proof.ts";
import {
  readTakeoverAnchor,
  takeoverProvenanceRef,
} from "../../src/github/existing-pr-takeover-provenance.ts";
import {
  gen80Available,
  loadGen80Modules,
} from "../host/gen77-runtime-source.ts";
import { makeRig } from "../repair/loop-rig.ts";
import { SHA1, SHA2, SHA3 } from "../state/helpers.ts";
import {
  CURRENT,
  NEXT,
  takeoverFixture,
} from "./existing-pr-takeover-fixtures.ts";

Deno.test("takeover proof: actual native custody permits only its exact single-use operation", async () => {
  const rig = await takeoverFixture();
  const resolved = await rig.port.resolve(rig.request);
  assert.ok(resolved.ok);
  assert.equal(Object.isFrozen(resolved.value), true);
  assert.equal(
    (await rig.port.authorizeEffect(resolved.value, rig.request)).ok,
    true,
  );
  assert.equal(
    (await rig.port.authorizeEffect(resolved.value, rig.request)).ok,
    false,
  );
  assert.equal(
    rig.request.record.target.candidateState?.preserved,
    null,
    "no invented implementation descriptor",
  );
  assert.equal(
    rig.request.snapshot.reservations.length,
    0,
    "custody is not a model start",
  );
  assert.equal(
    rig.request.snapshot.reviews.length,
    0,
    "custody is not a review verdict",
  );
});

Deno.test("takeover proof: source activation and exact runtime fence are independent mandatory gates", async () => {
  const rig = await takeoverFixture();
  const { policy: _, ...withoutPolicy } = rig.deps;
  assert.equal(
    (await createTakeoverProofPort(withoutPolicy).resolve(rig.request)).ok,
    false,
  );
  rig.policy.activated = false;
  assert.equal((await rig.port.resolve(rig.request)).ok, false);
  rig.policy.activated = true;
  rig.denyFence();
  assert.equal((await rig.port.resolve(rig.request)).ok, false);
});

Deno.test("takeover proof: native association and ownership faults cannot authorize other work", async (t) => {
  const changes: [
    string,
    (r: Awaited<ReturnType<typeof takeoverFixture>>) => void,
  ][] = [
    ["explicit reference without native association", (r) => {
      r.native.associated = false;
    }],
    ["no reciprocal native link", (r) => {
      r.native.reciprocalIssues = [];
    }],
    ["truncated reciprocal links", (r) => {
      r.native.reciprocalComplete = false;
    }],
    ["reciprocal number without exact native node", (r) => {
      r.native.reciprocalIssues = [{
        number: 1,
        nodeId: "I_other",
        repository: r.native.binding.headRepository,
      }];
    }],
    ["PR already owned by another task", (r) => {
      const other = structuredClone(r.request.record);
      other.id = "other-task" as typeof other.id;
      r.request.snapshot.work.push(other);
    }],
    ["truncated native association", (r) => {
      r.native.associationComplete = false;
    }],
    ["two open candidates", (r) => {
      r.native.openCandidates = [...r.native.openCandidates, {
        number: 1000,
        nodeId: "PR_other",
      }];
    }],
    ["different native node", (r) => {
      r.native.binding.pullNodeId = "PR_replaced";
    }],
    ["changed source statement", (r) => {
      r.native.binding.issueDigest = "a".repeat(64);
    }],
    ["changed author", (r) => {
      r.native.binding.author = "someone-else";
    }],
    ["other task", (r) => {
      r.native.binding.issueNumber = 2;
    }],
    ["different head repository", (r) => {
      r.native.binding.headRepository.name = "other";
    }],
    ["different head repository identity", (r) => {
      r.native.binding.headRepositoryId = "R_other";
    }],
    ["other configured base", (r) => {
      r.deps.baseBranch = "other";
    }],
    ["fork", (r) => {
      r.native.sameRepository = false;
    }],
    ["unwritable branch", (r) => {
      r.native.writableBranch = false;
    }],
    ["protected changed path", (r) => {
      r.native.protectedPathsClear = false;
    }],
    ["queue custody", (r) => {
      r.native.queueCustodyClear = false;
    }],
    ["deleted branch", (r) => {
      r.native.headRefExists = false;
    }],
    ["closed PR", (r) => {
      r.native.state = "closed";
    }],
    ["closed source", (r) => {
      r.native.issueOpen = false;
    }],
    ["head advanced", (r) => {
      r.native.head = NEXT;
    }],
    ["base advanced", (r) => {
      r.native.base = NEXT;
    }],
    ["unrestored candidate", (r) => {
      r.candidate.anchorRestored = false;
    }],
    ["wrong immutable ref", (r) => {
      r.candidate.anchorRef = "refs/heads/sentinel-candidates/" +
        "a".repeat(64);
    }],
    ["not an ancestor", (r) => {
      r.candidate.currentDescendsFromAnchor = false;
    }],
    ["missing state ancestor", (r) => {
      r.stateControl.ancestorAvailable = false;
    }],
    ["wrong state head", (r) => {
      r.stateControl.head = NEXT;
    }],
    ["source deadline during native read", (r) => {
      r.hooks.native = () => {
        r.clock.value = r.request.deadline;
      };
    }],
    ["state drift during Git read", (r) => {
      r.hooks.candidate = () => {
        r.stateControl.head = NEXT;
      };
    }],
  ];
  for (const [name, change] of changes) {
    await t.step(name, async () => {
      const rig = await takeoverFixture();
      change(rig);
      assert.equal((await rig.port.resolve(rig.request)).ok, false);
    });
  }
});

Deno.test("takeover proof: mutated, cloned, cross-factory, expired and replayed objects fail", async (t) => {
  for (
    const mode of [
      "clone",
      "forged",
      "factory",
      "operation",
      "deadline",
      "expired",
      "expired during authorization",
      "source changed",
      "fence lowered",
    ] as const
  ) {
    await t.step(mode, async () => {
      const rig = await takeoverFixture();
      const ready = await rig.port.resolve(rig.request);
      assert.ok(ready.ok);
      let proof: TakeoverCustodyProof = ready.value;
      let port = rig.port;
      if (mode === "clone") proof = structuredClone(proof);
      if (mode === "forged") proof = { kind: "verified_existing_pr_custody" };
      if (mode === "factory") port = createTakeoverProofPort(rig.deps);
      if (mode === "operation") rig.request.operation = "merge";
      if (mode === "deadline") rig.request.deadline++;
      if (mode === "expired") rig.clock.value += 30_000;
      if (mode === "expired during authorization") {
        rig.hooks.native = () => {
          rig.clock.value += 30_000;
        };
      }
      if (mode === "source changed") {
        rig.native.binding.issueDigest = "b".repeat(64);
      }
      if (mode === "fence lowered") rig.denyFence();
      assert.equal((await port.authorizeEffect(proof, rig.request)).ok, false);
    });
  }
});

Deno.test("takeover proof: publishing a real produced successor binds both candidate and current native head", async () => {
  const rig = await takeoverFixture();
  rig.request.operation = "publish";
  rig.request.nextHead = NEXT;
  rig.request.record.target.head = NEXT;
  rig.request.record.target.candidateState = {
    publishedHead: SHA3,
    preserved: {
      operationKey: "impl:" + "a".repeat(64),
      base: SHA1,
      head: NEXT,
      ref: "refs/heads/sentinel-candidates/" + "b".repeat(64),
    },
  };
  rig.candidate.currentHead = NEXT;
  rig.candidate.nextHead = NEXT;
  rig.candidate.nextDescendsFromExpected = true;
  assert.equal(
    (await rig.port.resolve(rig.request)).ok,
    false,
    "descriptor syntax cannot prove producer custody",
  );
  rig.candidate.custody = {
    kind: "implementation",
    reservationId: "a".repeat(64),
    candidate: rig.request.record.target.candidateState.preserved!,
  };
  const ready = await rig.port.resolve(rig.request);
  assert.ok(ready.ok);
  assert.equal(
    (await rig.port.authorizeEffect(ready.value, rig.request)).ok,
    true,
  );
  rig.candidate.nextDescendsFromExpected = false;
  assert.equal(
    (await rig.port.resolve(rig.request)).ok,
    false,
    "no non-FF rewrite",
  );
  rig.candidate.nextDescendsFromExpected = true;
  rig.request.expectedHead = NEXT;
  assert.equal(
    (await rig.port.resolve(rig.request)).ok,
    false,
    "do not assume an unacknowledged push completed",
  );
});

Deno.test("takeover proof: refresh preparation binds the durable new base while retaining old custody", async () => {
  const rig = await takeoverFixture();
  rig.request.operation = "refresh";
  rig.request.observedBase = NEXT;
  rig.native.base = NEXT;
  rig.request.record.intent = {
    kind: "base_refresh",
    key: `base_refresh:999:${SHA3}:${NEXT}`,
    startedAt: rig.clock.value,
    branch: rig.request.record.target.branch,
    expectedHead: SHA3,
    observedBase: NEXT,
    pr: 999,
    requestId: null,
    resultId: null,
  };
  const ready = await rig.port.resolve(rig.request);
  assert.ok(ready.ok);
  assert.equal(
    (await rig.port.authorizeEffect(ready.value, rig.request)).ok,
    true,
  );
  assert.equal(rig.request.record.target.base, SHA1);
  assert.equal(rig.request.record.target.candidateState?.preserved, null);
  const key = rig.request.record.intent.key;
  rig.request.record.intent.key = "base_refresh:unbound";
  assert.equal((await rig.port.resolve(rig.request)).ok, false);
  rig.request.record.intent.key = key;
  rig.request.record.intent.observedBase = SHA2;
  assert.equal((await rig.port.resolve(rig.request)).ok, false);
  rig.request.record.intent.observedBase = NEXT;
  rig.native.base = SHA2;
  assert.equal((await rig.port.resolve(rig.request)).ok, false);
  rig.native.base = NEXT;
  rig.request.operation = "merge";
  assert.equal((await rig.port.resolve(rig.request)).ok, false);
  rig.request.operation = "refresh";
  rig.request.record.intent.resultId = SHA2;
  assert.equal((await rig.port.resolve(rig.request)).ok, false);
});

Deno.test("takeover provenance: malformed, duplicate and unsupported ancestor records fail", async (t) => {
  for (
    const mode of [
      "duplicate",
      "malformed",
      "same-head",
      "non-park",
      "unsettled-intent",
      "false-descriptor",
      "wrong-related",
      "wrong-source-kind",
      "wrong-source-id",
    ] as const
  ) {
    await t.step(mode, async () => {
      const rig = await takeoverFixture();
      if (mode === "duplicate") {
        rig.request.record.evidence.push(rig.request.record.evidence[0]);
      }
      if (mode === "malformed") rig.request.record.evidence[0].ref += "/extra";
      if (mode === "same-head") {
        rig.request.record.evidence = [
          takeoverProvenanceRef(rig.bindingDigest, CURRENT),
        ];
      }
      if (mode === "non-park") {
        rig.ancestor.work[0].nextStep = "review";
        rig.ancestor.work[0].blocker = null;
      }
      if (mode === "unsettled-intent") {
        rig.ancestor.work[0].intent = {
          kind: "push",
          key: "preserving",
          startedAt: rig.clock.value,
          branch: rig.candidate.anchorRef,
          expectedHead: SHA3,
          observedBase: SHA1,
          pr: null,
          requestId: null,
          resultId: null,
        };
      }
      if (mode === "false-descriptor") {
        rig.ancestor.work[0].target.candidateState!.preserved = {
          operationKey: "impl:" + "a".repeat(64),
          base: SHA1,
          head: SHA3,
          ref: rig.candidate.anchorRef,
        };
      }
      if (mode === "wrong-related") {
        rig.ancestor.work[0].related.issueNumber = 2;
      }
      if (mode === "wrong-source-kind") {
        rig.ancestor.work[0].source.kind = "incident";
        rig.request.record.source.kind = "incident";
      }
      if (mode === "wrong-source-id") {
        rig.ancestor.work[0].source.id = "2";
        rig.request.record.source.id = "2";
      }
      assert.equal(
        await readTakeoverAnchor({ ...rig.request, state: rig.deps.state }),
        null,
      );
    });
  }
});

Deno.test("takeover provenance: real Git state ancestry survives restart without fabricated accounting", async () => {
  const rig = await takeoverFixture();
  const real = await makeRig("takeover-ancestry", { summaries: false });
  try {
    const initial = await real.store.writeRepair(rig.ancestor, null);
    assert.ok(initial.ok && initial.value.status === "applied");
    const snapshot = structuredClone(rig.request.snapshot);
    snapshot.stateHead = initial.value.head;
    snapshot.work[0].evidence = [
      takeoverProvenanceRef(rig.bindingDigest, initial.value.head),
    ];
    const next = await real.store.writeRepair(snapshot, initial.value.head);
    assert.ok(next.ok && next.value.status === "applied");
    const input = {
      ...rig.request,
      snapshot,
      record: snapshot.work[0],
      expectedStateHead: next.value.head,
    };
    const restarted = createTakeoverProofPort({
      ...rig.deps,
      state: real.store,
    });
    const proof = await restarted.resolve(input);
    assert.ok(proof.ok);
    assert.equal(
      (await restarted.authorizeEffect(proof.value, input)).ok,
      true,
    );
    const observed = await real.store.readRepair();
    assert.ok(observed.ok && observed.value.status === "found");
    assert.deepEqual(observed.value.snapshot.reservations, []);
    assert.deepEqual(observed.value.snapshot.reviews, []);
  } finally {
    await real.ctx.cleanup();
  }
});

Deno.test({
  name: "takeover V1 native anchor and provenance parse under actual R80",
  ignore: !await gen80Available(),
  async fn() {
    const rig = await takeoverFixture();
    const old = await loadGen80Modules(["src/contracts/state-snapshots.ts"]);
    try {
      const parse = old.modules[0]
        .parseRepairStateSnapshotV1 as typeof parseRepairStateSnapshotV1;
      assert.deepEqual(parse(rig.ancestor), rig.ancestor);
      assert.deepEqual(parse(rig.request.snapshot), rig.request.snapshot);
      const changed = structuredClone(rig.request.snapshot);
      changed.stateHead = SHA2;
      assert.deepEqual(parse(changed), changed);
    } finally {
      await old.dispose();
    }
  },
});

Deno.test("takeover proof: absent, revoked and throwing principal never supplies effect authority", async (t) => {
  for (
    const mode of [
      "absent",
      "revoked",
      "throwing",
      "revoked-after-observation",
    ] as const
  ) {
    await t.step(mode, async () => {
      const r = await takeoverFixture();
      let calls = 0;
      const principal = mode === "absent" ? undefined : {
        revalidate: () => {
          calls++;
          if (mode === "throwing") throw new Error("private fixture error");
          return Promise.resolve(
            mode === "revoked" || calls > 1
              ? portError("unavailable", "fixture revoked")
              : { ok: true as const, value: undefined },
          );
        },
      };
      assert.equal(
        (await createTakeoverProofPort({ ...r.deps, principal }).resolve(
          r.request,
        )).ok,
        false,
      );
      assert.equal(r.request.snapshot.reservations.length, 0);
    });
  }
});

Deno.test("takeover proof: original native head refuses an invented producer descriptor", async () => {
  const r = await takeoverFixture();
  r.request.record.target.candidateState!.preserved = {
    operationKey: "impl:" + "a".repeat(64),
    base: SHA1,
    head: SHA3,
    ref: "refs/heads/sentinel-candidates/" + "b".repeat(64),
  };
  assert.equal((await r.port.resolve(r.request)).ok, false);
});
