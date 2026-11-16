/**
 * The secret-shape negative scan (`containsSecretShapedText`) that candidate
 * preservation, review-snapshot publication and replay fixtures share.
 *
 * Every synthetic credential below is assembled at run time from separate
 * string pieces, so this file itself is not secret-shaped: a candidate that
 * edits it is not refused, and its bytes trip no credential scanner. The
 * values are synthetic (led by `FAKE` where the key alphabet allows) but have
 * the real prefix, alphabet and length.
 */
import assert from "node:assert/strict";
import { containsSecretShapedText } from "../../src/replay/fixture.ts";

const encoder = new TextEncoder();
const shaped = (text: string) => containsSecretShapedText(encoder.encode(text));

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ALNUM = `${UPPER}${UPPER.toLowerCase()}0123456789`;
const BASE64URL = `${ALNUM}-_`;
const HEX = "0123456789abcdef";

/** `length` deterministic key characters from `alphabet`, led by FAKE. */
function fake(alphabet: string, length: number): string {
  let out = [..."FAKE"].every((ch) => alphabet.includes(ch)) ? "FAKE" : "";
  for (let i = 0; out.length < length; i++) {
    out += alphabet[(i * 7) % alphabet.length];
  }
  return out.slice(0, length);
}

const pem = (label: string) => ["-----BEGIN ", label, "PRIVATE", " KEY-----"];
const sk = (...parts: string[]) => ["s", "k-", ...parts].join("");

/** One real-format synthetic secret per shape each pattern family covers. */
const SECRETS: readonly [string, string][] = [
  ["PKCS#8 private key", pem("").join("")],
  ["RSA private key", pem("RSA ").join("")],
  ["EC private key", pem("EC ").join("")],
  ["encrypted private key", pem("ENCRYPTED ").join("")],
  ["OpenSSH private key", pem("OPENSSH ").join("")],
  ...["p", "o", "u", "s", "r"].map((kind): [string, string] => [
    `GitHub gh${kind}_ token`,
    ["gh", kind, "_", fake(ALNUM, 36)].join(""),
  ]),
  [
    "GitHub fine-grained token",
    ["github", "_pat_", fake(ALNUM, 22), "_", fake(ALNUM, 59)].join(""),
  ],
  ...["b", "a", "p", "r", "s"].map((kind): [string, string] => [
    `Slack xox${kind} token`,
    ["xox", kind, "-", "1234567890-", fake(ALNUM, 24)].join(""),
  ]),
  ["AWS access key id", ["AKIA", "FAKEEXAMPLE00000"].join("")],
  ["OpenAI legacy key", sk(fake(ALNUM, 48))],
  ["OpenAI project key", sk("proj-", fake(BASE64URL, 156))],
  ["OpenAI service-account key", sk("svcacct-", fake(BASE64URL, 120))],
  ["OpenAI admin key", sk("admin-", fake(BASE64URL, 120))],
  ["Anthropic API key", sk("ant-api03-", fake(BASE64URL, 93), "AA")],
  ["Anthropic admin key", sk("ant-admin01-", fake(BASE64URL, 93), "AA")],
  ["OpenRouter key", sk("or-v1-", fake(HEX, 64))],
  ["hex key", sk(fake(HEX, 32))],
  ["gateway virtual key", sk(fake(BASE64URL, 22))],
  ["shortest refused key body", sk(fake(ALNUM, 20))],
  ["human-chosen lowercase key", sk("my-team-gateway-secret-key")],
  ["Cerebras key", ["c", sk(fake(ALNUM, 48))].join("")],
];

