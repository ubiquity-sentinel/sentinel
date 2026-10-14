// Original test registrations grouped by cohesive production behavior.
import assert from "node:assert/strict";
import { parseIncidentSummaryV1 } from "../../src/contracts/incident.ts";
import type { IncidentSummaryV1 } from "../../src/contracts/incident.ts";
import type {
  IncidentCoverageV1,
  RepositoryIdentityV1,
} from "../../src/contracts/shared.ts";
import {
  expectExactKeys,
  expectRecord,
  RecordParseError,
} from "../../src/contracts/validation.ts";

const GATEWAY_ROW_KEYS = [
  "incident_id",
  "fingerprint",
  "severity",
  "first_seen_at_ms",
  "last_seen_at_ms",
  "count",
  "failing_revision",
  "error_type",
  "context",
  "provenance",
  "evidence_ref",
  "evidence_expires_at_ms",
] as const;
const GATEWAY_CONTEXT_KEYS = ["message", "location", "sample"] as const;
const GATEWAY_PROVENANCE_KEYS = [
  "endpoint",
  "captured_at_ms",
  "captured_by",
] as const;
const GATEWAY_EVIDENCE_REF_KEYS = ["ref", "digest"] as const;
/**
 * The target's existing incident identity format: `src/sentinel_incident_outbox.ts`
 * `INCIDENT_ID` at the recorded setup snapshot
 * (`aafb7ee0598699bb7fb8a72ea133693ed64462da`). The frozen generic incident
 * parser accepts bounded text, so this mapping boundary pins the exact format
 * the gateway replay export actually requires; rows outside it fail closed.
 */
const GATEWAY_INCIDENT_ID =
  /^provider-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Exact wire row shape of the proposed gateway index page. */
interface GatewayIndexRowV1 {
  incident_id: string;
  fingerprint: string;
  severity: string;
  first_seen_at_ms: number;
  last_seen_at_ms: number;
  count: number;
  failing_revision: string | null;
  error_type: string;
  context: { message: string; location: string | null; sample: string[] };
  provenance: {
    endpoint: string;
    captured_at_ms: number;
    captured_by: string | null;
  };
  evidence_ref: { ref: string; digest: string } | null;
  evidence_expires_at_ms: number | null;
}

/** Test-only wire row → IncidentSummaryV1 conversion (m02 owns the adapter). */
function gatewayRowToSummary(
  input: unknown,
  repository: RepositoryIdentityV1,
  coverage: IncidentCoverageV1,
): IncidentSummaryV1 {
  const row = expectRecord(input, "$");
  expectExactKeys(row, GATEWAY_ROW_KEYS, "$");
  const context = expectRecord(row.context, "$.context");
  expectExactKeys(context, GATEWAY_CONTEXT_KEYS, "$.context");
  const provenance = expectRecord(row.provenance, "$.provenance");
  expectExactKeys(provenance, GATEWAY_PROVENANCE_KEYS, "$.provenance");
  let evidenceRef: { ref: string; digest: string | null } | null = null;
  if (row.evidence_ref !== null) {
    const evidence = expectRecord(row.evidence_ref, "$.evidence_ref");
    expectExactKeys(evidence, GATEWAY_EVIDENCE_REF_KEYS, "$.evidence_ref");
    evidenceRef = {
      ref: evidence.ref as string,
      digest: evidence.digest as string | null,
    };
  }
  // Repository identity and provenance.source are trusted adapter
  // configuration/constants, never wire fields; evidence expiry is consumed by
  // the evidence stage (artifacts[].expiresAt), not carried on the summary.
  const summary: Record<string, unknown> = {
    version: "v1",
    kind: "incident_summary",
    repository,
    id: row.incident_id,
    fingerprint: row.fingerprint,
    severity: row.severity,
    firstSeenAt: row.first_seen_at_ms,
    lastSeenAt: row.last_seen_at_ms,
    count: row.count,
    failingRevision: row.failing_revision,
    errorType: row.error_type,
    context: {
      message: context.message,
      location: context.location,
      sample: context.sample,
    },
    provenance: {
      source: "gateway",
      endpoint: provenance.endpoint,
      capturedAt: provenance.captured_at_ms,
      capturedBy: provenance.captured_by,
    },
    coverage,
    evidenceRef,
  };
  // The frozen parser is the authority: every value is re-validated here.
  return parseIncidentSummaryV1(summary);
}

Deno.test("gateway index fixture maps into frozen IncidentSummaryV1 records", async () => {
  const page = JSON.parse(
    await Deno.readTextFile(
      new URL("../fixtures/contracts/gateway-index-v1.json", import.meta.url),
    ),
  ) as {
    data: GatewayIndexRowV1[];
    cursor: string | null;
    coverage: IncidentCoverageV1;
  };
  assert.equal(page.coverage.status, "complete");
  assert.equal(page.cursor, null);
  // Every fixture id must already satisfy the target's existing incident id
  // format, and the old synthetic form is rejected: the generic incident
  // parser is permissive, so this pins the format the replay export accepts.
  for (const row of page.data) {
    assert.ok(
      GATEWAY_INCIDENT_ID.test(row.incident_id),
      `fixture incident_id ${row.incident_id} is not in the target provider-UUID format`,
    );
  }
  assert.equal(GATEWAY_INCIDENT_ID.test("sentinel-synth-0001"), false);
  const repository: RepositoryIdentityV1 = {
    owner: "ubiquity",
    name: "ai.ubq.fi",
    installationId: 12345,
  };
  const summaries = page.data.map((row) =>
    gatewayRowToSummary(row, repository, page.coverage)
  );
  assert.equal(summaries.length, 2);

  const first = summaries[0];
  assert.equal(first.id, "provider-00000000-0000-4000-8000-000000000001");
  assert.equal(first.fingerprint, page.data[0].fingerprint);
  assert.equal(first.severity, "P1");
  assert.equal(first.count, 7);
  assert.equal(first.failingRevision, page.data[0].failing_revision);
  assert.equal(first.provenance.source, "gateway");
  assert.equal(first.provenance.endpoint, "https://ai.ubq.fi");
  assert.equal(
    first.evidenceRef?.ref,
    "artifact://sentinel/synth-0001/capture-1.pgp",
  );
  assert.equal(
    first.evidenceRef?.digest,
    page.data[0].evidence_ref?.digest ?? null,
  );
  // Page coverage belongs to each mapped summary.
  assert.deepEqual(first.coverage, { status: "complete" });

  const second = summaries[1];
  // Missing failing revision / evidence blocks later replay stages, never
  // discovery: the row still maps, with explicit nulls (never fabricated).
  assert.equal(second.failingRevision, null);
  assert.equal(second.evidenceRef, null);
  assert.equal(second.count, 1);

  // Fail closed: unknown row keys and malformed values are rejected at the
  // mapping boundary before any summary can be produced.
  assert.throws(() =>
    gatewayRowToSummary(
      { ...(page.data[0] as object), claim_url: "https://not-a-row-key" },
      repository,
      page.coverage,
    )
  );
  assert.throws(
    () =>
      gatewayRowToSummary(
        { ...(page.data[0] as object), count: 0 },
        repository,
        page.coverage,
      ),
    (error: unknown) => error instanceof RecordParseError,
  );
});
