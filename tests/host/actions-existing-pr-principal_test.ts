import assert from "node:assert/strict";
import { actionsExistingPrincipalFixture } from "./actions-existing-pr-principal-fixtures.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import { runProof } from "./actions-supervisor-fixture.ts";

Deno.test("Actions existing PR principal: actual host preserves a native PR with its same-token opaque authority", async () => {
  const rig = await actionsExistingPrincipalFixture();
  try {
    const before = await rig.state.readRepair();
    assert(before.ok && before.value.status === "found");
    await rig.run(async (port) => {
      assert(port.existingPrTakeover !== undefined);
      assert.equal(port.existingPrTakeover.coordinationActivated, true);
      const ref = await port.readRef("refs/heads/development");
      assert(ref.ok && ref.value?.sha === rig.native.ctx.base);
      const preserved = await port.existingPrTakeover.preserveNativeHead(
        rig.request,
      );
      assert.equal(
        preserved.ok,
        true,
        "authenticated native source activates the actual same-token takeover factory",
      );
    });
    assert.equal(
      await rig.native.readHead(rig.request.ref),
      rig.native.ctx.head,
    );
    assert.equal(
      await rig.native.readHead("refs/heads/" + rig.request.binding.headRef),
      rig.native.ctx.head,
    );
    const after = await rig.state.readRepair();
    assert.deepEqual(
      after,
      before,
      "preservation does not rewrite authoritative state",
    );
    assert.equal(
      rig.gitCalls.filter((call) => call.args.includes("push")).length,
      1,
    );
    assert(
      rig.gitCalls.every((call) =>
        !call.args.some((arg) => arg.startsWith("--force"))
      ),
    );
    assert(
      rig.targetCalls.some((call) =>
        call.path === "/installation/repositories"
      ),
    );
    assert(
      rig.targetCalls.every((call) =>
        call.method === "GET" || call.path === "/graphql"
      ),
    );
  } finally {
    await rig.close();
  }
});

Deno.test("Actions existing PR principal: custody floor permits native readback while source admission is disabled", async () => {
  const rig = await actionsExistingPrincipalFixture(false);
  try {
    assert.equal(rig.principal.capability.existingPr.custodyActivated, true);
    const before = await rig.state.readRepair();
    assert(before.ok && before.value.status === "found");
    const saved = before.value;
    await rig.run(async (port) => {
      assert(port.existingPrTakeover !== undefined);
      assert.equal(port.existingPrTakeover.coordinationActivated, false);
      const record = saved.snapshot.work[0];
      const found = await port.existingPrTakeover.discover({
        record,
        deadline: rig.request.deadline,
      });
      assert.equal(
        found.status,
        "candidate",
        "native custody remains readable",
      );
      assert.equal(
        (await port.existingPrTakeover.preserveNativeHead(rig.request)).ok,
        false,
      );
      assert.equal(
        (await port.existingPrTakeover.authorizeAdoption({
          candidate: found.status === "candidate"
            ? found.candidate
            : assert.fail(),
          record,
          snapshot: saved.snapshot,
          expectedStateHead: saved.head,
          deadline: rig.request.deadline,
        })).ok,
        false,
      );
    });
    assert.equal(await rig.native.readHead(rig.request.ref), null);
    assert.equal(
      rig.gitCalls.filter((call) => call.args.includes("push")).length,
      0,
    );
    assert.deepEqual(await rig.state.readRepair(), before);
  } finally {
    await rig.close();
  }
});

