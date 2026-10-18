/** Failing-step segmentation and bounded excerpt selection over real logs. */
import assert from "node:assert/strict";
import {
  CiLogScanner,
  excerptFromLog,
  MAX_RETAINED_LINES_PER_STEP,
  MAX_TAIL_RING_LINES,
} from "../../src/repair/ci-evidence-excerpt.ts";
import {
  classifyCheck,
  extractHints,
} from "../../src/repair/ci-evidence-classify.ts";
import {
  cleanLogLine,
  sanitizeEvidenceLine,
} from "../../src/repair/ci-evidence-sanitize.ts";
import {
  type CiFixtureName,
  fixtureBytes,
  fixtureText,
  REAL_ERROR_LINES,
  REAL_FIXTURES,
} from "./ci-evidence-fixtures.ts";

/** Feed a log in odd-sized byte chunks, so lines and UTF-8 split anywhere. */
function scan(bytes: Uint8Array, chunk = 4_093) {
  const scanner = new CiLogScanner();
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    scanner.pushBytes(bytes.subarray(offset, offset + chunk));
  }
  return scanner.finish();
}

function excerptOf(name: CiFixtureName, share: number) {
  const log = scan(fixtureBytes(name));
  const excerpt = excerptFromLog(log, share);
  assert.ok(excerpt !== null, name);
  return { log, excerpt };
}

