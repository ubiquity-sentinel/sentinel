/** Synthetic-only capture identities. None is native evidence or a production pin. */
import {
  type AcceptedQueueRulesProjectionProfile,
  queueRulesCaptureSha256,
} from "../../ops/queue-rules-projection.ts";

export const IDENTITY = {
  repository: {
    owner: "ubiquity",
    name: "ai.ubq.fi",
    id: 900_000,
    installationId: 900_002,
  },
  app: {
    id: 900_003,
    nodeId: "SYNTHETIC_BOT_NODE",
    login: "ubiquity-sentinel[bot]",
    type: "Bot" as const,
  },
};
export const ROOT = "/repos/ubiquity/ai.ubq.fi";
export const NOW = Date.parse("2026-10-18T00:00:00Z");
export const RULES = [
  {
    type: "merge_queue",
    parameters: {
      merge_method: "MERGE",
      grouping_strategy: "ALLGREEN",
      max_entries_to_build: 3,
      min_entries_to_merge: 1,
      max_entries_to_merge: 5,
      min_entries_to_merge_wait_minutes: 5,
      check_response_timeout_minutes: 60,
    },
  },
  {
    type: "required_status_checks",
    parameters: {
      strict_required_status_checks_policy: false,
      do_not_enforce_on_create: false,
      required_status_checks: [
        "validate",
        "verify-artifact",
        "darwin-native",
        "mac-containment",
      ]
        .map((context) => ({ context, integration_id: 15368 })),
    },
  },
  { type: "deletion" },
  { type: "non_fast_forward" },
];
export function detail(
  branch: "development" | "queue-canary",
  active: boolean,
) {
  return {
    id: branch === "queue-canary" ? 900_001 : 900_004,
    name: `${branch} synthetic queue`,
    target: "branch",
    source_type: "Repository",
    source: "ubiquity/ai.ubq.fi",
    enforcement: active ? "active" : "disabled",
    conditions: {
      ref_name: { include: [`refs/heads/${branch}`], exclude: [] as string[] },
    },
    bypass_actors: [] as unknown[],
    current_user_can_bypass: "never",
    rules: structuredClone(RULES),
  };
}
export function inventoryRow(value: ReturnType<typeof detail>) {
  return {
    id: value.id,
    name: value.name,
    target: value.target,
    source_type: value.source_type,
    source: value.source,
    enforcement: value.enforcement,
  };
}
export function http(path: string, body: unknown, count: number) {
  return {
    method: "GET",
    path,
    status: 200,
    headers: {
      Date: new Date(NOW + count).toUTCString(),
      "X-GitHub-Request-Id": `SYNTHETIC-${count}-${path}`,
      "X-GitHub-Api-Version-Selected": "2022-11-28",
    } as Record<string, string>,
    body,
  };
}
export function capture(
  branch: "development" | "queue-canary",
  active: boolean,
  count: number,
) {
  const ruleSet = detail(branch, active);
  const rules = active
    ? ruleSet.rules.map((rule) => ({
      ...rule,
      ruleset_source_type: ruleSet.source_type,
      ruleset_source: ruleSet.source,
      ruleset_id: ruleSet.id,
    }))
    : [];
  return {
    domain: "sentinel.queue-rules-capture.v1",
    apiVersion: "2022-11-28",
    identity: structuredClone(IDENTITY),
    observedAt: NOW + count,
    branch,
    stagedRulesetId: ruleSet.id,
    inventory: http(
      `${ROOT}/rulesets?includes_parents=true&per_page=100&page=1`,
      [inventoryRow(ruleSet)],
      count,
    ),
    details: [
      http(
        `${ROOT}/rulesets/${ruleSet.id}?includes_parents=true`,
        ruleSet,
        count,
      ),
    ],
    effective: http(
      `${ROOT}/rules/branches/${branch}?per_page=100&page=1`,
      rules,
      count,
    ),
  };
}
export type CaptureFixture = ReturnType<typeof capture>;
export function stagedDetail(capture: CaptureFixture) {
  return capture.details[0]!.body as ReturnType<typeof detail>;
}
export async function projectionFixture() {
  const input = {
    canary: [
      capture("queue-canary", false, 1),
      capture("queue-canary", true, 2),
      capture("queue-canary", false, 3),
      capture("queue-canary", true, 4),
    ],
    staged: [
      capture("development", false, 6),
      capture("development", false, 7),
    ],
  };
  const profile: AcceptedQueueRulesProjectionProfile = {
    domain: "sentinel.queue-rules-profile.v1",
    compilerRevision: "a".repeat(40),
    captureSourceRevision: "b".repeat(40),
    identity: structuredClone(IDENTITY),
    acceptedAt: NOW + 5,
    canaryCaptureSha256: await Promise.all(
      input.canary.map(queueRulesCaptureSha256),
    ) as [string, string, string, string],
  };
  return { input, profile };
}
export async function repinSynthetic(
  fixture: Awaited<ReturnType<typeof projectionFixture>>,
) {
  fixture.profile.canaryCaptureSha256 = await Promise.all(
    fixture.input.canary.map(queueRulesCaptureSha256),
  ) as [string, string, string, string];
}
