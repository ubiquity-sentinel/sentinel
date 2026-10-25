// Delivery-train contract: strict manifest parser, digest identity, ref
// names and the commit message format (redesign 2026-10-25 C12, WP3.1).
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import { canonicalStringifySha256 } from "../../src/contracts/canonical.ts";
import {
  DELIVERY_TRAIN_MAX_MEMBERS,
  DELIVERY_TRAIN_MAX_MESSAGE_CHARS,
  deliveryTrainBranchV1,
  deliveryTrainCommitMessageV1,
  type DeliveryTrainId,
  deliveryTrainIdV1,
  deliveryTrainManifestV1,
  deliveryTrainParentsV1,
  deliveryTrainPrefixV1,
  deliveryTrainRefV1,
  deliveryTrainV1,
  hasDeliveryTrainParentsV1,
  hasDeliveryTrainTrailerV1,
  parseDeliveryTrainCommitMessageV1,
  parseDeliveryTrainManifestV1,
  parseDeliveryTrainRefV1,
} from "../../src/contracts/delivery-train.ts";
import { RecordParseError } from "../../src/contracts/validation.ts";
import {
  BASE,
  BRANCH,
  manifest,
  member,
  REPOSITORY,
  sha,
} from "../repair/train-fixtures.ts";

// Pinned digest of manifest([3, 5, 8]): a change to the digest domain,
// canonical form or manifest shape must be a deliberate contract change
// (recomputed independently with Python json.dumps(sort_keys) + sha256).
const PINNED_ID =
  "2f83f84e8769a5b5dda72b2e51fcbc16a50ccf567d772d0c1de1e1539d262e39";

function json(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value));
}

function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).reverse().map(([key, item]) => [
      key,
      reversedKeys(item),
    ]),
  );
}

function refuses(input: unknown, code: string, path?: string): void {
  assert.throws(
    () => parseDeliveryTrainManifestV1(input),
    (error: unknown) => {
      assert.ok(error instanceof RecordParseError);
      assert.equal(error.issues[0].code, code);
      if (path !== undefined) assert.equal(error.issues[0].path, path);
      return true;
    },
  );
}

Deno.test("delivery train: the digest is stable across key order and names its domain", async () => {
  const base = manifest([3, 5, 8]);
  const shuffled = reversedKeys(json(base));
  assert.notEqual(JSON.stringify(shuffled), JSON.stringify(base));
  const id = await deliveryTrainIdV1(base);
  assert.equal(
    await deliveryTrainIdV1(parseDeliveryTrainManifestV1(shuffled)),
    id,
  );
  assert.equal(
    id,
    await canonicalStringifySha256(["sentinel-delivery-train-v1", base]),
  );
  assert.notEqual(id, await canonicalStringifySha256(base));
  assert.equal(id, PINNED_ID);
  assert.match(id, /^[0-9a-f]{64}$/);
});

Deno.test("delivery train: every member field and the base change the digest", async () => {
  const id = await deliveryTrainIdV1(manifest([3, 5]));
  const variants = [
    manifest([3, 5], sha(7)),
    manifest([3, 6]),
    manifest([3]),
    deliveryTrainManifestV1({
      repository: REPOSITORY,
      branch: "develop",
      base: BASE,
      members: [member(3), member(5)],
    }),
    deliveryTrainManifestV1({
      repository: REPOSITORY,
      branch: BRANCH,
      base: BASE,
      members: [member(3), member(5, { receiptId: "review-receipt:other" })],
    }),
    deliveryTrainManifestV1({
      repository: REPOSITORY,
      branch: BRANCH,
      base: BASE,
      members: [member(3), member(5, { reviewedBase: sha(99) })],
    }),
  ];
  const ids = await Promise.all(variants.map(deliveryTrainIdV1));
  assert.equal(new Set([id, ...ids]).size, variants.length + 1);
});

