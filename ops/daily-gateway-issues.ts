import {
  DAILY_GATEWAY_KINDS,
  DAILY_GATEWAY_ROUTES,
  type DailyGatewayScanReport,
  parseDailyGatewayScanReport,
} from "./daily-gateway-scan.ts";
import {
  createHostedFollowUpIssues,
  parseIssueItem,
} from "./hosted-autonomy-github-issues.ts";
import {
  API_BASE,
  LISTING_PAGE_SIZE,
} from "./hosted-autonomy-github-listing.ts";
import { HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR } from "./hosted-autonomy-policy.ts";

const REPOSITORY = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155_687_488,
};
const TARGET = REPOSITORY.owner + "/" + REPOSITORY.name;
const REPOSITORY_API = "/repos/" + TARGET;
const CONTROLLER = "ubiquity-sentinel/sentinel";
const MAX_LIST_PAGES = 8;
const SHA = /^[a-f0-9]{40}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const MARKER_PREFIX = "<!-- sentinel:daily-gateway-failure:v1 ";
const MARKER =
  /^<!-- sentinel:daily-gateway-failure:v1 kind=([a-z0-9_]+) route=([a-z0-9.]+) release=([a-f0-9]{40}) -->$/;

type Finding = DailyGatewayScanReport["findings"][number];
type IssueRequest = (
  method: string,
  path: string,
  body?: Record<string, unknown>,
  maxBytes?: number,
) => Promise<unknown | null>;

interface ExistingIssue {
  state: "open" | "closed";
  kind: string;
  route: string;
  release: string;
}

class PublicationError extends Error {}

