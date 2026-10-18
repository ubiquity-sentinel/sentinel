/** Closed, bounded capture validation for offline queue-rule preparation. */
import { canonicalStringify } from "../src/contracts/canonical.ts";
import { parseBranchRuleWire } from "../src/github/wire.ts";

export type JsonObject = Record<string, unknown>;
export class ProjectionRefusal extends Error {}
export function requireProjection(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new ProjectionRefusal(reason);
}
export function object(value: unknown): JsonObject {
  requireProjection(
    value !== null && typeof value === "object" &&
      !Array.isArray(value),
    "invalid_shape",
  );
  return value as JsonObject;
}
export function keys(
  value: unknown,
  required: string[],
  optional: string[] = [],
): JsonObject {
  const row = object(value);
  requireProjection(
    required.every((key) => Object.hasOwn(row, key)) &&
      Object.keys(row).every((key) => [...required, ...optional].includes(key)),
    "unsupported_shape",
  );
  return row;
}
export function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
export function same(a: unknown, b: unknown): boolean {
  return canonicalStringify(a) === canonicalStringify(b);
}
function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
export function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    !hasControlCharacters(value);
}

/** Copy before the first await; getters, cycles and oversized input cannot race hashing. */
export function captureCopy(value: unknown): unknown {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  let chars = 0;
  while (pending.length > 0) {
    const next = pending.pop()!;
    requireProjection(++nodes <= 30_000 && next.depth <= 24, "input_bound");
    if (typeof next.value === "string") chars += next.value.length;
    requireProjection(chars <= 2_000_000, "input_bound");
    if (next.value === null || typeof next.value !== "object") continue;
    requireProjection(
      Object.getOwnPropertySymbols(next.value).length === 0,
      "invalid_json",
    );
    const descriptors = Object.getOwnPropertyDescriptors(next.value);
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(next.value) && name === "length") continue;
      requireProjection(
        "value" in descriptor && descriptor.enumerable,
        "invalid_json",
      );
      chars += name.length;
      pending.push({ value: descriptor.value, depth: next.depth + 1 });
    }
  }
  const json = canonicalStringify(value);
  requireProjection(json.length <= 2_000_000, "input_bound");
  return JSON.parse(json);
}

export const API_VERSION = "2022-11-28";
export const CHECKS = [
  "darwin-native",
  "mac-containment",
  "validate",
  "verify-artifact",
];
export interface ProjectionIdentity {
  repository: {
    owner: string;
    name: string;
    id: number;
    installationId: number;
  };
  app: { id: number; nodeId: string; login: string; type: "Bot" };
}
export function identity(value: unknown): ProjectionIdentity {
  const root = keys(value, ["repository", "app"]);
  const repo = keys(root.repository, ["owner", "name", "id", "installationId"]);
  const app = keys(root.app, ["id", "nodeId", "login", "type"]);
  requireProjection(
    repo.owner === "ubiquity" && repo.name === "ai.ubq.fi" &&
      integer(repo.id) && integer(repo.installationId) && integer(app.id) &&
      text(app.nodeId) && app.login === "ubiquity-sentinel[bot]" &&
      app.type === "Bot",
    "identity_mismatch",
  );
  return root as unknown as ProjectionIdentity;
}

/** One page is intentional: any pagination requires a separately reviewed profile. */
function response(
  value: unknown,
  path: string,
  list: boolean,
  observedAt: number,
): unknown {
  const row = keys(value, ["method", "path", "status", "headers", "body"]);
  requireProjection(
    row.method === "GET" && row.path === path && row.status === 200,
    "response_mismatch",
  );
  const headers = object(row.headers);
  const lower = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    requireProjection(
      /^[a-zA-Z0-9-]+$/.test(name) && typeof value === "string" &&
        value.length <= 8192 && !hasControlCharacters(value) &&
        !lower.has(name.toLowerCase()),
      "invalid_headers",
    );
    lower.set(name.toLowerCase(), value);
  }
  requireProjection(!lower.has("link"), "incomplete_pages");
  const responseAt = Date.parse(lower.get("date") ?? "");
  requireProjection(
    lower.get("x-github-api-version-selected") === API_VERSION &&
      text(lower.get("x-github-request-id")) &&
      Number.isFinite(responseAt),
    "response_identity_missing",
  );
  // One bounded capture, allowing HTTP Date's one-second precision. This is
  // consistency of accepted evidence, not authentication or current freshness.
  requireProjection(
    responseAt >= observedAt - 300_000 && responseAt <= observedAt + 999,
    "response_time_mismatch",
  );
  if (list) {
    requireProjection(
      Array.isArray(row.body) && row.body.length < 100,
      "incomplete_pages",
    );
  }
  return row.body;
}