Deno.test("delivery train: the builder orders members by (pr, recordId) and prefixes keep order", () => {
  const built = deliveryTrainManifestV1({
    repository: REPOSITORY,
    branch: BRANCH,
    base: BASE,
    members: [member(9), member(2), member(5)],
  });
  assert.deepEqual(built.members.map((m) => m.pr), [2, 5, 9]);
  assert.deepEqual(
    deliveryTrainPrefixV1(built, 2).members.map((m) => m.pr),
    [2, 5],
  );
  assert.throws(() => deliveryTrainPrefixV1(built, 0), RangeError);
  assert.throws(() => deliveryTrainPrefixV1(built, 4), RangeError);
  assert.deepEqual(deliveryTrainParentsV1(built), [
    BASE,
    member(2).head,
    member(5).head,
    member(9).head,
  ]);
  assert.equal(
    hasDeliveryTrainParentsV1(built, deliveryTrainParentsV1(built)),
    true,
  );
  assert.equal(
    hasDeliveryTrainParentsV1(built, [
      BASE,
      member(5).head,
      member(2).head,
      member(9).head,
    ]),
    false,
  );
  assert.equal(hasDeliveryTrainParentsV1(built, [BASE, member(2).head]), false);
});

Deno.test("delivery train: the parser refuses unknown, missing and mistyped fields", () => {
  const good = json(manifest([1, 2]));
  const members = good.members as Record<string, unknown>[];
  refuses({ ...good, extra: 1 }, "unknown_key", "$.extra");
  refuses(
    { ...good, members: [{ ...members[0], extra: 1 }, members[1]] },
    "unknown_key",
  );
  const { base: _base, ...missing } = good;
  refuses(missing, "missing_field", "$.base");
  refuses({ ...good, version: "v2" }, "invalid_version");
  refuses({ ...good, kind: "train" }, "invalid_enum");
  refuses(
    { ...good, repository: { ...REPOSITORY, installationId: 1 } },
    "unknown_key",
  );
  refuses(
    { ...good, repository: { owner: "-bad", name: "x" } },
    "invalid_pattern",
  );
  refuses({ ...good, base: BASE.slice(0, 39) }, "invalid_sha");
  refuses({ ...good, base: BASE.toUpperCase() }, "invalid_sha");
  refuses({ ...good, base: "a".repeat(64) }, "invalid_sha");
  refuses(
    { ...good, members: [{ ...members[0], head: "x" }, members[1]] },
    "invalid_sha",
  );
  refuses(
    { ...good, members: [{ ...members[0], pr: 0 }, members[1]] },
    "invalid_count",
  );
  refuses(
    { ...good, members: [{ ...members[0], pr: "1" }, members[1]] },
    "invalid_count",
  );
  refuses({
    ...good,
    members: [{ ...members[0], issueNumber: 1.5 }, members[1]],
  }, "invalid_count");
  refuses({
    ...good,
    members: [{ ...members[0], recordId: "issue/1" }, members[1]],
  }, "invalid_pattern");
  refuses({
    ...good,
    members: [{ ...members[0], receiptId: "a b" }, members[1]],
  }, "invalid_pattern");
  // deno-lint-ignore no-sparse-arrays
  refuses({ ...good, members: [members[0], , members[1]] }, "invalid_array");
  for (
    const branch of [
      "",
      "-x",
      "a..b",
      "a//b",
      "a/",
      "a.",
      "x.lock",
      "a/.b",
      "a@{1}",
      "sentinel-train/x",
      "a b",
    ]
  ) {
    refuses({ ...good, branch }, "invalid_pattern", "$.branch");
  }
  assert.equal(
    parseDeliveryTrainManifestV1({ ...good, branch: "release/v1.2" }).branch,
    "release/v1.2",
  );
});

