/** Exhaustive authenticated pagination and native launcher identity. */
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { SHA2, SHA3 } from "../state/helpers.ts";
import { fixture, RUN } from "./matrix-artifact-fixtures.ts";

Deno.test("matrix artifacts: numeric repository pagination recovers native 100 plus 8 pages", async () => {
  const rig = await fixture(true);
  try {
    rig.pagination.numeric = true;
    rig.artifacts.push(
      ...Array.from(
        { length: 6 },
        (_, i) => ({ id: i + 3000, name: `extra-${i}` }),
      ),
    );
    const { currentRun: _oldRun, ...input } = rig.input;
    const waves = await rig.transport.recover(input);
    assert.equal(rig.artifacts.length, 108);
    assert.equal(waves.length, 1);
    assert.equal(waves[0].results.length, 1);
    assert.deepEqual(
      await Deno.readFile(`${waves[0].bundlesDir}/${rig.result.bundle!.file}`),
      rig.bundle,
    );
    assert.equal(
      rig.calls.filter((call) =>
        new URL(call.url).pathname === "/repos/ubiquity-sentinel/sentinel"
      ).length,
      1,
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("matrix artifacts: numeric repository pagination also binds current-run artifacts and job pages", async () => {
  const rig = await fixture(true);
  try {
    rig.pagination.numeric = true;
    rig.artifacts.push(
      ...Array.from(
        { length: 6 },
        (_, i) => ({ id: i + 3000, name: `extra-${i}` }),
      ),
    );
    rig.jobs.push(
      ...Array.from(
        { length: 6 },
        (_, i) => ({ ...rig.jobs[0], id: i + 4000, name: `extra-job-${i}` }),
      ),
    );
    const waves = await rig.transport.recover(rig.input);
    assert.equal(waves.length, 1);
    assert.equal(waves[0].results.length, 1);
    assert.ok(
      rig.calls.some((call) =>
        call.url.includes("/runs/71/artifacts?per_page=100&page=2")
      ),
    );
    assert.ok(
      rig.calls.some((call) =>
        call.url.includes("/attempts/2/jobs?per_page=100&page=2")
      ),
    );
    assert.equal(
      rig.calls.filter((call) =>
        new URL(call.url).pathname === "/repos/ubiquity-sentinel/sentinel"
      ).length,
      1,
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("matrix artifacts: numeric repository pagination refuses foreign identity and malformed boundaries", async (t) => {
  const valid =
    "https://api.github.com/repositories/123/actions/artifacts?per_page=100&page=2";
  const cases: [string, (rig: Awaited<ReturnType<typeof fixture>>) => void][] =
    [
      ["other repository ID", (rig) => {
        rig.pagination.next = valid.replace("/123/", "/456/");
      }],
      ["wrong authenticated repository name", (rig) => {
        rig.pagination.repository.full_name = "ubiquity/other";
      }],
      ["wrong authenticated repository ID", (rig) => {
        rig.pagination.repository.id = 456;
      }],
      ["invalid authenticated repository ID", (rig) => {
        rig.pagination.repository.id = 0;
      }],
      ["foreign host", (rig) => {
        rig.pagination.next = valid.replace(
          "api.github.com",
          "foreign.invalid",
        );
      }],
      ["HTTP scheme", (rig) => {
        rig.pagination.next = valid.replace("https:", "http:");
      }],
      ["wrong actions suffix", (rig) => {
        rig.pagination.next = valid.replace("/artifacts?", "/jobs?");
      }],
      ["wrong page size", (rig) => {
        rig.pagination.next = valid.replace("per_page=100", "per_page=99");
      }],
      ["skipped page", (rig) => {
        rig.pagination.next = valid.replace("page=2", "page=3");
      }],
      ["page loop", (rig) => {
        rig.pagination.next = valid.replace("page=2", "page=1");
      }],
      ["extra query", (rig) => {
        rig.pagination.next = valid + "&other=1";
      }],
      ["duplicate query", (rig) => {
        rig.pagination.next = valid + "&page=2";
      }],
      ["fragment", (rig) => {
        rig.pagination.next = valid + "#other";
      }],
      ["duplicate next relation", (rig) => {
        rig.pagination.next = valid + '>; rel="next", <' + valid;
      }],
      ["truncated second page", (rig) => {
        rig.pagination.truncate = true;
      }],
      ["duplicate item ID", (rig) => {
        rig.pagination.duplicate = true;
      }],
    ];
  for (const [name, change] of cases) {
    await t.step(name, async () => {
      const rig = await fixture(true);
      try {
        rig.pagination.numeric = true;
        rig.artifacts.push(
          ...Array.from(
            { length: 6 },
            (_, i) => ({ id: i + 3000, name: `extra-${i}` }),
          ),
        );
        change(rig);
        const before = canonicalStringify([rig.repair, rig.release]);
        const { currentRun: _oldRun, ...input } = rig.input;
        await assert.rejects(
          () => rig.transport.recover(input),
          /provenance unavailable or conflicting/,
        );
        assert.equal(canonicalStringify([rig.repair, rig.release]), before);
        assert.ok(
          rig.calls.every((call) =>
            new URL(call.url).hostname === "api.github.com"
          ),
        );
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
});

Deno.test("matrix artifacts: historical native launcher binds to its own authenticated attempt head", async () => {
  const rig = await fixture(true);
  try {
    const { currentRun: _oldRun, ...input } = rig.input;
    // The current caller's launcher differs from the honest historical native
    // attempt head: the historical wave must bind to the authenticated native
    // head, never to the caller or to a plan-supplied SHA.
    const waves = await rig.transport.recover({ ...input, launcherSha: SHA2 });
    assert.equal(waves.length, 1);
    assert.equal(waves[0].results.length, 1);
    assert.deepEqual(waves[0].provenance, {
      run: RUN,
      plannerJobId: 401,
      cellJobIds: [402],
    });
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("matrix artifacts: historical native launcher mismatches and malformed heads refuse", async (t) => {
  for (const mutation of ["artifact", "job", "attempt-malformed"] as const) {
    await t.step(mutation, async () => {
      const rig = await fixture();
      try {
        const { currentRun: _oldRun, ...input } = rig.input;
        if (mutation === "artifact") {
          rig.artifacts[0]!.workflow_run = {
            ...(rig.artifacts[0]!.workflow_run as Record<string, unknown>),
            head_sha: SHA2,
          };
        } else if (mutation === "job") {
          rig.jobs[0]!.head_sha = SHA2;
        } else {
          rig.attempt.head_sha = "not-a-sha";
        }
        await assert.rejects(
          () => rig.transport.recover({ ...input, launcherSha: SHA3 }),
          /matrix artifact provenance/,
        );
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
});

Deno.test("matrix artifacts: ordinary current-run launcher mismatch still refuses", async () => {
  const rig = await fixture();
  try {
    await assert.rejects(
      () => rig.transport.recover({ ...rig.input, launcherSha: SHA2 }),
      /matrix artifact provenance/,
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("matrix artifacts: a listing whose count shifts between pages lists again", async () => {
  const rig = await fixture(true);
  try {
    rig.pagination.numeric = true;
    rig.artifacts.push(
      ...Array.from(
        { length: 6 },
        (_, i) => ({ id: i + 3000, name: `extra-${i}` }),
      ),
    );
    // Another run uploads one artifact while page 2 of the first listing is
    // requested, as live run 40113229034 saw.
    let uploaded = false;
    rig.pagination.onPage = (key, page) => {
      if (key === "artifacts" && page === 2 && !uploaded) {
        uploaded = true;
        rig.artifacts.push({ id: 3999, name: "concurrent-upload" });
      }
    };
    const { currentRun: _oldRun, ...input } = rig.input;
    const waves = await rig.transport.recover(input);
    assert.equal(waves.length, 1);
    assert.equal(waves[0].results.length, 1);
    assert.ok(
      rig.calls.filter((call) =>
        call.url.includes("/artifacts?per_page=100&page=1")
      ).length >= 2,
      "the listing restarted from page 1",
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("matrix artifacts: a count that never settles still refuses", async () => {
  const rig = await fixture(true);
  try {
    rig.pagination.numeric = true;
    rig.artifacts.push(
      ...Array.from(
        { length: 6 },
        (_, i) => ({ id: i + 3000, name: `extra-${i}` }),
      ),
    );
    let next = 5000;
    rig.pagination.onPage = (key, page) => {
      if (key === "artifacts" && page === 2) {
        rig.artifacts.push({ id: next++, name: `upload-${next}` });
      }
    };
    const before = canonicalStringify([rig.repair, rig.release]);
    const { currentRun: _oldRun, ...input } = rig.input;
    await assert.rejects(
      () => rig.transport.recover(input),
      /provenance unavailable or conflicting/,
    );
    assert.equal(canonicalStringify([rig.repair, rig.release]), before);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});
