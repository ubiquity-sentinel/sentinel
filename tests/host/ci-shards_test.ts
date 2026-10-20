import assert from "node:assert/strict";
import {
  CI_TEST_SHARDS,
  discoverCiTests,
  planCiTestShards,
} from "../../ops/ci-shards.ts";

Deno.test("CI shards cover every discovered test exactly once, including model and future directories", async () => {
  const files = await discoverCiTests();
  const future = "tests/future/deep/new_test.ts";
  const plan = planCiTestShards([...files, future]);
  const assigned = CI_TEST_SHARDS.flatMap((name) => plan[name]);
  assert.deepEqual(assigned.sort(), [...files, future].sort());
  assert.equal(new Set(assigned).size, assigned.length);
  assert.ok(plan.modules.some((file) => file.startsWith("tests/model/")));
  assert.ok(plan.modules.includes(future));
  assert.ok(
    plan.integration.every((file) => file.startsWith("tests/integration/")),
  );
  for (const name of ["host-1", "host-2", "host-3"] as const) {
    assert.ok(plan[name].length > 0);
    assert.ok(plan[name].every((file) => file.startsWith("tests/host/")));
  }
});

Deno.test("CI host thirds balance measured file cost independently of discovery order", () => {
  const files = ["a", "b", "c", "d", "e", "f"].map((name) =>
    `tests/host/${name}_test.ts`
  );
  const weights = Object.fromEntries(
    files.map((file, index) => [file, [19, 18, 17, 3, 2, 1][index]]),
  );
  const plan = planCiTestShards(files, weights);
  assert.deepEqual(planCiTestShards([...files].reverse(), weights), plan);
  for (const name of ["host-1", "host-2", "host-3"] as const) {
    assert.equal(plan[name].reduce((sum, file) => sum + weights[file], 0), 20);
  }
  assert.throws(() => planCiTestShards([files[0], files[0]]), /duplicate/);
  assert.throws(() => planCiTestShards(["../elsewhere_test.ts"]), /invalid/);
  assert.throws(
    () => planCiTestShards([files[0]], { [files[0]]: NaN }),
    /timing/,
  );
});
