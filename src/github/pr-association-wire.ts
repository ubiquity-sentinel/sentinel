/** Complete native association observations; none of these facts grants effects. */
import type { GitSha } from "../contracts/brands.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import {
  invalidQueueWire,
  queueGraphqlData,
  queueInteger,
  queueObject,
  queueSha,
  queueString,
} from "./merge-queue-wire.ts";

export interface NativeRepositoryIdentity {
  nodeId: string;
  owner: string;
  name: string;
}
export interface NativeIssueIdentity {
  number: number;
  nodeId: string;
  repository: NativeRepositoryIdentity;
}
export interface NativeAssociationPullIdentity extends NativeIssueIdentity {
  headRepository: NativeRepositoryIdentity | null;
  baseRepository: NativeRepositoryIdentity;
  headRef: string;
  baseRef: string;
  head: GitSha;
  base: GitSha;
  state: "open" | "closed" | "merged";
}
export interface NativeAssociationPull extends NativeAssociationPullIdentity {
  /** REST login is canonical, including a Bot's [bot] suffix. */
  author: { login: string; nodeId: string; type: "Bot" | "User" };
}
export interface NativeIssuePullAssociations {
  issue: NativeIssueIdentity & {
    title: string;
    body: string;
    state: "open" | "closed";
  };
  pulls: NativeAssociationPullIdentity[];
}
export interface NativePullClosingIssues {
  pull: NativeAssociationPullIdentity;
  issues: NativeIssueIdentity[];
}
export interface AssociationPage<P, T> {
  parent: P;
  nodes: T[];
  total: number;
  next: string | null;
}

const REPOSITORY_FIELDS = "id name owner { login }";
const PULL_FIELDS =
  `id number state headRefName baseRefName headRefOid baseRefOid
  repository { ${REPOSITORY_FIELDS} }
  headRepository { ${REPOSITORY_FIELDS} }
  baseRepository { ${REPOSITORY_FIELDS} }`;
