/** CI evidence sanitizing: control stripping, path rewriting, redaction, caps. */
import assert from "node:assert/strict";
import {
  cleanLogLine,
  redactSecrets,
  sanitizeEvidenceLine,
  sanitizeEvidenceText,
} from "../../src/repair/ci-evidence-sanitize.ts";
import {
  MAX_CI_EVIDENCE_LINE_CHARS,
  MAX_CI_RAW_LINE_CHARS,
} from "../../src/repair/ci-evidence-types.ts";
import {
  fixtureText,
  PLANTED,
  PLANTED_REDACTIONS,
  REAL_FIXTURES,
  SYNTHETIC_FIXTURES,
} from "./ci-evidence-fixtures.ts";

Deno.test("clean: BOM, timestamp, ANSI, controls, bidi and zero-width characters go", () => {
  assert.equal(
    cleanLogLine(
      "\ufeff2026-10-17T12:03:25.1240705Z [\x1b[33mwarn\x1b[39m] src/a.ts",
    ),
    "[warn] src/a.ts",
  );
  assert.equal(
    cleanLogLine(
      "2026-10-17T12:03:25Z \x1b]8;;https://x.invalid\x07link\x1b]8;;\x07 ok",
    ),
    "link ok",
  );
  assert.equal(
    cleanLogLine("a\u0000b\u0007c\u007fd\u0085e\u202ef\u2066g\u200bh\ufeffi"),
    "abcdefghi",
  );
  assert.equal(cleanLogLine("\tindented\tline"), "  indented  line");
  // An unterminated OSC sequence drops the rest of the line, never hangs.
  assert.equal(cleanLogLine("ok \x1b]0;title-without-end"), "ok ");
  assert.equal(
    cleanLogLine("x".repeat(MAX_CI_RAW_LINE_CHARS * 3)).length,
    MAX_CI_RAW_LINE_CHARS,
  );
});

Deno.test("sanitize: workspace paths become repository-relative; caps keep surrogate pairs whole", () => {
  assert.equal(
    sanitizeEvidenceLine(
      "/home/runner/work/ai.ubq.fi/ai.ubq.fi/src/provider/lithos-rate-limits.ts",
    ),
    "src/provider/lithos-rate-limits.ts",
  );
  assert.equal(
    sanitizeEvidenceLine(
      "      at /home/runner/work/ai.ubq.fi/ai.ubq.fi/tests/a.test.ts:298:17",
    ),
    "      at tests/a.test.ts:298:17",
  );
  // The runner temp directory is not the checkout and stays as it is.
  assert.equal(
    sanitizeEvidenceLine("/home/runner/work/_temp/uos-native-kv/artifact"),
    "/home/runner/work/_temp/uos-native-kv/artifact",
  );
  const long = sanitizeEvidenceLine("y".repeat(10_000));
  assert.ok(long.length <= MAX_CI_EVIDENCE_LINE_CHARS + 16, long);
  assert.ok(long.endsWith(" [...]"));
  const emoji = "a".repeat(MAX_CI_EVIDENCE_LINE_CHARS - 1) + "\u{1F600}tail";
  const capped = sanitizeEvidenceLine(emoji);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(capped), capped);
});

Deno.test("redact: every planted credential shape is redacted", () => {
  for (const [name, value] of Object.entries(PLANTED)) {
    const line = name === "BEARER"
      ? `Authorization: Bearer ${value}`
      : name === "PASSWORD"
      ? `password=${value}`
      : `value ${value} end`;
    const result = redactSecrets(line);
    assert.equal(result.count, 1, `${name}: ${result.text}`);
    assert.ok(!result.text.includes(value), `${name}: ${result.text}`);
    assert.ok(result.text.includes("[REDACTED]"));
  }
  const sas = redactSecrets(
    "https://productionresultssa3.blob.core.windows.net/a/b?sv=2025-01-05&sig=Ab%2Fc0123456789&se=2026-10-18T00%3A00Z",
  );
  assert.equal(sas.count, 3, sas.text);
  assert.ok(!sas.text.includes("Ab%2Fc0123456789"));
  const kv = redactSecrets('api_key: "a1b2c3d4e5f6a7b8c9"');
  assert.equal(kv.count, 1, kv.text);
});

Deno.test("redact: SHAs, paths, branch names and ordinary prose are kept", () => {
  for (
    const keep of [
      "commit 4253e659646bda410d1c565e8c0b396c29b4bc76",
      "digest " + "0123456789abcdef".repeat(4),
      "sentinel/repair/issue-ubiquity-ai.ubq.fi-645",
      "src/provider/lithos-rate-limits.ts",
      "tests/integration/providerSelection/handlerRegistryV2/index.ts",
      "(pass) bearer precedence over cookie auth [0.10ms]",
      "the sk-learn style label",
      "token: ***",
      '"token_present":false,"token_shape":null',
      "const token = createToken();",
      "Authorization header was rejected",
      "X".repeat(5_000),
    ]
  ) {
    const result = redactSecrets(keep);
    assert.equal(result.count, 0, keep.slice(0, 120));
    assert.equal(result.text, keep);
  }
});

Deno.test("redact: committed fixtures carry no credential shape beyond the planted ones", () => {
  for (const name of [...REAL_FIXTURES, ...SYNTHETIC_FIXTURES]) {
    let count = 0;
    for (const raw of fixtureText(name).split("\n")) {
      count += redactSecrets(cleanLogLine(raw)).count;
    }
    assert.equal(
      count,
      name === "synthetic-injection.txt" ? PLANTED_REDACTIONS : 0,
      name,
    );
  }
});

Deno.test("redaction patterns stay linear on adversarial lines", () => {
  const started = performance.now();
  for (
    const line of [
      "A1a".repeat(2_700),
      "authorization: " + "Bearer ".repeat(1_100),
      "ey" + "J" + "a.".repeat(4_000),
      "?sig=".repeat(1_600),
      "password=" + "=".repeat(8_000),
      "a/".repeat(4_000),
    ]
  ) {
    sanitizeEvidenceLine(cleanLogLine(line));
  }
  assert.ok(performance.now() - started < 2_000);
});

Deno.test("sanitize text: multi-line output is cleaned, redacted and bounded", () => {
  const text = sanitizeEvidenceText(
    `line one\r\n\x1b[31mred\x1b[0m ${PLANTED.GH_TOKEN}\n` + "z".repeat(900),
    300,
  );
  assert.ok(text.length <= 300, String(text.length));
  assert.ok(text.startsWith("line one\nred [REDACTED]\n"), text);
});
