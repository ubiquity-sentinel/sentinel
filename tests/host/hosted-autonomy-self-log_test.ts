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
  const signedRanges: (string | null)[] = [];
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const json = (body: unknown) => Promise.resolve(Response.json(body));
    if (url.href === SIGNED_LOG) {
      signedRanges.push(headers.get("range"));
      assert.equal(headers.get("authorization"), null);
      assert.equal(init?.redirect, "manual");
      // The Actions results host ignores suffix ranges, but honors explicit
      // start-end requests. Returning a 200 prefix must not hide the exit line.
      const range = /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") ?? "");
      if (range === null) return Promise.resolve(new Response(bytes));
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), bytes.byteLength - 1);
      assert.ok(start <= end);
      assert.ok(end - start + 1 <= SELF_DEFECT_MAX_LOG_BYTES);
      return Promise.resolve(
        new Response(bytes.slice(start, end + 1), {
          status: 206,
          headers: {
            "content-range": `bytes ${start}-${end}/${bytes.byteLength}`,
          },
        }),
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
    const tail = `bytes=${bytes.byteLength - SELF_DEFECT_MAX_LOG_BYTES}-${
      bytes.byteLength - 1
    }`;
    assert.deepEqual(signedRanges, ["bytes=0-0", tail, "bytes=0-0", tail]);
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
        assert.equal(headers.get("range"), calls === 1 ? null : "bytes=0-0");
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

Deno.test("self observation log: a server ignoring explicit ranges cannot exceed the read bound", async () => {
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
  globalThis.fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    if (String(input) !== SIGNED_LOG) {
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: SIGNED_LOG } }),
      );
    }
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("range"), "bytes=0-0");
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

Deno.test("self observation log: explicit ranges retain short logs and exact byte boundaries", async (t) => {
  for (const length of [1, 10, 64, 65]) {
    await t.step(`${length} bytes`, async () => {
      const original = globalThis.fetch;
      const ranges: (string | null)[] = [];
      const bytes = new Uint8Array(length).fill(120);
      globalThis.fetch = (input, init) => {
        const headers = new Headers(init?.headers);
        assert.equal(init?.redirect, "manual");
        if (String(input) !== SIGNED_LOG) {
          assert.equal(headers.get("authorization"), "Bearer fixture-token");
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: SIGNED_LOG },
            }),
          );
        }
        assert.equal(headers.get("authorization"), null);
        ranges.push(headers.get("range"));
        const range = /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") ?? "");
        assert.ok(range);
        const start = Number(range[1]);
        const end = Number(range[2]);
        assert.ok(start <= end && end < length);
        return Promise.resolve(
          new Response(bytes.slice(start, end + 1), {
            status: 206,
            headers: { "content-range": `bytes ${start}-${end}/${length}` },
          }),
        );
      };
      try {
        const github = createHostedAutonomyGitHub("fixture-token", REPOSITORY);
        assert.equal(
          await github.selfObservation!.readJobLog({ jobId: 11, maxBytes: 64 }),
          "x".repeat(Math.min(length, 64)),
        );
        assert.deepEqual(ranges, [
          "bytes=0-0",
          `bytes=${Math.max(0, length - 64)}-${length - 1}`,
        ]);
      } finally {
        globalThis.fetch = original;
      }
    });
  }
});

Deno.test("self observation log: invalid partial responses are cancelled and refused", async (t) => {
  const cases: {
    name: string;
    probe: string | null;
    tailStatus?: number;
    tailRange?: string;
  }[] = [
    { name: "missing total", probe: null },
    { name: "unknown total", probe: "bytes 0-0/*" },
    { name: "empty partial log", probe: "bytes 0-0/0" },
    { name: "incorrect probe offset", probe: "bytes 1-1/65" },
    { name: "unsafe total", probe: "bytes 0-0/9007199254740992" },
    { name: "ignored tail range", probe: "bytes 0-0/65", tailStatus: 200 },
    {
      name: "incorrect tail offset",
      probe: "bytes 0-0/65",
      tailStatus: 206,
      tailRange: "bytes 0-63/65",
    },
    { name: "second redirect", probe: "bytes 0-0/65", tailStatus: 302 },
    { name: "unavailable tail", probe: "bytes 0-0/65", tailStatus: 416 },
  ];
  for (const test of cases) {
    await t.step(test.name, async () => {
      const original = globalThis.fetch;
      let signedReads = 0;
      const cancelled: number[] = [];
      globalThis.fetch = (input, init) => {
        if (String(input) !== SIGNED_LOG) {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: SIGNED_LOG },
            }),
          );
        }
        const read = ++signedReads;
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), null);
        assert.equal(init?.redirect, "manual");
        assert.equal(
          headers.get("range"),
          read === 1 ? "bytes=0-0" : "bytes=1-64",
        );
        const contentRange = read === 1 ? test.probe : test.tailRange;
        const responseHeaders = new Headers();
        if (contentRange) responseHeaders.set("content-range", contentRange);
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(Uint8Array.of(120));
              },
              cancel() {
                cancelled.push(read);
              },
            }),
            {
              status: read === 1 ? 206 : test.tailStatus,
              headers: responseHeaders,
            },
          ),
        );
      };
      try {
        const github = createHostedAutonomyGitHub("fixture-token", REPOSITORY);
        assert.equal(
          await github.selfObservation!.readJobLog({ jobId: 11, maxBytes: 64 }),
          null,
        );
        assert.equal(signedReads, test.tailStatus === undefined ? 1 : 2);
        assert.deepEqual(
          cancelled,
          test.tailStatus === undefined ? [1] : [1, 2],
        );
      } finally {
        globalThis.fetch = original;
      }
    });
  }
});
