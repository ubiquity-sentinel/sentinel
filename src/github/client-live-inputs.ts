/**
 * Batched live-input GraphQL wire (issue #326).
 *
 * One read-only `repository { ... }` query for the bounded request asks,
 * with deterministic aliases, for every
 * requested issue's state, every pull request's state/head/base, its last
 * commit's `statusCheckRollup` and its latest review, and every requested
 * branch tip. Chunks are exhaustive: the merged answer covers every requested
 * item or the whole read fails. The parser fails closed on any GraphQL error
 * other than a `NOT_FOUND` for one of this query's own issue/pull aliases
 * (an explicit absent item), on a missing alias, on a mismatched identity and
 * on every malformed value. No response text, URL or credential reaches an
 * error detail.
 */
import type { GitSha } from "../contracts/brands.ts";
import {
  type LiveCheckRollupV1,
  type LiveInputsRequestV1,
  type LiveInputsV1,
  type LivePullInputV1,
  MAX_LIVE_INPUT_ITEMS,
} from "../contracts/live-inputs.ts";
import {
  expectArray,
  expectEnum,
  expectGitSha,
  expectNonEmptyString,
  expectPositiveInt,
  expectRecord,
  fail,
  MaxText,
} from "../contracts/validation.ts";

/**
 * Carry the entire accepted request in one query. Counting issues and pulls
 * separately must not split a normal 74-record repository into two requests.
 * The shared item bound still refuses oversized requests before any I/O.
 */
export const LIVE_INPUTS_CHUNK = MAX_LIVE_INPUT_ITEMS;

const BRANCH = /^[A-Za-z0-9._/-]{1,255}$/;
const MAX_ISSUE_NUMBER = 2 ** 31 - 1;

type ChunkItem =
  | { kind: "issue"; alias: string; number: number }
  | { kind: "pull"; alias: string; number: number }
  | { kind: "branch"; alias: string; variable: string; branch: string };

export interface LiveInputsChunkV1 {
  query: string;
  variables: Record<string, string>;
  items: ChunkItem[];
}

/** The request's items, validated, de-duplicated and split into chunks. */
export function buildLiveInputsChunks(
  request: LiveInputsRequestV1,
): LiveInputsChunkV1[] | null {
  const issues = [...new Set(request.issues)].sort((a, b) => a - b);
  const pulls = [...new Set(request.pulls)].sort((a, b) => a - b);
  const branches = [...new Set(request.branches)].sort();
  if (
    issues.length + pulls.length + branches.length > MAX_LIVE_INPUT_ITEMS ||
    ![...issues, ...pulls].every((value) =>
      Number.isSafeInteger(value) && value > 0 && value <= MAX_ISSUE_NUMBER
    ) ||
    !branches.every((branch) =>
      BRANCH.test(branch) && !branch.includes("..") &&
      !branch.startsWith("/") && !branch.endsWith("/")
    )
  ) return null;
  const items: ChunkItem[] = [
    ...issues.map((number, index) => ({
      kind: "issue" as const,
      alias: `i${index}`,
      number,
    })),
    ...pulls.map((number, index) => ({
      kind: "pull" as const,
      alias: `p${index}`,
      number,
    })),
    ...branches.map((branch, index) => ({
      kind: "branch" as const,
      alias: `b${index}`,
      variable: `b${index}`,
      branch,
    })),
  ];
  const chunks: LiveInputsChunkV1[] = [];
  for (let start = 0; start < items.length; start += LIVE_INPUTS_CHUNK) {
    chunks.push(chunkQuery(items.slice(start, start + LIVE_INPUTS_CHUNK)));
  }
  return chunks;
}

function chunkQuery(items: ChunkItem[]): LiveInputsChunkV1 {
  const variables: Record<string, string> = {};
  const declarations = ["$owner: String!", "$name: String!"];
  const fields: string[] = [];
  for (const item of items) {
    if (item.kind === "issue") {
      fields.push(
        `${item.alias}: issue(number: ${item.number}) { number state }`,
      );
    } else if (item.kind === "pull") {
      fields.push(
        `${item.alias}: pullRequest(number: ${item.number}) { number state ` +
          "headRefOid baseRefOid baseRefName " +
          "commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } } " +
          "reviews(last: 1) { nodes { databaseId } } }",
      );
    } else {
      declarations.push(`$${item.variable}: String!`);
      variables[item.variable] = `refs/heads/${item.branch}`;
      fields.push(
        `${item.alias}: ref(qualifiedName: $${item.variable}) { target { oid } }`,
      );
    }
  }
  return {
    query: `query SentinelLiveInputs(${declarations.join(", ")}) {\n` +
      `  repository(owner: $owner, name: $name) {\n    ${
        fields.join("\n    ")
      }\n  }\n}`,
    variables,
    items,
  };
}