Deno.test("Actions existing PR principal: stale or unproven authority refuses before target write", async (t) => {
  for (
    const scenario of [
      "revoked",
      "expired",
      "wrong scope",
      "forged metadata",
      "native fallback",
      "state head drift",
      "PR head drift",
      "native job drift",
      "launcher data drift",
    ]
  ) {
    await t.step(scenario, async () => {
      const rig = await actionsExistingPrincipalFixture();
      try {
        if (scenario === "forged metadata") {
          const metadata = JSON.parse(
            rig.env.SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT!,
          );
          rig.env.SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT = JSON.stringify({
            ...metadata,
            appId: 1,
          });
        } else if (scenario === "native fallback") {
          rig.env.SENTINEL_SUPERVISOR_TOKEN = rig.env.GITHUB_TOKEN;
        } else if (scenario === "expired") {
          const metadata = JSON.parse(
            rig.env.SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT!,
          );
          rig.env.SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT = JSON.stringify({
            ...metadata,
            expiresAt: new Date(rig.principal.clock.now() + 1_000)
              .toISOString(),
          });
        }
        let observedScope = false;
        await rig.run(async (port) => {
          assert(port.existingPrTakeover !== undefined);
          // Owner directive 2026-10-24: without an App principal the local
          // composition keeps existing-PR discovery off; with one, the shipped
          // capability decides. Either way no effect is granted below.
          assert.equal(
            port.existingPrTakeover.coordinationActivated,
            scenario !== "forged metadata" && scenario !== "native fallback",
            "discovery is never activated by a missing principal",
          );
          if (scenario === "revoked") rig.controls.revoked = true;
          else if (scenario === "expired") {
            rig.principal.setNow(rig.principal.clock.now() + 1_000);
          } else if (scenario === "wrong scope") {
            rig.principal.model.repositories[0].id = 999;
          } else if (scenario === "PR head drift") {
            rig.native.controls.head = rig.native.ctx.base;
          } else if (scenario === "native job drift") {
            rig.principal.model.jobs[0].status = "completed";
          } else if (scenario === "launcher data drift") {
            await rig.principal.write(
              rig.principal.launcher,
              "src/host/hosted-custody-capability.json",
              JSON.stringify({
                ...rig.principal.capability,
                takeover: { activated: false },
              }),
            );
          } else if (scenario === "state head drift") {
            const before = await rig.state.readRepair();
            assert(before.ok && before.value.status === "found");
            const changed = parseRepairStateSnapshotV1({
              ...before.value.snapshot,
              stateHead: before.value.head,
              sequence: before.value.snapshot.sequence + 1,
              updatedAt: rig.principal.clock.now(),
            });
            const written = await rig.state.writeRepair(
              changed,
              before.value.head,
            );
            assert(written.ok && written.value.status === "applied");
          }
          const before = await rig.state.readRepair();
          const result = await port.existingPrTakeover.preserveNativeHead(
            rig.request,
          );
          assert.equal(result.ok, false, scenario);
          assert.deepEqual(
            await rig.state.readRepair(),
            before,
            "refusal preserves state and reservations",
          );
          observedScope = rig.targetCalls.some((call) =>
            call.path === "/installation/repositories"
          );
        });
        assert.equal(await rig.native.readHead(rig.request.ref), null);
        assert.equal(
          await rig.native.readHead(
            "refs/heads/" + rig.request.binding.headRef,
          ),
          rig.native.ctx.head,
        );
        assert.equal(
          rig.gitCalls.filter((call) => call.args.includes("push")).length,
          0,
        );
        assert(
          rig.targetCalls.every((call) =>
            call.method === "GET" || call.path === "/graphql"
          ),
        );
        if (scenario === "revoked" || scenario === "wrong scope") {
          assert(observedScope);
        }
      } finally {
        await rig.close();
      }
    });
  }
});

Deno.test("Actions existing PR principal: source, native and saved execution drift during final App scope response refuse before push", async (t) => {
  for (const scenario of ["launcher source", "native job", "saved execution"]) {
    await t.step(scenario, async () => {
      const rig = await actionsExistingPrincipalFixture();
      try {
        const before = await rig.state.readRepair();
        await rig.run(async (port) => {
          assert(port.existingPrTakeover?.coordinationActivated);
          rig.controls.afterScopeRead = async (read) => {
            // The first scope proof precedes opaque proof creation; the second
            // is the effect-bound revalidation immediately before actual push.
            if (read !== 2) return;
            if (scenario === "saved execution") {
              const read = await rig.release.readRelease();
              assert(read.ok && read.value.status === "found");
              const runtime = read.value.snapshot.hostedRuntimes[0];
              assert(runtime.execution !== null);
              const proof = runProof(runtime.execution, "failed");
              const next = parseReleaseStateSnapshotV1({
                ...read.value.snapshot,
                stateHead: read.value.head,
                sequence: read.value.snapshot.sequence + 1,
                updatedAt: rig.principal.clock.now(),
                hostedRuntimes: [{
                  ...runtime,
                  execution: null,
                  lastExecutionProof: proof,
                  updatedAt: rig.principal.clock.now(),
                }],
              });
              const written = await rig.release.writeRelease(
                next,
                read.value.head,
              );
              assert(
                written.ok && written.value.status === "applied",
                "valid terminal execution settlement while retaining the healthy runtime",
              );
            } else if (scenario === "native job") {
              rig.principal.model.jobs[0].status = "completed";
            } else {
              await rig.principal.write(
                rig.principal.launcher,
                "src/host/hosted-custody-capability.json",
                JSON.stringify({
                  ...rig.principal.capability,
                  takeover: { activated: false },
                }),
              );
            }
          };
          const result = await port.existingPrTakeover.preserveNativeHead(
            rig.request,
          );
          assert.equal(result.ok, false);
        });
        assert.equal(
          rig.controls.scopeReads,
          2,
          "race reached the final App scope proof",
        );
        assert.equal(
          rig.gitCalls.filter((call) => call.args.includes("push")).length,
          0,
          "fresh source and native authority is required before the actual Git write",
        );
        assert.equal(await rig.native.readHead(rig.request.ref), null);
        assert.equal(
          await rig.native.readHead(
            "refs/heads/" + rig.request.binding.headRef,
          ),
          rig.native.ctx.head,
        );
        assert.deepEqual(await rig.state.readRepair(), before);
      } finally {
        await rig.close();
      }
    });
  }
});
