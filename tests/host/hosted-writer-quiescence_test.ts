import { DORMANT_HOSTED_SUPERVISOR_POLICY as dormant } from "./hosted-supervisor-policy-fixture.ts";
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { readHostedWriterQuiescence } from "../../src/host/hosted-writer-quiescence.ts";
import { nativeWriterFixture } from "./existing-pr-runtime-fixtures.ts";
const SHA = "a".repeat(40) as GitSha;
const OLD = "b".repeat(40) as GitSha;
const custody = { custodyActivated: true, revisions: [SHA] };
const make = () =>
  nativeWriterFixture({ runId: 1, runAttempt: 2, launcherSha: SHA });
const input = (native: ReturnType<typeof make>) => ({
  token: "offline",
  run: native.run,
  phase: "prepare" as const,
  clock: { now: () => 1 },
  deadline: 100,
  read: native.read,
});

Deno.test("hosted writer drain: older queued requested waiting pending or active writers block", async (t) => {
  for (
    const status of ["queued", "requested", "waiting", "pending", "in_progress"]
  ) {
    await t.step(status, async () => {
      const native = make();
      native.peers.push({ ...native.nativeRun, id: 2, status, head_sha: OLD });
      assert.equal(
        (await readHostedWriterQuiescence(input(native), custody)).status,
        "blocked",
      );
    });
  }
});

Deno.test("hosted writer drain: same accepted source pending dispatch is attainable without cancellation", async () => {
  const native = make();
  native.peers.push({ ...native.nativeRun, id: 2, status: "queued" });
  native.peerJobs.push({
    id: 21,
    name: "maintenance",
    status: "queued",
    head_sha: SHA,
    runner_id: 0,
    started_at: null,
  });
  assert.equal(
    (await readHostedWriterQuiescence(input(native), custody)).status,
    "ready",
  );
  assert.equal(
    (await readHostedWriterQuiescence(input(native), dormant.custody)).status,
    "blocked",
    "dormant source cannot grant queued source compatibility",
  );
  native.peerJobs[0].runner_id = 5;
  assert.equal(
    (await readHostedWriterQuiescence(input(native), custody)).status,
    "blocked",
  );
});

Deno.test("hosted writer drain: complete stable native identities are mandatory", async (t) => {
  for (
    const fault of [
      "ref",
      "attempt",
      "job",
      "pagination",
      "duplicate",
      "moving",
      "deadline",
    ]
  ) {
    await t.step(fault, async () => {
      const native = make();
      let calls = 0;
      const raw = native.read;
      const read = async (path: string) => {
        calls++;
        const value = await raw(path);
        if (fault === "pagination" && path.includes("/workflows/")) {
          return { total_count: 101, workflow_runs: [] };
        }
        if (
          fault === "duplicate" && path.includes("status=in_progress") &&
          path.includes("supervisor.yml")
        ) {
          return {
            total_count: 2,
            workflow_runs: [native.nativeRun, native.nativeRun],
          };
        }
        if (fault === "moving" && calls > 18) native.setRef(OLD);
        return value;
      };
      if (fault === "ref") native.setRef(OLD);
      if (fault === "attempt") native.nativeRun.run_attempt++;
      if (fault === "job") native.currentJobs.length = 0;
      const result = await readHostedWriterQuiescence({
        ...input(native),
        read,
        ...(fault === "deadline" ? { deadline: 1 } : {}),
      }, custody);
      assert.equal(result.status, "unavailable");
    });
  }
});