/** Every position a secret can take in text that is still refused. */
const POSITIONS: readonly [string, (secret: string) => string][] = [
  ["the whole text", (s) => s],
  ["at line start", (s) => `first line\n${s} trailing words\n`],
  ["mid-line after a space", (s) => `the token ${s} was pasted here`],
  ["after an assignment", (s) => `API_KEY=${s}`],
  ["after a colon", (s) => `key:${s}`],
  ["in double quotes", (s) => `{"key":"${s}"}`],
  ["in single quotes", (s) => `key = '${s}'`],
  ["in backticks", (s) => "`" + s + "`"],
  ["in parentheses", (s) => `(${s})`],
  ["after a slash", (s) => `https://example.invalid/v1/${s}`],
  ["after a comma", (s) => `a,${s},b`],
  ["after a hyphenated word", (s) => `deploy-key-${s}`],
  ["after an underscore", (s) => `DEPLOY_KEY_${s}`],
  ["after a digit", (s) => `slot7${s}`],
  ["after a tab", (s) => `\t${s}`],
  ["after an escaped newline", (s) => `"line one\\n${s}"`],
  ["after an escaped tab", (s) => `"\\t${s}"`],
  ["after a percent-encoded =", (s) => `?key%3D${s}`],
  ["after a lowercase percent-encoded =", (s) => `?key%3d${s}`],
  ["after a quoted-printable =", (s) => `key=3D${s}`],
  ["after a hex escape", (s) => `"key\\x3d${s}"`],
  ["after a unicode escape", (s) => `"key\\u003d${s}"`],
  ["after an escaped colour code", (s) => `"\\u001b[32m${s}\\u001b[0m"`],
  ["after an escaped erase code", (s) => `"\\r\\u001b[K${s}"`],
  ["after an ordinary word's false prefix", (s) => `task-${s}`],
  ["after an ordinary identifier", (s) => `task-acceptance-not-fulfilled ${s}`],
];

/**
 * Ordinary hyphenated identifiers in which a word ending in `sk` puts `sk-`
 * before twenty key characters. The scan's previous `sk-` pattern (no token
 * boundary) refused each, so any file holding one, such as docs/DECISIONS.md
 * with the finding id `task-acceptance-not-fulfilled`, could never be
 * published by a candidate.
 */
const IDENTIFIERS = [
  "task-acceptance-not-fulfilled",
  "Task-Acceptance-Not-Fulfilled",
  "task-acceptance-not-fulfilled-2026-10-17",
  "task-acceptance_not_fulfilled",
  "risk-p0-findings-unresolved-at-head",
  "ask-the-owner-before-any-promotion",
  "desk-check-every-acceptance-row",
  "disk-pressure-on-the-hosted-runner",
  "mask-each-credential-in-ci-evidence",
  "flask-blueprint-registration-order",
  "kiosk-display-refresh-interval-ms",
  "whisk-away-every-stale-preservation-ref",
];
const PREVIOUS_SK_PATTERN = /sk-[A-Za-z0-9_-]{20,}/;

Deno.test("secret shape: every real-format secret family is refused in every position", () => {
  for (const [family, secret] of SECRETS) {
    for (const [position, place] of POSITIONS) {
      assert.ok(shaped(place(secret)), `${family} ${position}`);
    }
  }
});

Deno.test("secret shape: an sk- prefix inside an ordinary word is not a key", () => {
  for (const id of IDENTIFIERS) {
    assert.match(id, PREVIOUS_SK_PATTERN, `${id} was a false positive`);
    for (
      const text of [
        id,
        `(id\n\`${id}\`, the reviewer's acceptance evidence)`,
        `docs/findings/${id}.md`,
        `const finding = "${id}";\n`,
        `- ${id}: retained`,
      ]
    ) {
      assert.equal(shaped(text), false, JSON.stringify(text));
    }
  }
});

Deno.test("secret shape: the decision record and this file are publishable", async () => {
  // A candidate that edits docs/DECISIONS.md is scanned whole, so the record
  // itself must stay free of secret-shaped text (sentinel issue 249).
  for (
    const url of [
      new URL("../../docs/DECISIONS.md", import.meta.url),
      new URL(import.meta.url),
    ]
  ) {
    const bytes = await Deno.readFile(url);
    assert.equal(containsSecretShapedText(bytes), false, url.pathname);
  }
});
