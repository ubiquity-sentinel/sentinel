import assert from "node:assert/strict";
import { SHA1, SHA3 } from "../state/helpers.ts";
import { check, ciFirstRig, taskRecord } from "./ci-first-rig.ts";
import { candidateStateFor, CHECK_POLL_MS } from "./loop-candidate-fixtures.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";

for (const recorded of [true, false]) {
  Deno.test(`publication: an already published head ${recorded ? "keeps" : "records"} its durable proof exactly once`, async () => {
    const { rig, writes, charges } = await ciFirstRig(
      `publication-noop-${recorded}`,
      {
        checks: { [SHA3]: [check("ci", SHA3, null, "in_progress")] },
      },
    );
    try {
      const read = await rig.store.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      if (!read.ok || read.value.status !== "found") {
        throw new Error("fixture state missing");
      }
      const before = read.value.snapshot;
      const record = taskRecord(before);
      const candidate = candidateStateFor(SHA1, SHA3);
      const next = parseWorkRecordV1({
        ...record,
        target: {
          ...record.target,
          candidateState: {
            ...candidate,
            publishedHead: recorded ? SHA3 : null,
          },
        },
        wait: {
          reason: "ci_pending",
          since: rig.clock.now() - CHECK_POLL_MS - 1,
          until: rig.clock.now() - 1,
        },
      });
      const seeded = await rig.store.writeRepair({
        ...before,
        stateHead: read.value.head,
        sequence: before.sequence + 1,
        updatedAt: rig.clock.now(),
        work: [next],
      }, read.value.head);
      assert.ok(seeded.ok && seeded.value.status === "applied");
      writes.length = 0;

      await rig.entry();
      const after = await rig.snapshot();
      assert.equal(
        writes.length,
        recorded ? 0 : 1,
        "only a missing publication proof needs a commit",
      );
      assert.equal(
        taskRecord(after).target.candidateState?.publishedHead,
        SHA3,
      );
      assert.equal(
        rig.github.pushes.length,
        0,
        "the existing exact head is never pushed again",
      );
      assert.deepEqual(after.reservations, charges);
      rig.clock.advance(CHECK_POLL_MS + 1);
      await rig.entry();
      assert.equal(
        writes.length,
        recorded ? 0 : 1,
        "later pending observations keep the proof unchanged",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  });
}