/** One chunk's strict answer. */
export function parseLiveInputsChunk(
  input: unknown,
  chunk: LiveInputsChunkV1,
): LiveInputsV1 {
  const obj = expectRecord(input, "$");
  const absent = notFoundAliases(obj.errors, chunk);
  const data = expectRecord(obj.data, "$.data");
  const repository = expectRecord(data.repository, "$.data.repository");
  const result: LiveInputsV1 = { issues: [], pulls: [], branches: [] };
  for (const item of chunk.items) {
    const path = `$.data.repository.${item.alias}`;
    const raw = repository[item.alias];
    if (raw === undefined) {
      fail(path, "missing_field", "missing live input alias");
    }
    if (item.kind === "issue") {
      if (raw === null) {
        if (!absent.has(item.alias)) {
          fail(path, "invalid_value", "issue is null without NOT_FOUND");
        }
        result.issues.push({ number: item.number, state: null });
        continue;
      }
      const issue = expectRecord(raw, path);
      if (expectPositiveInt(issue.number, `${path}.number`) !== item.number) {
        fail(`${path}.number`, "invalid_value", "issue identity mismatch");
      }
      const state = expectEnum(
        issue.state,
        ["OPEN", "CLOSED"],
        `${path}.state`,
      );
      result.issues.push({
        number: item.number,
        state: state === "OPEN" ? "open" : "closed",
      });
    } else if (item.kind === "pull") {
      if (raw === null) {
        if (!absent.has(item.alias)) {
          fail(path, "invalid_value", "pull is null without NOT_FOUND");
        }
        result.pulls.push({ number: item.number, pull: null });
        continue;
      }
      result.pulls.push({
        number: item.number,
        pull: parsePull(raw, path, item.number),
      });
    } else {
      if (raw === null) {
        result.branches.push({ branch: item.branch, tip: null });
        continue;
      }
      const ref = expectRecord(raw, path);
      const target = expectRecord(ref.target, `${path}.target`);
      result.branches.push({
        branch: item.branch,
        tip: expectGitSha(target.oid, `${path}.target.oid`),
      });
    }
  }
  return result;
}

function parsePull(
  raw: unknown,
  path: string,
  number: number,
): LivePullInputV1 {
  const pull = expectRecord(raw, path);
  if (expectPositiveInt(pull.number, `${path}.number`) !== number) {
    fail(`${path}.number`, "invalid_value", "pull identity mismatch");
  }
  const state = expectEnum(
    pull.state,
    ["OPEN", "CLOSED", "MERGED"],
    `${path}.state`,
  );
  const head = expectGitSha(pull.headRefOid, `${path}.headRefOid`);
  const base = expectGitSha(pull.baseRefOid, `${path}.baseRefOid`);
  const baseRef = expectNonEmptyString(
    pull.baseRefName,
    `${path}.baseRefName`,
    MaxText.branch,
  );
  const commits = expectArray(
    expectRecord(pull.commits, `${path}.commits`).nodes,
    `${path}.commits.nodes`,
    1,
    (value) => value,
  );
  const reviews = expectArray(
    expectRecord(pull.reviews, `${path}.reviews`).nodes,
    `${path}.reviews.nodes`,
    1,
    (value) => value,
  );
  return {
    number,
    state: state === "OPEN" ? "open" : state === "CLOSED" ? "closed" : "merged",
    head,
    base,
    baseRef,
    checks: commits.length === 0
      ? "none"
      : rollup(commits[0], `${path}.commits.nodes[0]`, head),
    latestReview: reviews.length === 0 ? null : expectPositiveInt(
      expectRecord(reviews[0], `${path}.reviews.nodes[0]`).databaseId,
      `${path}.reviews.nodes[0].databaseId`,
    ),
  };
}

function rollup(raw: unknown, path: string, head: GitSha): LiveCheckRollupV1 {
  const commit = expectRecord(expectRecord(raw, path).commit, `${path}.commit`);
  const oid = expectGitSha(commit.oid, `${path}.commit.oid`);
  const status = commit.statusCheckRollup;
  if (oid !== head) return "unbound";
  if (status === null) return "none";
  const state = expectEnum(
    expectRecord(status, `${path}.commit.statusCheckRollup`).state,
    ["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"],
    `${path}.commit.statusCheckRollup.state`,
  );
  return state.toLowerCase() as LiveCheckRollupV1;
}

/** Aliases GitHub reported NOT_FOUND; any other error fails the chunk. */
function notFoundAliases(
  errors: unknown,
  chunk: LiveInputsChunkV1,
): Set<string> {
  const absent = new Set<string>();
  if (errors === undefined || errors === null) return absent;
  const nullable = new Set(
    chunk.items.filter((item) => item.kind !== "branch").map((item) =>
      item.alias
    ),
  );
  const list = expectArray(errors, "$.errors", LIVE_INPUTS_CHUNK, (v) => v);
  list.forEach((value, index) => {
    const error = expectRecord(value, `$.errors[${index}]`);
    const path = Array.isArray(error.path) ? error.path : [];
    if (
      error.type !== "NOT_FOUND" || path.length !== 2 ||
      path[0] !== "repository" || typeof path[1] !== "string" ||
      !nullable.has(path[1])
    ) {
      fail(`$.errors[${index}]`, "invalid_value", "GraphQL response error");
    }
    absent.add(path[1] as string);
  });
  return absent;
}

/** The chunk answers merged in request order. */
export function mergeLiveInputs(parts: readonly LiveInputsV1[]): LiveInputsV1 {
  return {
    issues: parts.flatMap((part) => part.issues),
    pulls: parts.flatMap((part) => part.pulls),
    branches: parts.flatMap((part) => part.branches),
  };
}
