import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { createExistingPrTakeover } from "../../src/host/existing-pr-takeover.ts";
import {
  TAKEOVER_NATIVE_PRESERVED,
  takeoverProvenanceRef,
} from "../../src/github/existing-pr-takeover-provenance.ts";
import { SHA1, SHA2 } from "../state/helpers.ts";
import { gitRun } from "./actions-candidates-fixture.ts";
import { nativeFixture } from "./existing-pr-native-fixtures.ts";

Deno.test("native takeover preserves a human PR through real HTTP/Git, without model custody or target mutation", async () => {
  const rig = await nativeFixture();
  try {
    const before = structuredClone(rig.state.repair);
    const found = await rig.port.discover({
      record: rig.state.repair!.work[0],
      deadline: rig.request.deadline,
    });
    assert.equal(found.status, "candidate");
    if (found.status === "candidate") {
      assert.equal(found.candidate.binding.author, "human-owner");
    }
    assert.equal((await rig.port.preserveNativeHead(rig.request)).ok, true);
    assert.deepEqual(rig.pushes, [{
      ref: rig.request.ref,
      head: rig.ctx.head,
      expected: null,
    }]);
    assert.equal(await rig.readHead(rig.request.ref), rig.ctx.head);
    assert.equal(
      await rig.readHead(`refs/heads/${rig.request.binding.headRef}`),
      rig.ctx.head,
    );
    assert.deepEqual(rig.state.repair, before);
    assert.equal(rig.state.repairWrites, 0);
    assert.deepEqual(rig.state.repair!.reservations, []);
    assert.equal(
      rig.state.repair!.work[0].target.candidateState!.preserved,
      null,
    );
    assert.ok(rig.requests.some((r) => r.path === "/graphql"));
    assert.ok(
      rig.requests.every((r) => r.method === "GET" || r.path === "/graphql"),
    );
    assert.ok(
      rig.calls.filter((c) => c.credentialed).every((c) =>
        c.args.includes("fetch")
      ),
    );
    assert.ok(
      rig.calls.every((c) => !c.args.some((a) => a.startsWith("--force"))),
    );
    assert.equal((await rig.port.preserveNativeHead(rig.request)).ok, true);
    assert.equal(
      rig.pushes.length,
      1,
      "idempotent readback does not push again",
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("native takeover handles lost acknowledgement by exact fresh readback, once", async () => {
  const rig = await nativeFixture();
  try {
    const push = rig.host.port.pushHead.bind(rig.host.port);
    rig.host.port.pushHead = async (...args) => {
      const result = await push(...args);
      assert.ok(result.ok);
      return portOk("ambiguous");
    };
    assert.equal((await rig.port.preserveNativeHead(rig.request)).ok, true);
    assert.equal(rig.pushes.length, 1);
    assert.equal(await rig.readHead(rig.request.ref), rig.ctx.head);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("native takeover keeps a written ref unresolved when authoritative state moves during the push", async () => {
  const rig = await nativeFixture();
  try {
    const push = rig.host.port.pushHead.bind(rig.host.port);
    rig.host.port.pushHead = async (...args) => {
      const result = await push(...args);
      rig.state.repairHead = SHA2;
      return result;
    };
    assert.equal((await rig.port.preserveNativeHead(rig.request)).ok, false);
    assert.equal(await rig.readHead(rig.request.ref), rig.ctx.head);
    assert.equal(rig.pushes.length, 1);
    assert.equal(rig.state.repairWrites, 0);
    assert.equal(rig.state.repair!.work[0].intent!.kind, "push");
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("native takeover preserves an unchanged native head when development advanced independently", async () => {
  const rig = await nativeFixture([], async (ctx) => {
    const work = `${ctx.tmp}/work`;
    assert.ok(
      (await gitRun(work, ["checkout", "-q", "development"], ctx.env)).ok,
    );
    await Deno.writeTextFile(`${work}/later-base.txt`, "base advanced\n");
    assert.ok((await gitRun(work, ["add", "later-base.txt"], ctx.env)).ok);
    assert.ok(
      (await gitRun(work, ["commit", "-q", "-m", "advance base"], ctx.env)).ok,
    );
    const base = await gitRun(work, ["rev-parse", "HEAD"], ctx.env);
    assert.ok(base.ok);
    ctx.base = base.stdout.trim() as GitSha;
    assert.ok(
      (await gitRun(work, ["push", "-q", "origin", "development"], ctx.env)).ok,
    );
  });
  try {
    assert.equal((await rig.port.preserveNativeHead(rig.request)).ok, true);
    assert.equal(await rig.readHead(rig.request.ref), rig.ctx.head);
    assert.equal(await rig.readHead("refs/heads/development"), rig.ctx.base);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("native takeover rejects protected edits even when the final native tree reverts them", async () => {
  const rig = await nativeFixture(["protected.txt"], async (ctx) => {
    const work = `${ctx.tmp}/work`;
    await Deno.writeTextFile(
      `${work}/protected.txt`,
      "transient protected edit\n",
    );
    assert.ok((await gitRun(work, ["add", "protected.txt"], ctx.env)).ok);
    assert.ok(
      (await gitRun(
        work,
        ["commit", "-q", "-m", "edit protected file"],
        ctx.env,
      )).ok,
    );
    await Deno.remove(`${work}/protected.txt`);
    assert.ok((await gitRun(work, ["add", "-A"], ctx.env)).ok);
    assert.ok(
      (await gitRun(
        work,
        ["commit", "-q", "-m", "restore protected tree"],
        ctx.env,
      )).ok,
    );
    const head = await gitRun(work, ["rev-parse", "HEAD"], ctx.env);
    assert.ok(head.ok);
    ctx.head = head.stdout.trim() as GitSha;
  });
  try {
    const result = await rig.port.discover({
      record: rig.state.repair!.work[0],
      deadline: rig.request.deadline,
    });
    assert.equal(result.status, "owner_park");
    if (result.status === "owner_park") {
      assert.equal(result.reason, "protected_path");
    }
    assert.equal((await rig.port.preserveNativeHead(rig.request)).ok, false);
    assert.equal(rig.pushes.length, 0);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("native takeover cannot claim an unobserved or conflicting immutable ref", async (t) => {
  for (
    const mode of [
      "collision",
      "lost without write",
      "remote read failure",
    ] as const
  ) {
    await t.step(mode, async () => {
      const rig = await nativeFixture();
      try {
        if (mode === "collision") {
          assert.ok(
            (await gitRun(rig.ctx.bare, [
              "update-ref",
              rig.request.ref,
              rig.ctx.base,
            ], rig.ctx.env)).ok,
          );
        } else if (mode === "lost without write") {
          rig.host.port.pushHead = () => Promise.resolve(rig.noWriteResult());
        } else rig.controls.failHttp = true;
        assert.equal(
          (await rig.port.preserveNativeHead(rig.request)).ok,
          false,
        );
        assert.equal(rig.pushes.length, 0);
        assert.equal(
          await rig.readHead(rig.request.ref),
          mode === "collision" ? rig.ctx.base : null,
        );
      } finally {
        await rig.ctx.cleanup();
      }
    });
  }
});

Deno.test("native takeover preservation refuses source/capability/state/intent/protected-path faults before push", async (t) => {
  for (
    const mode of [
      "source off",
      "fence missing",
      "write grant missing",
      "state moved",
      "deadline",
      "wrong key",
      "wrong ref",
      "wrong author",
      "forged descriptor",
      "other task owns PR",
      "source changed",
      "state drift during discovery",
      "protected path",
    ] as const
  ) {
    await t.step(mode, async () => {
      const rig = await nativeFixture(
        mode === "protected path" ? ["candidate.txt"] : [],
      );
      try {
        const record = rig.state.repair!.work[0];
        if (mode === "source off") rig.controls.policy.activated = false;
        if (mode === "fence missing") rig.controls.fence = false;
        if (mode === "write grant missing") rig.controls.write = false;
        if (mode === "state moved") rig.state.repairHead = SHA2;
        if (mode === "deadline") rig.request.deadline = rig.clock.now();
        if (mode === "wrong key") record.intent!.key += "wrong";
        if (mode === "wrong ref") rig.request.ref += "wrong";
        if (mode === "wrong author") rig.controls.author = "different-owner";
        if (mode === "forged descriptor") {
          record.target.candidateState!.preserved = {
            operationKey: "impl:" + "a".repeat(64),
            base: rig.ctx.base,
            head: rig.ctx.head,
            ref: rig.request.ref,
          };
        }
        if (mode === "other task owns PR") {
          const other = structuredClone(record);
          other.id = "other" as typeof record.id;
          rig.state.repair!.work.push(other);
        }
        if (mode === "source changed") rig.controls.body = "different source";
        if (mode === "state drift during discovery") {
          rig.controls.hook = () => {
            rig.state.repairHead = SHA2;
          };
        }
        assert.equal(
          (await rig.port.preserveNativeHead(rig.request)).ok,
          false,
        );
        assert.equal(rig.pushes.length, 0);
        assert.equal(await rig.readHead(rig.request.ref), null);
      } finally {
        await rig.ctx.cleanup();
      }
    });
  }
});

Deno.test("native takeover factory defaults to refusal but discovery remains available while inactive", async () => {
  const rig = await nativeFixture();
  try {
    const { policy: _, runtimeCapabilityAccepted: _fence, ...input } =
      rig.factoryInput;
    const inactive = createExistingPrTakeover(input);
    assert.equal(
      (await inactive.discover({
        record: rig.state.repair!.work[0],
        deadline: rig.request.deadline,
      })).status,
      "candidate",
    );
    assert.equal((await inactive.preserveNativeHead(rig.request)).ok, false);
    assert.equal(rig.pushes.length, 0);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("native takeover proof re-fetches immutable Git custody after restart and never trusts local objects alone", async () => {
  const rig = await nativeFixture();
  try {
    assert.equal((await rig.port.preserveNativeHead(rig.request)).ok, true);
    const anchor = structuredClone(rig.state.repair!);
    anchor.work[0].intent = null;
    anchor.work[0].blocker!.message = TAKEOVER_NATIVE_PRESERVED;
    const current = structuredClone(anchor);
    current.stateHead = SHA1;
    current.sequence++;
    current.work[0].nextStep = "review";
    current.work[0].blocker = null;
    current.work[0].evidence = [
      takeoverProvenanceRef(rig.request.bindingDigest, SHA1),
    ];
    rig.state.repair = current;
    rig.state.repairHead = SHA2;
    const state = {
      readRepair: rig.state.readRepair.bind(rig.state),
      readRepairAt: (
        { commit, expectedHead }: { commit: string; expectedHead: string },
      ) =>
        Promise.resolve(
          commit === SHA1 && expectedHead === SHA2
            ? portOk({
              status: "found" as const,
              snapshot: structuredClone(anchor),
              head: SHA1,
              ref: null,
            })
            : portOk({
              status: "absent" as const,
              currentHead: SHA2,
              ref: null,
            }),
        ),
    };
    const restarted = createExistingPrTakeover({ ...rig.factoryInput, state });
    const request = {
      record: current.work[0],
      snapshot: current,
      expectedStateHead: SHA2,
      expectedHead: rig.ctx.head,
      operation: "review" as const,
      deadline: rig.request.deadline,
    };
    const resolved = await restarted.resolve(request);
    assert.ok(resolved.ok);
    assert.equal(
      (await restarted.authorizeEffect(resolved.value, request)).ok,
      true,
    );
    assert.ok(
      (await gitRun(
        rig.ctx.bare,
        ["update-ref", rig.request.ref, rig.ctx.base],
        rig.ctx.env,
      )).ok,
    );
    assert.equal((await restarted.resolve(request)).ok, false);
    assert.equal(
      rig.pushes.length,
      1,
      "proof reads cannot repair an invalid custody ref",
    );
    assert.equal(rig.state.repairWrites, 0);
  } finally {
    await rig.ctx.cleanup();
  }
});