for (const name of REAL_FIXTURES) {
  for (const share of [16 * 1024, 8 * 1024]) {
    Deno.test(`real log ${name}: the failing step's error lines fit a ${share}-character share`, () => {
      const { log, excerpt } = excerptOf(name, share);
      assert.equal(log.steps.length, 1, "one failing step");
      assert.ok(log.steps[0].hasShell, "the failing step runs a command");
      assert.ok(excerpt.text.length <= share, String(excerpt.text.length));
      const lines = excerpt.text.split("\n");
      for (const expected of REAL_ERROR_LINES[name]) {
        assert.ok(lines.includes(expected), `${name} lost: ${expected}`);
      }
      assert.ok(
        lines.includes("##[error]Process completed with exit code 1.") ||
          lines.includes("##[error]Process completed with exit code 2."),
      );
      // Timestamps and ANSI codes never reach the excerpt.
      assert.ok(!/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(lines[1] ?? ""));
      assert.ok(!excerpt.text.includes("\x1b"));
      // The step identity (its group header) leads the excerpt.
      assert.match(excerpt.text, /^##\[group\]Run /);
    });
  }
}

Deno.test("real logs: a one-byte chunking yields the same excerpt", () => {
  const bytes = fixtureBytes("real-1119.txt");
  const whole = excerptFromLog(scan(bytes, bytes.length), 16 * 1024);
  const bytewise = excerptFromLog(scan(bytes, 1), 16 * 1024);
  assert.deepEqual(bytewise, whole);
});

Deno.test("structured hints summarize formatter, linter, compiler and test failures", () => {
  const hints = (name: CiFixtureName) =>
    extractHints(scan(fixtureBytes(name)).steps);
  assert.deepEqual(hints("real-1009.txt").slice(0, 2), [
    "prettier: src/provider/lithos-rate-limits.ts",
    "eslint: src/provider/lithos-rate-limits.ts:81:9 error sonarjs/no-nested-conditional",
  ]);
  assert.ok(
    hints("real-1119.txt").includes(
      "tsc: tests/provider-selection.test.ts(654,36) TS2345",
    ),
  );
  assert.ok(
    hints("real-1154.txt").includes(
      "test: GET /v1/live/<call_id> retires a terminal upstream mapping before closing and allowing reconnect",
    ),
  );
  assert.ok(
    hints("synthetic-pytest.txt").includes(
      "test: tests/test_parser.py::test_parse_header",
    ),
  );
  assert.ok(
    hints("synthetic-go-make.txt").includes(
      "test: TestRouterRejectsUnknownMethod",
    ),
  );
  // An unrecognized failure has no hints but still has an excerpt.
  assert.deepEqual(hints("synthetic-opaque.txt"), []);
});

Deno.test("unknown failure shapes still yield the step header, its errors and its tail", () => {
  const cases: [CiFixtureName, string[]][] = [
    ["synthetic-opaque.txt", [
      "##[group]Run ./scripts/release-gate.sh",
      "release gate: bundle size 412 KiB exceeds the 400 KiB budget for dist/app.js",
      "##[error]Process completed with exit code 3.",
    ]],
    ["synthetic-cargo.txt", [
      "error[E0308]: mismatched types",
      "  --> src/parser.rs:41:24",
      "41 |     let width: u32 = header.len();",
    ]],
    ["synthetic-pytest.txt", [
      "E       AssertionError: assert (0, 3) == (0, 2)",
      "FAILED tests/test_parser.py::test_parse_header - AssertionError: assert (0, 3) == (0, 2)",
    ]],
    ["synthetic-go-make.txt", [
      "--- FAIL: TestRouterRejectsUnknownMethod (0.00s)",
      "    router_test.go:88: status = 200, want 405",
      "make: *** [Makefile:14: test] Error 1",
    ]],
  ];
  for (const [name, expected] of cases) {
    const { excerpt } = excerptOf(name, 4 * 1024);
    const lines = excerpt.text.split("\n");
    for (const line of expected) {
      assert.ok(lines.includes(line), `${name} lost: ${line}`);
    }
  }
  // The opaque gate's 120 progress lines do not fit a tiny share: the
  // header and the tail survive and the gap is marked.
  const small = excerptOf("synthetic-opaque.txt", 1_200).excerpt.text;
  assert.ok(small.length <= 1_200, String(small.length));
  assert.match(small, /\[\.\.\. \d+ lines omitted \.\.\.\]/);
  assert.match(small, /bundle size 412 KiB/);
});

/** A synthetic step whose marker lines alone overflow a small share. */
function markerStep(markers: number, filler: number): Uint8Array {
  const lines = [
    "2026-10-17T10:00:00.0000000Z ##[group]Run make lint",
    "2026-10-17T10:00:00.0000000Z shell: /usr/bin/bash -e {0}",
    "2026-10-17T10:00:00.0000000Z ##[endgroup]",
  ];
  for (let index = 0; index < markers; index++) {
    for (let fill = 0; fill < filler; fill++) {
      lines.push(`2026-10-17T10:00:01.0000000Z context ${index}.${fill}`);
    }
    lines.push(
      `2026-10-17T10:00:02.0000000Z src/file${index}.ts(1,1): error TS2304: Cannot find name 'x${index}'.`,
    );
  }
  lines.push(
    "2026-10-17T10:00:03.0000000Z ##[error]Process completed with exit code 2.",
  );
  return new TextEncoder().encode(lines.join("\n") + "\n");
}

Deno.test("windows shrink before markers are dropped, and first and last markers survive", () => {
  const share = 3_000;
  const shrunk = excerptFromLog(scan(markerStep(20, 30)), share);
  assert.ok(shrunk !== null && shrunk.text.length <= share);
  for (let index = 0; index < 20; index++) {
    assert.match(shrunk.text, new RegExp(`Cannot find name 'x${index}'`));
  }
  const overflow = excerptFromLog(scan(markerStep(400, 2)), share);
  assert.ok(overflow !== null && overflow.text.length <= share);
  assert.match(overflow.text, /Cannot find name 'x0'/);
  assert.match(overflow.text, /Cannot find name 'x399'/);
  assert.match(overflow.text, /exit code 2/);
});

Deno.test("a log without a ##[error] marker falls back to at most three recent steps; at most three error steps are kept", () => {
  const noError = fixtureText("synthetic-opaque.txt").replace(
    /##\[error\]/g,
    "",
  );
  const log = scan(new TextEncoder().encode(noError));
  assert.equal(log.steps.length, 3);
  assert.equal(log.steps.at(-1)?.header, "Run ./scripts/release-gate.sh");
  const many: string[] = [];
  for (let step = 0; step < 5; step++) {
    many.push(
      `2026-10-17T10:00:00.0000000Z ##[group]Run step-${step}`,
      "2026-10-17T10:00:00.0000000Z shell: /usr/bin/bash -e {0}",
      "2026-10-17T10:00:00.0000000Z ##[endgroup]",
      `2026-10-17T10:00:00.0000000Z ##[error]step ${step} failed`,
    );
  }
  const kept = scan(new TextEncoder().encode(many.join("\n"))).steps;
  assert.deepEqual(kept.map((step) => step.header), [
    "Run step-0",
    "Run step-1",
    "Run step-4",
  ]);
  const recent = scan(new TextEncoder().encode(
    many.join("\n").replaceAll("##[error]", ""),
  )).steps;
  assert.deepEqual(recent.map((step) => step.header), [
    "Run step-2",
    "Run step-3",
    "Run step-4",
  ]);
});

Deno.test("job API failure windows outrank unrelated error groups in the existing three retained slots", () => {
  const epoch = Date.parse("2026-10-17T10:00:00Z");
  const line = (seconds: number, text: string) =>
    `${new Date(epoch + seconds * 1_000).toISOString()} ${text}`;
  const windows = [3, 6, 9].map((second, index) => ({
    name: `Friendly failed step ${index}`,
    startedAt: epoch + second * 1_000,
    completedAt: epoch + (second + 1) * 1_000,
  }));
  const scanner = new CiLogScanner(windows);
  const lines = [
    line(0, "##[group]Run earlier successful test"),
    line(0, "##[error]an expected test diagnostic"),
    line(1, "##[group]Run another successful test"),
    line(1, "##[error]another expected diagnostic"),
    ...[3, 6, 9].flatMap((second, index) => [
      line(second, `##[group]Run command-${index}`),
      line(second, "##[endgroup]"),
      // Job metadata truncates this final diagnostic to the completed second.
      line(second + 1.9, `markerless budget diagnostic ${index}`),
    ]),
    ...Array.from({ length: 20 }, (_, index) => [
      line(index + 12, `##[group]Run upload-${index}`),
      line(index + 12, "##[error]unrelated upload diagnostic"),
    ]).flat(),
  ];
  scanner.pushText(lines.join("\n") + "\n");
  const log = scanner.finish();
  assert.equal(log.steps.length, 3);
  const excerpt = excerptFromLog(log, 16_384)!;
  for (let index = 0; index < 3; index++) {
    assert.ok(excerpt.text.includes(`markerless budget diagnostic ${index}`));
  }
  assert.ok(!excerpt.text.includes("unrelated upload diagnostic"));
  assert.ok(excerpt.text.length <= 16_384);
});

Deno.test("a gap in the scan is marked and the tail's failing step is still found", () => {
  const scanner = new CiLogScanner();
  const encoder = new TextEncoder();
  scanner.pushBytes(encoder.encode(
    "2026-10-17T10:00:00.0000000Z ##[group]Run make all\n" +
      "2026-10-17T10:00:00.0000000Z shell: /usr/bin/bash -e {0}\n" +
      "2026-10-17T10:00:00.0000000Z ##[endgroup]\n" +
      "2026-10-17T10:00:00.0000000Z (pass) early [1ms]\n2026-10-17T10:0",
  ));
  scanner.gap(5_000_000);
  scanner.pushBytes(encoder.encode(
    "0:01.0000000Z partial line dropped\n" +
      "2026-10-17T10:09:00.0000000Z src/late.ts(9,9): error TS1005: ';' expected.\n" +
      "2026-10-17T10:09:00.0000000Z ##[error]Process completed with exit code 2.\n" +
      "2026-10-17T10:09:00.0000000Z Post job cleanup.\n",
  ));
  const log = scanner.finish();
  const excerpt = excerptFromLog(log, 4_000);
  assert.ok(excerpt !== null);
  assert.match(excerpt.text, /\[\.\.\. 5000000 bytes not scanned \.\.\.\]/);
  assert.match(excerpt.text, /src\/late\.ts\(9,9\): error TS1005/);
  assert.ok(!excerpt.text.includes("partial line dropped"));
  assert.match(excerpt.text, /^##\[group\]Run make all/);
});

Deno.test("retained lines per step stay bounded on a marker flood", () => {
  const scanner = new CiLogScanner();
  scanner.pushText(
    "##[group]Run flood\nshell: /usr/bin/bash -e {0}\n##[endgroup]\n",
  );
  const line = "FAIL something broke\n".repeat(1_000);
  for (let index = 0; index < 200; index++) scanner.pushText(line);
  scanner.pushText("##[error]Process completed with exit code 1.\n");
  const log = scanner.finish();
  assert.ok(
    log.steps[0].retainedLines <=
      MAX_RETAINED_LINES_PER_STEP + 64 + MAX_TAIL_RING_LINES,
  );
  assert.equal(log.steps[0].lineCount, 200_004);
  const excerpt = excerptFromLog(log, 8_000);
  assert.ok(excerpt !== null && excerpt.text.length <= 8_000);
  assert.match(excerpt.text, /exit code 1/);
});

/** The last failing step of a fixture as the excerpt renders its lines. */
function failingStep(name: CiFixtureName): string[] {
  const lines = fixtureText(name).split("\n").map((line) =>
    sanitizeEvidenceLine(cleanLogLine(line))
  );
  const end = lines.findIndex((line) => line.startsWith("##[error]"));
  const start = lines.slice(0, end).findLastIndex((line) =>
    line.startsWith("##[group]Run ")
  );
  return lines.slice(start, end + 1);
}

/**
 * Failures whose key lines carry no failure word and sit in the middle of
 * the failing step: generated-file drift (the drifted file is named only by
 * the diff header), a colored Jest diff of expected and received values, and
 * a traceback whose root cause is followed by more output.
 */
const MID_STEP: readonly {
  name: CiFixtureName;
  /** A share the whole step does not fit. */
  overflowShare: number;
  keyLines: readonly string[];
}[] = [
  {
    name: "synthetic-gen-drift.txt",
    overflowShare: 2_000,
    keyLines: [
      "generated 4 files",
      "diff --git a/src/gen/api.ts b/src/gen/api.ts",
      "--- a/src/gen/api.ts",
      "+++ b/src/gen/api.ts",
      "@@ -10,3 +10,123 @@ export interface ApiSchema {",
    ],
  },
  {
    name: "synthetic-jest-diff.txt",
    overflowShare: 4_096,
    keyLines: [
      " FAIL  src/order.test.ts",
      "  ● order › totals include tax",
      "    - Expected  - 2",
      '    -   "tax": 8,',
      '    +   "tax": 8.04,',
      "    > 41 |     expect(totals(order)).toEqual({ subtotal: 100, tax: 8, total: 108 });",
      "      at Object.<anonymous> (src/order.test.ts:41:25)",
      "Tests:       1 failed, 1240 passed, 1241 total",
    ],
  },
  {
    name: "synthetic-traceback-mid.txt",
    overflowShare: 2_400,
    keyLines: [
      "Traceback (most recent call last):",
      '    version = spec["schema_version"]',
      "KeyError: 'schema_version'",
      "check-schemas: 1 generator step did not complete",
    ],
  },
];

for (const { name, overflowShare, keyLines } of MID_STEP) {
  Deno.test(`${name}: a failing step that fits its share is kept whole`, () => {
    const step = failingStep(name);
    assert.ok(step.join("\n").length > overflowShare, "the step overflows");
    for (const line of keyLines) assert.ok(step.includes(line), line);
    // The production share, and the step's own length (the tightest fit).
    for (const share of [16 * 1024, step.join("\n").length]) {
      const { excerpt } = excerptOf(name, share);
      assert.equal(excerpt.text, step.join("\n"), `${name} at ${share}`);
      assert.equal(excerpt.kept, excerpt.total);
    }
    // A repository command failed: the advisory label is the candidate's.
    const label = classifyCheck({
      conclusion: "failure",
      external: false,
      failingSteps: [{
        number: 3,
        name: step[0].slice("##[group]".length),
        conclusion: "failure",
      }],
      log: scan(fixtureBytes(name)),
    });
    assert.equal(label.classification, "candidate");
  });

  Deno.test(`${name}: a step over its share keeps its unmarked key lines and uses the share`, () => {
    const { excerpt } = excerptOf(name, overflowShare);
    const text = excerpt.text;
    assert.ok(text.length <= overflowShare, String(text.length));
    // The rest of the share is used, not left empty beside lost context.
    assert.ok(text.length > overflowShare - 450, String(text.length));
    assert.match(text, /\[\.\.\. \d+ lines omitted \.\.\.\]/);
    const lines = text.split("\n");
    for (
      const line of [
        ...keyLines,
        "##[error]Process completed with exit code 1.",
      ]
    ) {
      assert.ok(lines.includes(line), `${name} lost: ${line}`);
    }
    assert.match(text, /^##\[group\]Run /);
  });
}
