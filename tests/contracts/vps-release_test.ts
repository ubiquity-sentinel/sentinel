import assert from "node:assert/strict";
import {
  parseVpsReleaseRecordV1,
  validateVpsReleaseTransition,
  vpsRecordBindsRequest,
} from "../../src/contracts/vps-release.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";

const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL("../fixtures/vps/release-requested-v1.json", import.meta.url),
  ),
);
Deno.test("VPS contracts bind exact request and retain canonical absence on legacy release state", async () => {
  const record = parseVpsReleaseRecordV1(fixture);
  assert.equal(await vpsRecordBindsRequest(record, record.request), true);
  assert.equal(
    await vpsRecordBindsRequest(record, {
      ...record.request,
      revision: record.driver.prior.identity
        .gitSha as typeof record.request.revision,
    }),
    false,
  );
  const legacy = {
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: 1,
    releases: [],
    hostedRuntimes: [],
    hostedReleases: [],
    githubCooldowns: [],
  };
  assert.equal(
    canonicalStringify(parseReleaseStateSnapshotV1(legacy)),
    canonicalStringify(legacy),
  );
  assert.equal(
    Object.hasOwn(parseReleaseStateSnapshotV1(legacy), "vpsReleases"),
    false,
  );
  assert.equal(
    parseReleaseStateSnapshotV1({ ...legacy, vpsReleases: [record] })
      .vpsReleases?.length,
    1,
  );
});
Deno.test("VPS contracts reject Deno identity, foreign driver binding and terminal resets", () => {
  assert.throws(() =>
    parseVpsReleaseRecordV1({
      ...fixture,
      driver: {
        ...fixture.driver,
        candidate: { ...fixture.driver.candidate, deploymentId: "deno-build" },
      },
    })
  );
  assert.throws(() =>
    parseVpsReleaseRecordV1({
      ...fixture,
      driver: {
        ...fixture.driver,
        binding: { ...fixture.driver.binding, requestId: "foreign" },
      },
    })
  );
  assert.throws(() =>
    parseVpsReleaseRecordV1({ ...fixture, phase: "accepted" })
  );
  const first = parseVpsReleaseRecordV1(fixture);
  assert.match(validateVpsReleaseTransition([first], []) ?? "", /disappear/);
  assert.match(
    validateVpsReleaseTransition([first], [{
      ...first,
      requestDigest: "f".repeat(64),
    }]) ?? "",
    /identity/,
  );
});
