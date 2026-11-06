import assert from "node:assert/strict";
import { readOwnerFutureRecoveryAuthority } from "../../src/host/owner-install-future-recovery.ts";
import { readOwnerSupersessionAuthority } from "../../src/host/owner-install-supersession.ts";
import { futureRecoveryFixture } from "./owner-install-future-recovery-fixtures.ts";

Deno.test("owner native proof: production clocks reread lagging repair metadata", async (t) => {
  for (
    const scenario of [
      {
        name: "future recovery",
        options: {},
        read: readOwnerFutureRecoveryAuthority,
      },
      {
        name: "owner supersession",
        options: { legacyFirst: true, ownerSupersession: true },
        read: readOwnerSupersessionAuthority,
      },
    ]
  ) {
    await t.step(scenario.name, async () => {
      const rig = await futureRecoveryFixture(scenario.options);
      const fetch = globalThis.fetch;
      const setTimeout = globalThis.setTimeout;
      const waits: number[] = [];
      let jobsReads = 0;
      try {
        const input = await rig.readerInput();
        const saved = rig.healthy.execution;
        const jobsPath =
          `/repos/ubiquity-sentinel/sentinel/actions/runs/${saved.runId}/attempts/${saved.runAttempt}/jobs`;
        globalThis.fetch = async (request, init) => {
          const response = await fetch(request, init);
          const url = new URL(
            request instanceof Request ? request.url : String(request),
          );
          if (url.pathname === jobsPath && ++jobsReads === 1) {
            const body = await response.json();
            // GitHub publishes the completed job before the runtime step.
            body.jobs[0].steps = [];
            return new Response(JSON.stringify(body), {
              status: response.status,
              headers: response.headers,
            });
          }
          return response;
        };
        globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
          if (args[1] === 10_000) {
            waits.push(args[1]);
            rig.setNow(Date.now() + args[1]);
            args[1] = 0;
          }
          return setTimeout(...args);
        }) as typeof setTimeout;

        const authority = await scenario.read(input);
        assert.equal(jobsReads, 2, "lagging metadata must be reread");
        assert.deepEqual(waits, [10_000]);
        assert.ok(authority, "complete native metadata must allow authority");
        assert.equal(rig.patches(), 0, "proof reads must not write state");
      } finally {
        globalThis.setTimeout = setTimeout;
        await rig.close();
      }
    });
  }
});