Deno.test("delivery train: the parser bounds members to 1..63 and enforces order and uniqueness", () => {
  const good = json(manifest([1, 2, 3]));
  const members = good.members as Record<string, unknown>[];
  refuses({ ...good, members: [] }, "invalid_array", "$.members");
  const full = json(manifest(Array.from({ length: 63 }, (_, i) => i + 1)));
  assert.equal(
    parseDeliveryTrainManifestV1(full).members.length,
    DELIVERY_TRAIN_MAX_MEMBERS,
  );
  const over = json(manifest(Array.from({ length: 63 }, (_, i) => i + 1)));
  (over.members as unknown[]).push(json(member(64)));
  refuses(over, "bound_exceeded", "$.members");
  refuses(
    { ...good, members: [members[1], members[0], members[2]] },
    "invalid_value",
    "$.members[1]",
  );
  refuses(
    { ...good, members: [members[0], members[0], members[2]] },
    "invalid_value",
    "$.members[1].pr",
  );
  refuses(
    {
      ...good,
      members: [
        members[0],
        { ...members[1], recordId: members[0].recordId },
        members[2],
      ],
    },
    "invalid_value",
    "$.members[1].recordId",
  );
  refuses(
    {
      ...good,
      members: [
        members[0],
        { ...members[1], head: members[0].head },
        members[2],
      ],
    },
    "invalid_value",
    "$.members[1].head",
  );
  refuses(
    {
      ...good,
      members: [members[0], { ...members[1], head: BASE }, members[2]],
    },
    "invalid_value",
    "$.members[1].head",
  );
  refuses(
    {
      ...good,
      members: [members[0], {
        ...members[1],
        issueNumber: members[0].issueNumber,
      }, members[2]],
    },
    "invalid_value",
    "$.members[1].issueNumber",
  );
});

Deno.test("delivery train: ref and branch names are digest named and parse back exactly", async () => {
  const id = await deliveryTrainIdV1(manifest([4]));
  assert.equal(deliveryTrainBranchV1(id), `sentinel-train/${id}`);
  assert.equal(deliveryTrainRefV1(id), `refs/heads/sentinel-train/${id}`);
  assert.equal(parseDeliveryTrainRefV1(deliveryTrainRefV1(id)), id);
  assert.equal(
    parseDeliveryTrainRefV1(`refs/heads/sentinel-train/${id.toUpperCase()}`),
    null,
  );
  assert.equal(
    parseDeliveryTrainRefV1(`refs/heads/sentinel-train/${id.slice(1)}`),
    null,
  );
  assert.equal(
    parseDeliveryTrainRefV1(`refs/heads/sentinel-train/${id}/x`),
    null,
  );
  assert.equal(
    parseDeliveryTrainRefV1(`refs/heads/sentinel/train/${id}`),
    null,
  );
  assert.throws(() => deliveryTrainRefV1("abc" as DeliveryTrainId), TypeError);
});

Deno.test("delivery train: the commit message has the exact format, no closing keyword, and round trips", async () => {
  const train = await deliveryTrainV1(manifest([3, 5, 8]));
  const message = deliveryTrainCommitMessageV1(train);
  const lines = message.split("\n");
  assert.equal(
    lines[0],
    `Sentinel delivery train ${train.trainId.slice(0, 12)}`,
  );
  assert.equal(lines[1], "");
  assert.equal(lines[2], "Delivers #103, #105, #108");
  assert.equal(lines[3], "");
  assert.equal(lines[4], `Sentinel-Train: ${train.trainId}`);
  assert.match(lines[5], /^Sentinel-Train-Manifest: [A-Za-z0-9_-]+$/);
  assert.equal(lines.length, 6);
  assert.doesNotMatch(
    message,
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b/i,
  );
  assert.equal(hasDeliveryTrainTrailerV1(message), true);
  assert.equal(hasDeliveryTrainTrailerV1("Merge pull request #3"), false);
  assert.deepEqual(await parseDeliveryTrainCommitMessageV1(message), train);
  assert.deepEqual(
    await parseDeliveryTrainCommitMessageV1(`${message}\n`),
    train,
  );
});

