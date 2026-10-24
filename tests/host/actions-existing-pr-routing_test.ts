import assert from "node:assert/strict";
import { portError } from "../../src/contracts/ports.ts";
import { routeExistingPr } from "../../src/repair/loop-existing-pr.ts";
import { prepareImplementationStart } from "../../src/repair/loop-implementation.ts";
import { executeImplementationStep } from "../../src/repair/loop-work.ts";
import { actionsExistingPrincipalFixture } from "./actions-existing-pr-principal-fixtures.ts";

Deno.test("Actions existing PR routing: without the App grant Sentinel's own repair proceeds, no discovery or hold", async () => {
  // Owner directive 2026-10-24: other people's pull requests never hold or
  // divert Sentinel's own repair, so a missing grant no longer activates
  // existing-PR discovery and its own PR creation is allowed.
  const rig = await actionsExistingPrincipalFixture(true, true);
  try {
    delete rig.env.SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT;
    await rig.run(async (port, input) => {
      const read = await input.state.readRepair();
      assert(read.ok && read.value.status === "found");
      const record = read.value.snapshot.work[0];
      assert.equal(record.target.pr, null);
      assert.deepEqual(record.evidence, []);
      const route = await routeExistingPr({ ...input, github: port }, {
        snapshot: read.value.snapshot,
        head: read.value.head,
        bounds: { runDeadline: input.deadline, modelCutoff: input.deadline },
        executionBaseline: null,
      }, record);
      const create = await port.existingPrTakeover!.authorizeBoundary({
        kind: "create",
        request: {
          title: "Repair source",
          body: "Resolves #1",
          headRef: record.target.branch!,
          baseRef: "development",
          expectedBase: rig.native.ctx.base,
          expectedHeadRef: rig.native.ctx.head,
        },
      });
      assert.deepEqual(
        { route: route.status, creationAllowed: create.ok },
        {
          route: "ordinary_new_work_allowed",
          creationAllowed: true,
        },
        "Sentinel's own work is neither held nor refused",
      );
    });
    assert.equal(
      rig.gitCalls.filter((call) => call.args.includes("push")).length,
      0,
    );
  } finally {
    await rig.close();
  }
});

Deno.test("Actions existing PR routing: a missing principal no longer holds Sentinel's own implementation", async (t) => {
  for (
    const scenario of [
      "missing grant",
      "forged grant",
      "expired grant",
      "native fallback",
      "source drift",
      "native job drift",
    ]
  ) {
    await t.step(scenario, async () => {
      const rig = await actionsExistingPrincipalFixture(true, true);
      try {
        if (scenario === "missing grant") {
          delete rig.env.SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT;
        } else if (scenario === "native fallback") {
          rig.env.SENTINEL_SUPERVISOR_TOKEN = rig.env.GITHUB_TOKEN;
        } else if (scenario === "native job drift") {
          rig.principal.model.jobs[0].status = "completed";
        } else if (scenario === "source drift") {
          await rig.principal.write(
            rig.principal.launcher,
            "src/host/hosted-runtime-child.ts",
            "unreviewed launcher source\n",
          );
        } else {
          const metadata = JSON.parse(
            rig.env.SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT!,
          );
          rig.env.SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT = JSON.stringify({
            ...metadata,
            ...(scenario === "forged grant" ? { appId: 1 } : {
              expiresAt: new Date(rig.principal.clock.now()).toISOString(),
            }),
          });
        }
        await rig.run(async (port, input) => {
          const read = await input.state.readRepair();
          assert(read.ok && read.value.status === "found");
          const record = read.value.snapshot.work[0];
          const config = input.configs.find((row) =>
            row.repository.name === "sentinel"
          );
          assert(config !== undefined);
          const prepared = await prepareImplementationStart(
            { ...input, github: port },
            {
              snapshot: read.value.snapshot,
              head: read.value.head,
              bounds: {
                runDeadline: input.deadline,
                modelCutoff: input.deadline,
              },
              executionBaseline: null,
            },
            record,
            config,
          );
          const after = await input.state.readRepair();
          assert(after.ok && after.value.status === "found");
          // Owner directive 2026-10-24: Sentinel prepares and charges its own
          // implementation whatever the principal's state.
          const proceeds = true;
          assert.deepEqual(
            {
              prepared: prepared.kind === "prepared",
              reservations: after.value.snapshot.reservations.length,
            },
            {
              prepared: proceeds,
              reservations: read.value.snapshot.reservations.length +
                (proceeds ? 1 : 0),
            },
            "Sentinel's own implementation is prepared with its own charge",
          );
          const prior = read.value.snapshot.reservations;
          assert.deepEqual(
            after.value.snapshot.reservations.filter((reservation) =>
              prior.some((charge) => charge.id === reservation.id)
            ),
            prior,
            "every historical charge is preserved",
          );
          assert.deepEqual(after.value.snapshot.work[0].target, record.target);
        });
        assert.equal(
          rig.gitCalls.filter((call) => call.args.includes("push")).length,
          0,
        );
        assert(
          rig.targetCalls.every((call) =>
            call.method === "GET" || call.path === "/graphql"
          ),
          "implementation preparation produces no GitHub effect",
        );
      } finally {
        await rig.close();
      }
    });
  }
});