const RULESET_REQUIRED = [
  "id",
  "name",
  "target",
  "source_type",
  "source",
  "enforcement",
];
const RULESET_METADATA = ["node_id", "created_at", "updated_at", "_links"];
export function ruleSet(
  value: unknown,
  detailed: boolean,
  slug: string,
): JsonObject {
  const row = keys(value, [
    ...RULESET_REQUIRED,
    ...(detailed
      ? ["conditions", "bypass_actors", "current_user_can_bypass", "rules"]
      : []),
  ], [
    ...RULESET_METADATA,
    ...(detailed
      ? []
      : ["conditions", "bypass_actors", "current_user_can_bypass", "rules"]),
  ]);
  requireProjection(
    integer(row.id) && text(row.name) && row.source === slug &&
      row.source_type === "Repository",
    "unsupported_inheritance",
  );
  requireProjection(
    row.target === "branch" &&
      (row.enforcement === "disabled" || row.enforcement === "active"),
    "unsupported_target",
  );
  if (Object.hasOwn(row, "node_id")) {
    requireProjection(text(row.node_id), "invalid_metadata");
  }
  for (const key of ["created_at", "updated_at"]) {
    if (Object.hasOwn(row, key)) {
      requireProjection(
        text(row[key]) &&
          Number.isFinite(Date.parse(row[key])),
        "invalid_metadata",
      );
    }
  }
  if (Object.hasOwn(row, "_links")) {
    const links = keys(row._links, [], ["self", "html"]);
    for (const [key, value] of Object.entries(links)) {
      const link = keys(value, ["href"]);
      requireProjection(
        link.href ===
          (key === "self"
            ? `https://api.github.com/repos/${slug}/rulesets/${row.id}`
            : `https://github.com/${slug}/rules/${row.id}`),
        "invalid_metadata",
      );
    }
  }
  return row;
}

export function exactBranch(row: JsonObject): string {
  const conditions = keys(row.conditions, ["ref_name"]);
  const ref = keys(conditions.ref_name, ["include", "exclude"]);
  requireProjection(
    Array.isArray(ref.include) && ref.include.length === 1 &&
      Array.isArray(ref.exclude) && ref.exclude.length === 0 &&
      typeof ref.include[0] === "string" &&
      ["refs/heads/development", "refs/heads/queue-canary"].includes(
        ref.include[0],
      ),
    "unsupported_condition",
  );
  return ref.include[0].slice("refs/heads/".length);
}

export function exactRules(value: unknown): JsonObject[] {
  requireProjection(
    Array.isArray(value) && value.length === 4,
    "unsupported_rules",
  );
  const rows = value.map((value) => {
    const rule = object(value);
    const parameterized = rule.type === "merge_queue" ||
      rule.type === "required_status_checks";
    keys(rule, ["type", ...(parameterized ? ["parameters"] : [])]);
    return rule;
  });
  requireProjection(
    same(rows.map((r) => r.type).sort(), [
      "deletion",
      "merge_queue",
      "non_fast_forward",
      "required_status_checks",
    ]),
    "unsupported_rules",
  );
  const queue = rows.find((r) => r.type === "merge_queue")!;
  requireProjection(
    same(queue.parameters, {
      merge_method: "MERGE",
      grouping_strategy: "ALLGREEN",
      max_entries_to_build: 3,
      min_entries_to_merge: 1,
      max_entries_to_merge: 5,
      min_entries_to_merge_wait_minutes: 5,
      check_response_timeout_minutes: 60,
    }),
    "unsupported_parameters",
  );
  const checks = keys(
    rows.find((r) => r.type === "required_status_checks")!.parameters,
    [
      "strict_required_status_checks_policy",
      "do_not_enforce_on_create",
      "required_status_checks",
    ],
  );
  requireProjection(
    checks.strict_required_status_checks_policy === false &&
      checks.do_not_enforce_on_create === false &&
      Array.isArray(checks.required_status_checks) &&
      checks.required_status_checks.length === 4,
    "unsupported_parameters",
  );
  const contexts = checks.required_status_checks.map((check) => {
    const row = keys(check, ["context", "integration_id"]);
    requireProjection(row.integration_id === 15368, "unsupported_check_app");
    return row.context;
  });
  requireProjection(same(contexts.sort(), CHECKS), "unsupported_checks");
  return rows;
}