Deno.test("delivery train: a maximal manifest stays inside the message bound and round trips", async () => {
  const long = (prefix: string, n: number) => `${prefix}${n}`.padEnd(256, "x");
  const members = Array.from(
    { length: 63 },
    (_, i) =>
      member(Number.MAX_SAFE_INTEGER - 63 + i, {
        head: sha(20_000 + i),
        recordId: asWorkItemId(long("r", i)),
        receiptId: long("q", i),
        issueNumber: Number.MAX_SAFE_INTEGER - 63 + i,
      }),
  );
  const train = await deliveryTrainV1(
    deliveryTrainManifestV1({
      repository: { owner: "o".repeat(39), name: "n".repeat(100) },
      branch: "b".repeat(256),
      base: BASE,
      members,
    }),
  );
  const message = deliveryTrainCommitMessageV1(train);
  assert.ok(
    message.length < DELIVERY_TRAIN_MAX_MESSAGE_CHARS / 2,
    `${message.length}`,
  );
  assert.deepEqual(await parseDeliveryTrainCommitMessageV1(message), train);
});

Deno.test("delivery train: the message parser refuses tampering and non-canonical encodings", async () => {
  const train = await deliveryTrainV1(manifest([3, 5]));
  const message = deliveryTrainCommitMessageV1(train);
  const lines = message.split("\n");
  const encoded = lines[5].slice("Sentinel-Train-Manifest: ".length);
  const other = await deliveryTrainV1(manifest([3, 6]));
  const otherEncoded = deliveryTrainCommitMessageV1(other).split("\n")[5];
  const b64url = (text: string) =>
    btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const nonCanonicalJson = b64url(
    JSON.stringify(reversedKeys(json(train.manifest))),
  );
  const lastChar = encoded.at(-1)!;
  const flipped = encoded.slice(0, -1) +
    (lastChar === "A" ? "B" : String.fromCharCode(lastChar.charCodeAt(0) ^ 1));
  const tampered = [
    lines.with(4, `Sentinel-Train: ${other.trainId}`),
    lines.with(5, otherEncoded),
    lines.with(2, "Delivers #103"),
    lines.with(2, "Resolves #103, #105"),
    lines.with(0, `Sentinel delivery train ${other.trainId.slice(0, 12)}`),
    lines.with(5, `Sentinel-Train-Manifest: ${encoded}=`),
    lines.with(5, `Sentinel-Train-Manifest: ${flipped}`),
    lines.with(5, `Sentinel-Train-Manifest: ${nonCanonicalJson}`),
    lines.with(5, `Sentinel-Train-Manifest: ${b64url("not json")}`),
    lines.slice(0, 5),
    [...lines, "Extra: trailer"],
  ].map((parts) => parts.join("\n"));
  tampered.push(
    `${message}\n\n`,
    message.replaceAll("\n", "\r\n"),
    `x${message}`,
  );
  for (const text of tampered) {
    await assert.rejects(
      () => parseDeliveryTrainCommitMessageV1(text),
      RecordParseError,
      JSON.stringify(text.slice(0, 80)),
    );
  }
  await assert.rejects(
    () =>
      parseDeliveryTrainCommitMessageV1(
        "x".repeat(DELIVERY_TRAIN_MAX_MESSAGE_CHARS + 1),
      ),
    RecordParseError,
  );
  // Each refusal names its own reason (no input echo).
  const reasons: [string, string][] = [
    [
      lines.with(5, `Sentinel-Train-Manifest: ${nonCanonicalJson}`).join("\n"),
      "train manifest is not canonical JSON",
    ],
    [
      lines.with(5, `Sentinel-Train-Manifest: ${encoded}=`).join("\n"),
      "expected canonical base64url manifest",
    ],
    [
      lines.with(5, `Sentinel-Train-Manifest: ${b64url("not json")}`).join(
        "\n",
      ),
      "train manifest is not JSON",
    ],
    [lines.slice(0, 5).join("\n"), "missing train manifest trailer"],
    [
      lines.with(4, `Sentinel-Train: ${other.trainId}`).join("\n"),
      "train message does not match its manifest",
    ],
  ];
  for (const [text, reason] of reasons) {
    await assert.rejects(
      () => parseDeliveryTrainCommitMessageV1(text),
      (error: unknown) =>
        error instanceof RecordParseError &&
        error.issues[0].message === reason,
    );
  }
});
