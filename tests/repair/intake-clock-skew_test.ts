/**
 * Intake must survive a platform timestamp ahead of the trusted clock.
 *
 * On 2026-11-01 GitHub reported issue creation times +3600 s ahead of the
 * runner clock; `firstSeenAt > updatedAt` then failed the frozen lifecycle
 * parse and the uncaught error ended the whole repair run. A first-seen time
 * is clamped to the intake clock, never trusted ahead of it.
 */
import assert from "node:assert/strict";
import { createIssueWork } from "../../src/repair/transitions.ts";
import { SHA1, SHA2, T0 } from "../state/helpers.ts";

const context = {
  controllerSha: SHA1,
  repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 1 },
  observedBase: SHA2,
  now: T0,
};

Deno.test("intake clamps an issue created ahead of the trusted clock", () => {
  const record = createIssueWork(
    { number: 7, title: "future", labels: [], createdAt: T0 + 3_600_000 },
    context,
  );
  assert.equal(record.firstSeenAt, T0);
  assert.equal(record.createdAt, T0);
  assert.equal(record.updatedAt, T0);
});

Deno.test("intake keeps a past creation time as first seen", () => {
  const record = createIssueWork(
    { number: 8, title: "past", labels: [], createdAt: T0 - 5_000 },
    context,
  );
  assert.equal(record.firstSeenAt, T0 - 5_000);
});