function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new PublicationError(message);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function githubRequest(token: string): IssueRequest {
  return async (method, path, body, maxBytes = 1_048_576) => {
    try {
      const response = await fetch(API_BASE + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          authorization: "Bearer " + token,
          accept: "application/vnd.github+json",
          "user-agent": "sentinel-daily-gateway-issues",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (
        response.status !== (method === "POST" ? 201 : 200) ||
        response.body === null
      ) {
        await response.body?.cancel();
        return null;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let total = 0;
      let text = "";
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          total += part.value.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            return null;
          }
          text += decoder.decode(part.value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
      const decoded = JSON.parse(text + decoder.decode());
      if (
        path.startsWith(REPOSITORY_API + "/issues?") &&
        response.headers.get("link")?.includes('rel="next"') &&
        Array.isArray(decoded) && decoded.length < LISTING_PAGE_SIZE
      ) return null;
      return decoded;
    } catch {
      return null;
    }
  };
}

async function verifyTokenScope(request: IssueRequest) {
  const scope = record(
    await request("GET", "/installation/repositories?per_page=2"),
  );
  const list = scope?.repositories;
  require(
    scope?.total_count === 1 && Array.isArray(list) && list.length === 1,
    "issue token target scope could not be verified",
  );
  const target = record(list[0]);
  require(
    target?.full_name === TARGET && target.private === false &&
      target.has_issues === true,
    "issue token target scope could not be verified",
  );
}

async function readExisting(request: IssueRequest): Promise<ExistingIssue[]> {
  const seen = new Set<number>();
  const markers: ExistingIssue[] = [];
  let latest = Number.POSITIVE_INFINITY;
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const query = new URLSearchParams({
      state: "all",
      creator: HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
      sort: "created",
      direction: "desc",
      per_page: String(LISTING_PAGE_SIZE),
      page: String(page),
    });
    const raw = await request(
      "GET",
      REPOSITORY_API + "/issues?" + query,
      undefined,
      8 * 1_048_576,
    );
    require(
      Array.isArray(raw) && raw.length <= LISTING_PAGE_SIZE,
      "existing issue listing unavailable",
    );
    for (const value of raw) {
      const item = parseIssueItem(value, API_BASE + REPOSITORY_API);
      require(
        item && !seen.has(item.number) && item.createdAt <= latest,
        "existing issue listing changed during pagination",
      );
      seen.add(item.number);
      latest = item.createdAt;
      if (
        item.pullRequest ||
        item.author !== HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR ||
        record(record(value)?.user)?.type !== "Bot" ||
        !item.firstLine.startsWith(MARKER_PREFIX)
      ) {
        continue;
      }
      const m = MARKER.exec(item.firstLine);
      require(
        m && item.state && DAILY_GATEWAY_KINDS.some((kind) => kind === m[1]) &&
          DAILY_GATEWAY_ROUTES.some((route) => route === m[2]) &&
          SHA.test(m[3]),
        "an existing daily issue marker is invalid",
      );
      markers.push({
        state: item.state,
        kind: m[1],
        route: m[2],
        release: m[3],
      });
    }
    if (raw.length < LISTING_PAGE_SIZE) return markers;
  }
  throw new PublicationError("existing issue listing exceeded its page budget");
}

const KIND_NAMES = {
  gateway_5xx: "gateway server errors",
  unexpected_upstream_stream_end: "unexpected upstream stream endings",
};

function issueFor(
  finding: Finding,
  report: DailyGatewayScanReport,
  run: string,
) {
  const { kind, route, count, release_sha: release } = finding;
  const { start_ms: start, end_ms: end } = report.window;
  const description = KIND_NAMES[kind];
  const window = new Date(start).toISOString() + " to " +
    new Date(end).toISOString();
  return {
    title: "Investigate recurring " + description + " on " + route,
    body: [
      MARKER_PREFIX + "kind=" + kind + " route=" + route + " release=" +
      release + " -->",
      "",
      "Production gateway telemetry recorded " + count + " occurrences on " +
      route + " during " + window + " for release " + release + ".",
      ...(report.coverage === "partial"
        ? ["Count from the bounded telemetry sample."]
        : []),
      "",
      "Investigate the request and response handling for this route under cpp/gateway.",
      "",
      "## Acceptance",
      "",
      "- Identify a gateway-side cause with a deterministic test using synthetic input and mocked upstream behavior.",
      "- Fix the confirmed behavior and preserve existing request and response contracts.",
      "",
      "https://github.com/" + CONTROLLER + "/actions/runs/" + run,
    ].join("\n"),
  };
}

export async function publishDailyGatewayIssues(
  input: unknown,
  actions: { repository: string | undefined; runId: string | undefined },
  request: IssueRequest,
) {
  const report = parseDailyGatewayScanReport(input);
  const run = actions.runId;
  require(
    actions.repository === CONTROLLER && run !== undefined && RUN_ID.test(run),
    "daily publisher Actions identity is not trusted",
  );

  if (report.findings.length === 0) {
    return { status: "no_findings", created: [], existing: 0, deferred: 0 };
  }

  await verifyTokenScope(request);
  const markers = await readExisting(request);
  const pending = report.findings.filter((finding) =>
    !markers.some((marker) =>
      marker.kind === finding.kind && marker.route === finding.route &&
      (marker.state === "open" || marker.release === finding.release_sha)
    )
  );
  const existing = report.findings.length - pending.length;
  if (pending.length === 0) {
    return { status: "unchanged", created: [], existing, deferred: 0 };
  }

  // The workflow serializes publisher jobs and the report parser bounds each
  // distinct kind/route. The release marker survives a partial or retried run.
  pending.sort((a, b) =>
    b.count - a.count || a.route.localeCompare(b.route) ||
    a.kind.localeCompare(b.kind)
  );
  const issuer = createHostedFollowUpIssues(request, REPOSITORY);
  const created: number[] = [];
  for (const finding of pending) {
    const number = await issuer.create(issueFor(finding, report, run));
    require(
      number !== null,
      "issue create not verified; reconcile the marker before retrying",
    );
    created.push(number);
  }
  return { status: "published", created, existing, deferred: 0 };
}

if (import.meta.main) {
  try {
    const raw = Deno.env.get("DAILY_GATEWAY_FINDINGS_JSON");
    require(
      raw && raw.length <= 32 * 1024,
      "daily finding payload missing or oversized",
    );
    const token = Deno.env.get("GH_TOKEN");
    require(
      typeof token === "string" && token.startsWith("ghs_"),
      "scoped App token missing",
    );
    const result = await publishDailyGatewayIssues(JSON.parse(raw), {
      repository: Deno.env.get("GITHUB_REPOSITORY"),
      runId: Deno.env.get("GITHUB_RUN_ID"),
    }, githubRequest(token));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({
      status: "failed",
      reason: error instanceof PublicationError
        ? error.message
        : "daily report or publication refused",
    }));
    Deno.exitCode = 1;
  }
}
