/** Synthetic Actions logs through the production reader and observation pass. */
import assert from "node:assert/strict";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy-github.ts";
import { runSelfObservationPass } from "../../ops/hosted-autonomy-observation.ts";
import { SELF_DEFECT_MAX_LOG_BYTES } from "../../ops/self-defects.ts";

const REPOSITORY = {
  owner: "ubiquity-sentinel",
  name: "sentinel",
  installationId: 1,
};
const SIGNED_LOG = "https://self-observation.invalid/job-log";
const NOW = Date.parse("2026-11-24T12:30:00Z");

Deno.test("self observation: a long repair-cell log retains its terminal failure without publishing raw diagnostics", async () => {
  const bytes = new TextEncoder().encode(
    "synthetic setup output\n".repeat(30_000) +
      "SYNTHETIC_PRIVATE_DIAGNOSTIC\nProcess completed with exit code 1.\n",
  );
  const filed: { title: string; body: string }[] = [];
  const original = globalThis.fetch;
  let signedReads = 0;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const json = (body: unknown) => Promise.resolve(Response.json(body));
    if (url.href === SIGNED_LOG) {
      signedReads++;
      assert.equal(headers.get("authorization"), null);
      assert.equal(init?.redirect, "manual");
      const ranged = headers.get("range") ===
        `bytes=-${SELF_DEFECT_MAX_LOG_BYTES}`;
      return Promise.resolve(
        new Response(
          ranged ? bytes.slice(-SELF_DEFECT_MAX_LOG_BYTES) : bytes,
          { status: ranged ? 206 : 200 },
        ),
      );
    }
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(headers.get("authorization"), "Bearer fixture-token");
    if (url.pathname.endsWith("/actions/runs")) {
      return json({
        workflow_runs: [{
          id: 41,
          name: "sentinel-supervisor",
          conclusion: "failure",
          created_at: new Date(NOW - 60_000).toISOString(),
        }],
      });
    }
    if (url.pathname.endsWith("/actions/runs/41/jobs")) {
      return json({
        total_count: 1,
        jobs: [{
          id: 11,
          name: `repair_cell (${"a".repeat(64)})`,
          conclusion: "failure",
        }],
      });
    }
    if (url.pathname.endsWith("/actions/jobs/11/logs")) {
      assert.equal(init?.redirect, "manual");
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: SIGNED_LOG } }),
      );
    }
    assert.ok(url.pathname.endsWith("/issues"));
    if (init?.method === "POST") {
      filed.push(JSON.parse(String(init.body)));
      return json({ number: 901 });
    }
    return json(filed);
  };
  try {
    const github = createHostedAutonomyGitHub("fixture-token", REPOSITORY);
    assert.deepEqual(
      await runSelfObservationPass({ github, now: NOW }),
      ["self-observation:filed:901:1x"],
    );
    assert.equal(filed.length, 1);
    assert.equal(
      filed[0].title,
      "Sentinel self-observation: the job exited with code 1",
    );
    assert.ok(filed[0].body.includes(":repair_cell:exit:1 -->"));
    assert.ok(!filed[0].body.includes("SYNTHETIC_PRIVATE_DIAGNOSTIC"));
    assert.ok(!filed[0].body.includes("synthetic setup output"));
    assert.deepEqual(
      await runSelfObservationPass({ github, now: NOW }),
      ["self-observation:no_change"],
    );
    assert.equal(filed.length, 1);
    assert.equal(signedReads, 2);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("self observation log: short inline and redirected responses remain readable", async (t) => {
  for (const redirected of [false, true]) {
    await t.step(redirected ? "redirected" : "inline", async () => {
      const original = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = (input, init) => {
        calls++;
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("range"), "bytes=-64");
        if (calls === 1) {
          assert.equal(headers.get("authorization"), "Bearer fixture-token");
          if (redirected) {
            return Promise.resolve(
              new Response(null, {
                status: 302,
                headers: { location: SIGNED_LOG },
              }),
            );
          }
        } else {
          assert.equal(String(input), SIGNED_LOG);
          assert.equal(headers.get("authorization"), null);
        }
        return Promise.resolve(new Response("short log\n"));
      };
      try {
        const github = createHostedAutonomyGitHub("fixture-token", REPOSITORY);
        assert.equal(
          await github.selfObservation!.readJobLog({ jobId: 11, maxBytes: 64 }),
          "short log\n",
        );
        assert.equal(calls, redirected ? 2 : 1);
      } finally {
        globalThis.fetch = original;
      }
    });
  }
});

Deno.test("self observation log: a server ignoring the suffix request cannot exceed the read bound", async () => {
  const original = globalThis.fetch;
  let cancelled = false;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(128).fill(120));
    },
    cancel() {
      cancelled = true;
    },
  });
  globalThis.fetch = (_input, init) => {
    assert.equal(new Headers(init?.headers).get("range"), "bytes=-64");
    return Promise.resolve(new Response(body));
  };
  try {
    const github = createHostedAutonomyGitHub("fixture-token", REPOSITORY);
    const log = await github.selfObservation!.readJobLog({
      jobId: 11,
      maxBytes: 64,
    });
    assert.equal(log, "x".repeat(64));
    assert.equal(cancelled, true);
    assert.ok(pulls <= 2, `unexpected extra stream reads: ${pulls}`);
  } finally {
    globalThis.fetch = original;
  }
});