export const ISSUE_PULL_ASSOCIATIONS_QUERY = `
query SentinelIssuePullAssociations($owner:String!, $name:String!, $number:Int!, $after:String) {
  repository(owner:$owner, name:$name) {
    ${REPOSITORY_FIELDS}
    issue(number:$number) {
      id number title body state repository { ${REPOSITORY_FIELDS} }
      closedByPullRequestsReferences(first:100, after:$after, includeClosedPrs:false, userLinkedOnly:false) {
        totalCount nodes { ${PULL_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
export const PULL_CLOSING_ISSUES_QUERY = `
query SentinelPullClosingIssues($owner:String!, $name:String!, $number:Int!, $after:String) {
  repository(owner:$owner, name:$name) {
    ${REPOSITORY_FIELDS}
    pullRequest(number:$number) {
      ${PULL_FIELDS}
      closingIssuesReferences(first:100, after:$after, userLinkedOnly:false) {
        totalCount nodes { id number repository { ${REPOSITORY_FIELDS} } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

function sameRepository(
  a: NativeRepositoryIdentity,
  b: NativeRepositoryIdentity,
) {
  return a.nodeId === b.nodeId && a.owner === b.owner && a.name === b.name;
}
function repository(value: unknown, rest = false): NativeRepositoryIdentity {
  const row = queueObject(value);
  return {
    nodeId: queueString(rest ? row.node_id : row.id),
    owner: queueString(queueObject(row.owner).login, 39),
    name: queueString(row.name, 100),
  };
}
function issue(value: unknown): NativeIssueIdentity {
  const row = queueObject(value);
  return {
    number: queueInteger(row.number),
    nodeId: queueString(row.id),
    repository: repository(row.repository),
  };
}
function pull(value: unknown): NativeAssociationPullIdentity {
  const row = queueObject(value);
  if (!["OPEN", "CLOSED", "MERGED"].includes(String(row.state))) {
    return invalidQueueWire("malformed");
  }
  const identity = issue(row);
  const baseRepository = repository(row.baseRepository);
  if (!sameRepository(identity.repository, baseRepository)) {
    return invalidQueueWire("identity_mismatch");
  }
  return {
    ...identity,
    headRepository: row.headRepository === null
      ? null
      : repository(row.headRepository),
    baseRepository,
    headRef: queueString(row.headRefName),
    baseRef: queueString(row.baseRefName),
    head: queueSha(row.headRefOid),
    base: queueSha(row.baseRefOid),
    state: (row.state as string)
      .toLowerCase() as NativeAssociationPullIdentity["state"],
  };
}
function root(input: unknown, expected: RepositoryIdentityV1) {
  const row = queueObject(queueGraphqlData(input).repository);
  const actual = repository(row);
  if (actual.owner !== expected.owner || actual.name !== expected.name) {
    return invalidQueueWire("identity_mismatch");
  }
  return { row, actual };
}
function page<P, T>(
  parent: P,
  value: unknown,
  parse: (value: unknown) => T,
): AssociationPage<P, T> {
  const row = queueObject(value);
  if (!Array.isArray(row.nodes) || row.nodes.length > 100) {
    return invalidQueueWire("malformed");
  }
  const info = queueObject(row.pageInfo);
  if (typeof info.hasNextPage !== "boolean") {
    return invalidQueueWire("malformed");
  }
  const cursor = info.endCursor === null
    ? null
    : queueString(info.endCursor, 1024);
  if (info.hasNextPage && (cursor === null || row.nodes.length === 0)) {
    return invalidQueueWire("cursor");
  }
  const total = queueInteger(row.totalCount, 0);
  if (total < row.nodes.length) return invalidQueueWire("malformed");
  return {
    parent,
    nodes: row.nodes.map(parse),
    total,
    next: info.hasNextPage ? cursor : null,
  };
}
function sourceText(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) {
    return invalidQueueWire("malformed");
  }
  return value;
}
export function parseIssuePullPage(
  input: unknown,
  expected: RepositoryIdentityV1,
  number: number,
): AssociationPage<
  NativeIssuePullAssociations["issue"],
  NativeAssociationPullIdentity
> {
  const scope = root(input, expected);
  const row = queueObject(scope.row.issue);
  const identity = issue(row);
  if (
    identity.number !== number ||
    !sameRepository(identity.repository, scope.actual)
  ) {
    return invalidQueueWire("identity_mismatch");
  }
  if (row.state !== "OPEN" && row.state !== "CLOSED") {
    return invalidQueueWire("malformed");
  }
  return page(
    {
      ...identity,
      title: sourceText(row.title, 4096),
      body: sourceText(row.body, 262144),
      state: row.state === "OPEN" ? "open" : "closed",
    },
    row.closedByPullRequestsReferences,
    (value) => {
      const parsed = pull(value);
      if (parsed.state !== "open") return invalidQueueWire("identity_mismatch");
      return parsed;
    },
  );
}
export function parsePullClosingPage(
  input: unknown,
  expected: RepositoryIdentityV1,
  number: number,
): AssociationPage<NativeAssociationPullIdentity, NativeIssueIdentity> {
  const scope = root(input, expected);
  const row = queueObject(scope.row.pullRequest);
  const parent = pull(row);
  if (
    parent.number !== number || !sameRepository(parent.repository, scope.actual)
  ) {
    return invalidQueueWire("identity_mismatch");
  }
  return page(parent, row.closingIssuesReferences, issue);
}
export function parseAssociationPullRest(
  input: unknown,
  expected: RepositoryIdentityV1,
  number: number,
): NativeAssociationPull {
  const row = queueObject(input);
  const head = queueObject(row.head), base = queueObject(row.base);
  const baseRepository = repository(base.repo, true);
  if (
    row.number !== number || baseRepository.owner !== expected.owner ||
    baseRepository.name !== expected.name
  ) {
    return invalidQueueWire("identity_mismatch");
  }
  if (
    (row.state !== "open" && row.state !== "closed") ||
    typeof row.merged !== "boolean" || (row.merged && row.state !== "closed")
  ) {
    return invalidQueueWire("malformed");
  }
  const author = queueObject(row.user);
  if (author.type !== "Bot" && author.type !== "User") {
    return invalidQueueWire("unsupported_actor");
  }
  return {
    number,
    nodeId: queueString(row.node_id),
    repository: baseRepository,
    baseRepository,
    headRepository: head.repo === null ? null : repository(head.repo, true),
    headRef: queueString(head.ref),
    baseRef: queueString(base.ref),
    head: queueSha(head.sha),
    base: queueSha(base.sha),
    state: row.merged ? "merged" : row.state,
    author: {
      login: queueString(author.login, 128),
      nodeId: queueString(author.node_id),
      type: author.type,
    },
  };
}