export interface ParsedProjectionCapture {
  raw: JsonObject;
  identity: ProjectionIdentity;
  observedAt: number;
  branch: "development" | "queue-canary";
  staged: JsonObject;
  inventory: JsonObject[];
  details: JsonObject[];
  effective: ReturnType<typeof parseBranchRuleWire>[];
  requestIds: string[];
}
export function parseProjectionCapture(
  value: unknown,
): ParsedProjectionCapture {
  const raw = keys(value, [
    "domain",
    "apiVersion",
    "identity",
    "observedAt",
    "branch",
    "stagedRulesetId",
    "inventory",
    "details",
    "effective",
  ]);
  requireProjection(
    raw.domain === "sentinel.queue-rules-capture.v1" &&
      raw.apiVersion === API_VERSION && integer(raw.observedAt) &&
      (raw.branch === "development" || raw.branch === "queue-canary") &&
      integer(raw.stagedRulesetId),
    "invalid_capture",
  );
  const who = identity(raw.identity);
  const slug = `${who.repository.owner}/${who.repository.name}`;
  const path = `/repos/${slug}`;
  const inventory = (response(
    raw.inventory,
    `${path}/rulesets?includes_parents=true&per_page=100&page=1`,
    true,
    raw.observedAt,
  ) as unknown[])
    .map((row) => ruleSet(row, false, slug));
  requireProjection(
    inventory.length > 0 && inventory.length <= 2 &&
      new Set(inventory.map((row) => row.id)).size === inventory.length &&
      Array.isArray(raw.details) && raw.details.length === inventory.length,
    "inventory_mismatch",
  );
  const details = raw.details.map((value, index) => {
    const row = inventory[index]!;
    const detail = ruleSet(
      response(
        value,
        `${path}/rulesets/${row.id}?includes_parents=true`,
        false,
        raw.observedAt as number,
      ),
      true,
      slug,
    );
    requireProjection(
      RULESET_REQUIRED.every((key) => same(row[key], detail[key])) &&
        Object.keys(row).every((key) => same(row[key], detail[key])),
      "inventory_mismatch",
    );
    exactBranch(detail);
    requireProjection(
      Array.isArray(detail.bypass_actors) &&
        detail.bypass_actors.length === 0 &&
        detail.current_user_can_bypass === "never",
      "bypass_unavailable",
    );
    exactRules(detail.rules);
    return detail;
  });
  const staged = details.find((row) => row.id === raw.stagedRulesetId);
  requireProjection(
    staged && exactBranch(staged) === raw.branch,
    "branch_mismatch",
  );
  requireProjection(
    details.every((row) =>
      row === staged ||
      exactBranch(row) !== raw.branch
    ),
    "overlapping_rules",
  );
  const effective = (response(
    raw.effective,
    `${path}/rules/branches/${raw.branch}?per_page=100&page=1`,
    true,
    raw.observedAt,
  ) as unknown[])
    .map((value) => {
      const row = keys(value, [
        "type",
        "ruleset_id",
        "ruleset_source_type",
        "ruleset_source",
      ], ["parameters"]);
      // Initial profile requires native omission of id/name; never invent active-only IDs.
      requireProjection(
        row.ruleset_id === staged.id &&
          row.ruleset_source_type === "Repository" &&
          row.ruleset_source === slug,
        "effective_identity_mismatch",
      );
      return parseBranchRuleWire(row, "$effective");
    });
  const requestIds = [raw.inventory, ...raw.details, raw.effective].map((
    entry,
  ) =>
    Object.entries(object(object(entry).headers)).find(([name]) =>
      name.toLowerCase() === "x-github-request-id"
    )![1] as string
  );
  requireProjection(
    new Set(requestIds).size === requestIds.length,
    "request_replayed",
  );
  return {
    raw,
    identity: who,
    observedAt: raw.observedAt,
    branch: raw.branch,
    staged,
    inventory,
    details,
    effective,
    requestIds,
  };
}
