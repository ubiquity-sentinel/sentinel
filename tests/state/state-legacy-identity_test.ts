import assert from "node:assert/strict";
import {
  legacyIdentityRecordId,
  legacyIdentityRecordMatches,
} from "../../src/state/state-legacy-identity.ts";

Deno.test("state legacy identity: only the retired controller identity is accepted", () => {
  assert.equal(
    legacyIdentityRecordMatches(
      "work",
      {
        repository: { owner: "ubiquity", name: "sentinel", installationId: 0 },
      },
      {
        repository: {
          owner: "ubiquity-sentinel",
          name: "sentinel",
          installationId: 0,
        },
      },
    ),
    true,
  );
  assert.equal(
    legacyIdentityRecordMatches(
      "hostedReleases",
      { priorProof: { repository: "ubiquity/sentinel" } },
      { priorProof: { repository: "ubiquity-sentinel/sentinel" } },
    ),
    true,
  );
  assert.equal(
    legacyIdentityRecordMatches(
      "hostedRuntimes",
      { id: "ubiquity/sentinel:0:production" },
      { id: "ubiquity-sentinel/sentinel:0:production" },
    ),
    true,
  );
  assert.equal(
    legacyIdentityRecordMatches(
      "work",
      {
        repository: { owner: "ubiquity", name: "sentinel", installationId: 1 },
      },
      {
        repository: {
          owner: "ubiquity-sentinel",
          name: "sentinel",
          installationId: 1,
        },
      },
    ),
    false,
  );
  assert.equal(
    legacyIdentityRecordMatches(
      "work",
      { repository: { owner: "ubiquity", name: "other", installationId: 0 } },
      {
        repository: {
          owner: "ubiquity-sentinel",
          name: "other",
          installationId: 0,
        },
      },
    ),
    false,
  );
  assert.equal(
    legacyIdentityRecordMatches(
      "hostedReleases",
      { priorProof: { repository: "ubiquity/sentinel" } },
      { priorProof: { repository: "ubiquity-sentinel/sentinel" }, extra: true },
    ),
    false,
  );
});

Deno.test("state legacy identity: only the legacy runtime record keeps its retired digest key", () => {
  assert.equal(
    legacyIdentityRecordId("hostedRuntimes", {
      id: "ubiquity/sentinel:0:production",
    }),
    "ubiquity/sentinel:0:production",
  );
  assert.equal(
    legacyIdentityRecordId("hostedRuntimes", {
      id: "ubiquity-sentinel/sentinel:0:production",
    }),
    null,
  );
  assert.equal(
    legacyIdentityRecordId("work", { id: "ubiquity/sentinel:0:production" }),
    null,
  );
});
