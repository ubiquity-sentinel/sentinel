/**
 * CI evidence fixtures; no test registrations.
 *
 * `tests/fixtures/ci-evidence/real-*.txt` are trimmed job logs of live red
 * Sentinel pull requests on ubiquity/ai.ubq.fi (failing `validate` job of
 * "Gateway CI"): only whole lines were dropped and lines above 1,000
 * characters were shortened; GitHub's own `***` masks are the only
 * credential-shaped text in them. `synthetic-*.txt` are hand-written logs in
 * the same format for shapes the live set lacks. Credential-shaped strings
 * are planted only at test time (`{{NAME}}` placeholders below), assembled
 * from fragments so no committed file carries a scanner-matching token.
 */
const ROOT = decodeURIComponent(
  new URL("../fixtures/ci-evidence/", import.meta.url).pathname,
);

/** Fake credential-shaped strings substituted into the injection fixture. */
export const PLANTED: Readonly<Record<string, string>> = {
  GH_TOKEN: "gh" + "p_" + "aB3dE5gH7jK9mN1pQ3sT5vX7zA9cD1fG3hJ5",
  GH_PAT: "github" + "_pat_" + "11ABCDEFG0aaaaaaaaaa_bbbbbbbbbbCCCC1234",
  BEARER: "Zm9vYmFy" + "YmF6cXV4MTIzNDU2Nzg5",
  AWS_KEY: "AK" + "IA" + "IOSFODNN7EXAMPLE",
  SLACK: "xo" + "xb-" + "1234567890-abcdefghij",
  OPENAI: "s" + "k-" + "proj1234567890abcdefXYZ",
  JWT: "ey" + "JhbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0" +
    "." + "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  PASSWORD: "hunter2" + "hunter2X9",
  BASE64: "QmFzZTY0RW5j" +
    "b2RlZFNlY3JldFZhbHVlMTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE1O",
};

/**
 * Redactions the injection fixture must produce: one per planted value plus
 * the planted SAS `sig` and `se` query values.
 */
export const PLANTED_REDACTIONS = Object.keys(PLANTED).length + 2;

export const REAL_FIXTURES = [
  "real-1009.txt",
  "real-1119.txt",
  "real-1154.txt",
  "real-1144.txt",
  "real-1003.txt",
] as const;

export const SYNTHETIC_FIXTURES = [
  "synthetic-cargo.txt",
  "synthetic-pytest.txt",
  "synthetic-go-make.txt",
  "synthetic-opaque.txt",
  "synthetic-infra-checkout.txt",
  "synthetic-runner-lost.txt",
  "synthetic-timeout-hang.txt",
  "synthetic-injection.txt",
  "synthetic-gen-drift.txt",
  "synthetic-jest-diff.txt",
  "synthetic-traceback-mid.txt",
] as const;

export type CiFixtureName =
  | typeof REAL_FIXTURES[number]
  | typeof SYNTHETIC_FIXTURES[number];

/** The exact true error lines (sanitized form) each real log must keep. */
export const REAL_ERROR_LINES: Readonly<Record<string, readonly string[]>> = {
  "real-1009.txt": [
    "[warn] src/provider/lithos-rate-limits.ts",
    "[warn] Code style issues found in the above file. Run Prettier with --write to fix.",
    "!!! FAILED: prettier (all supported first-party formats)",
    "src/provider/lithos-rate-limits.ts",
    "  81:9  error  Extract this nested ternary operation into an independent statement  sonarjs/no-nested-conditional",
    "!!! FAILED: eslint (template ruleset)",
    "verify: FAILED",
  ],
  "real-1119.txt": [
    "tests/provider-selection.test.ts(654,36): error TS2345: Argument of type 'SelectionKv' is not assignable to parameter of type 'Kv'.",
    "  Type 'SelectionKv' is missing the following properties from type 'Kv': getMany, delete, list, enqueue, and 4 more.",
  ],
  "real-1154.txt": [
    "  728:33  error  Async arrow function has no 'await' expression  @typescript-eslint/require-await",
    "!!! FAILED: eslint (template ruleset)",
    "error: the gateway never started the upstream handshake",
    "(fail) GET /v1/live/<call_id> retires a terminal upstream mapping before closing and allowing reconnect [2027.48ms]",
  ],
  "real-1144.txt": [
    "AssertionError: Expected values to be strictly equal:",
    "+ 'releases/b172b478d60ec1d24a890fb57f067490b2d127c9'",
    "- 'releases/409e9736f6bdc5779fc40f69b219ddfcd0d8b701'",
    "(fail) VPS same-SHA retry restores the previous release after an interrupted candidate-ready run [6436.33ms]",
    "FAILED tests/vps-deploy-guards.test.ts (exit 1)",
  ],
  "real-1003.txt": [
    "AssertionError: Expected values to be strictly equal:",
    "502 !== 200",
    "(fail) openai: Cerebras GPT-OSS Chat Completions adapter is native, bounded, and content-safe [1102.81ms]",
  ],
};

/** Fixture text with planted values substituted. */
export function fixtureText(name: CiFixtureName): string {
  let text = Deno.readTextFileSync(ROOT + name);
  for (const [key, value] of Object.entries(PLANTED)) {
    text = text.replaceAll(`{{${key}}}`, value);
  }
  return text;
}

export function fixtureBytes(name: CiFixtureName): Uint8Array {
  return new TextEncoder().encode(fixtureText(name));
}
