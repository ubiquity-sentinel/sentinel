import assert from "node:assert/strict";
import { portError } from "../../src/contracts/ports.ts";
import { routeExistingPr } from "../../src/repair/loop-existing-pr.ts";
import { prepareImplementationStart } from "../../src/repair/loop-implementation.ts";
import { executeImplementationStep } from "../../src/repair/loop-work.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import { actionsExistingPrincipalFixture } from "./actions-existing-pr-principal-fixtures.ts";

Deno.test("Actions existing PR routing: active launcher cannot fall through when the App grant is absent", async () => {
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
          route: "step",
          creationAllowed: false,
        },
        "missing authority must retain discovery and block replacement admission",
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

Deno.test("Actions existing PR routing: unavailable principal cannot reserve replacement implementation", async (t) => {
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
          assert.deepEqual(
            {
              prepared: prepared.kind === "prepared",
              reservations: after.value.snapshot.reservations.length,
            },
            {
              prepared: false,
              reservations: read.value.snapshot.reservations.length,
            },
            "missing authority cannot prepare or charge a replacement implementation",
          );
          assert.deepEqual(
            after.value.snapshot.reservations,
            read.value.snapshot.reservations,
            "refusal preserves every historical charge",
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
          "refused replacement preparation produces no GitHub effect",
        );
      } finally {
        await rig.close();
      }
    });
  }
});

Deno.test("Actions existing PR routing: actual implementation consumer holds missing authority before model scheduling", async (t) => {
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
            assert.equal(modelStarts, activated ? 0 : 1);
            assert.equal(
              after.value.snapshot.reservations.length,
              read.value.snapshot.reservations.length + (activated ? 0 : 1),
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
            if (!activated) {
              assert.equal(
                after.value.snapshot.reservations.at(-1)!.outcome,
                "ambiguous",
              );
            }
          });
          assert.equal(
            rig.gitCalls.filter((call) => call.args.includes("push")).length,
            0,
          );
          assert(
            rig.targetCalls.every((call) =>
              call.method === "GET" || call.path === "/graphql"
            ),
            "neither the hold nor the fake failed model creates a PR or target effect",
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

Deno.test("Actions existing PR routing: source reads honor the remaining host deadline", async (t) => {
  for (const expire of [false, true]) {
    await t.step(
      expire ? "expires after first read" : "shrinking budget",
      async () => {
        const rig = await actionsExistingPrincipalFixture(true, true);
        const originalRun = DenoReplayRuntime.prototype.run;
        let routingRuntime: DenoReplayRuntime | undefined;
        const deadline = rig.principal.clock.now() + 5_000;
        const reads: Array<{ bound: number; remaining: number }> = [];
        try {
          delete rig.env.SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT;
          rig.env.SENTINEL_SUPERVISOR_TOKEN_NOT_AFTER = String(deadline);
          DenoReplayRuntime.prototype.run = function (command) {
            if (command.cwd === rig.principal.launcher) routingRuntime ??= this;
            if (this === routingRuntime) {
              reads.push({
                bound: command.maxDurationMs,
                remaining: deadline - rig.principal.clock.now(),
              });
              rig.principal.setNow(
                expire ? deadline : rig.principal.clock.now() + 10,
              );
            }
            return originalRun.call(this, command);
          };
          await rig.run((port) => {
            assert.equal(port.existingPrTakeover!.coordinationActivated, true);
            return Promise.resolve();
          });
          assert.equal(reads.length > 0, true);
          assert.deepEqual(
            reads.map((read) => read.bound),
            reads.map((read) => read.remaining),
            "actual source subprocesses must use the shrinking host budget",
          );
          if (expire) {
            assert.equal(
              reads.length,
              1,
              "expired routing launches no further source process",
            );
          } else assert(reads.length > 1);
          assert.equal(
            rig.gitCalls.filter((call) => call.args.includes("push")).length,
            0,
          );
        } finally {
          DenoReplayRuntime.prototype.run = originalRun;
          await rig.close();
        }
      },
    );
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