Deno.test("Actions existing PR routing: the actual implementation consumer runs Sentinel's own implementation whatever the source routing", async (t) => {
  // Owner directive 2026-10-24: an activated source routing no longer holds
  // the work; both steps start the (fake) model and charge it once.
  for (const activated of [true, false]) {
    await t.step(
      activated ? "required takeover" : "known dormant control",
      async () => {
        const rig = await actionsExistingPrincipalFixture(activated, true);
        let modelStarts = 0;
        try {
          delete rig.env.SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT;
          await rig.run(async (port, input) => {
            const read = await input.state.readRepair();
            assert(read.ok && read.value.status === "found");
            const record = read.value.snapshot.work[0];
            const config = input.configs.find((row) =>
              row.repository.name === "sentinel"
            );
            assert(config !== undefined);
            const result = await executeImplementationStep(
              {
                ...input,
                github: port,
                externalImplementations: false,
                model: {
                  modelId: input.model.modelId,
                  runModel: () => {
                    modelStarts++;
                    return Promise.resolve(
                      portError("unavailable", "offline model boundary"),
                    );
                  },
                },
              },
              {
                snapshot: read.value.snapshot,
                head: read.value.head,
                bounds: {
                  runDeadline: input.deadline,
                  modelCutoff: input.deadline,
                },
                executionBaseline: null,
              },
              record,
              config,
            );
            assert.notEqual(result.kind, "state_error", JSON.stringify(result));
            const after = await input.state.readRepair();
            assert(after.ok && after.value.status === "found");
            assert.equal(modelStarts, 1);
            assert.equal(
              after.value.snapshot.reservations.length,
              read.value.snapshot.reservations.length + 1,
            );
            assert.deepEqual(
              after.value.snapshot.reservations.slice(
                0,
                read.value.snapshot.reservations.length,
              ),
              read.value.snapshot.reservations,
              "the production model consumer preserves historical charges",
            );
            assert.equal(after.value.snapshot.work[0].target.pr, null);
            assert.equal(
              after.value.snapshot.reservations.at(-1)!.outcome,
              "ambiguous",
            );
          });
          assert.equal(
            rig.gitCalls.filter((call) => call.args.includes("push")).length,
            0,
          );
          assert(
            rig.targetCalls.every((call) =>
              call.method === "GET" || call.path === "/graphql"
            ),
            "the fake failed model creates no PR or target effect",
          );
          assert.equal(await rig.native.readHead(rig.request.ref), null);
          assert.equal(
            await rig.native.readHead(
              "refs/heads/" + rig.request.binding.headRef,
            ),
            rig.native.ctx.head,
          );
        } finally {
          await rig.close();
        }
      },
    );
  }
});

Deno.test("Actions existing PR routing: an activated source policy keeps discovery off", async () => {
  // Owner directive 2026-10-24: the repair host no longer reads the takeover
  // source routing, so an activated source policy (which used to route
  // "required") cannot switch existing-PR discovery on for the local
  // composition, and nothing is pushed.
  const rig = await actionsExistingPrincipalFixture(true, true);
  try {
    delete rig.env.SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT;
    await rig.run((port) => {
      assert.equal(port.existingPrTakeover!.coordinationActivated, false);
      return Promise.resolve();
    });
    assert.equal(
      rig.gitCalls.filter((call) => call.args.includes("push")).length,
      0,
    );
  } finally {
    await rig.close();
  }
});

Deno.test("Actions existing PR routing: authenticated source-off policy retains ordinary dormant behavior", async () => {
  const rig = await actionsExistingPrincipalFixture(false, true);
  try {
    delete rig.env.SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT;
    await rig.run(async (port, input) => {
      const read = await input.state.readRepair();
      assert(read.ok && read.value.status === "found");
      const record = read.value.snapshot.work[0];
      const callsBefore = rig.targetCalls.length;
      const route = await routeExistingPr({ ...input, github: port }, {
        snapshot: read.value.snapshot,
        head: read.value.head,
        bounds: { runDeadline: input.deadline, modelCutoff: input.deadline },
        executionBaseline: null,
      }, record);
      assert.equal(route.status, "ordinary_new_work_allowed");
      assert.equal(
        rig.targetCalls.length,
        callsBefore,
        "known dormant routing performs no discovery",
      );
      assert.deepEqual(await input.state.readRepair(), read);
    });
  } finally {
    await rig.close();
  }
});
