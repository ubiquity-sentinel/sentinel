/** Actual native HTTP reader with synthetic external branch, Git and queue observations. */
import {
  type GitHubRefV1,
  portError,
  portOk,
  type PortResultV1,
} from "../../src/contracts/ports.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { GitHubPrAssociationsClient } from "../../src/github/client-pr-associations.ts";
import { parseBranchRuleWire } from "../../src/github/wire.ts";
import type { HttpRequestV1 } from "../../src/github/http.ts";
import type {
  NativeAssociationPull,
  NativeAssociationPullIdentity,
  NativeIssuePullAssociations,
  NativePullClosingIssues,
  NativeRepositoryIdentity,
} from "../../src/github/pr-association-wire.ts";
import type { QueueGuardDecision } from "../../src/github/native-queue-guard.ts";
import {
  createTakeoverDiscovery,
  type TakeoverDiscoveryDependencies,
} from "../../src/host/existing-pr-discovery.ts";
import {
  FakeAuthProvider,
  FakeClock,
  FakeCooldownGate,
} from "../github/helpers.ts";
import { response } from "../github/merge-queue-fixtures.ts";
import { REPO, SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";

function graphRepository(r: NativeRepositoryIdentity) {
  return { id: r.nodeId, name: r.name, owner: { login: r.owner } };
}
function graphPull(p: NativeAssociationPullIdentity) {
  return {
    id: p.nodeId,
    number: p.number,
    state: p.state.toUpperCase(),
    repository: graphRepository(p.repository),
    baseRepository: graphRepository(p.baseRepository),
    headRepository: p.headRepository === null
      ? null
      : graphRepository(p.headRepository),
    headRefName: p.headRef,
    baseRefName: p.baseRef,
    headRefOid: p.head,
    baseRefOid: p.base,
  };
}
function restRepository(r: NativeRepositoryIdentity) {
  return { node_id: r.nodeId, name: r.name, owner: { login: r.owner } };
}
function restPull(p: NativeAssociationPull) {
  return {
    node_id: p.nodeId,
    number: p.number,
    state: p.state === "open" ? "open" : "closed",
    merged: p.state === "merged",
    user: {
      node_id: p.author.nodeId,
      login: p.author.login,
      type: p.author.type,
    },
    head: {
      repo: p.headRepository === null ? null : restRepository(p.headRepository),
      ref: p.headRef,
      sha: p.head,
    },
    base: {
      repo: restRepository(p.baseRepository),
      ref: p.baseRef,
      sha: p.base,
    },
  };
}
function page(nodes: unknown[]) {
  return {
    totalCount: nodes.length,
    nodes,
    pageInfo: { hasNextPage: false, endCursor: null },
  };
}

export function discoveryRig() {
  const repository = { nodeId: "R_target", owner: REPO.owner, name: REPO.name };
  const identity: NativeAssociationPullIdentity = {
    number: 7,
    nodeId: "PR_7",
    repository,
    baseRepository: repository,
    headRepository: repository,
    headRef: "human/issue-1",
    baseRef: "development",
    head: SHA2,
    base: SHA1,
    state: "open",
  };
  const source: NativeIssuePullAssociations = {
    issue: {
      number: 1,
      nodeId: "I_1",
      repository,
      title: "Fix issue",
      body: "",
      state: "open",
    },
    pulls: [structuredClone(identity)],
  };
  const pull: NativeAssociationPull = {
    ...structuredClone(identity),
    author: { nodeId: "BOT_1", login: "ubiquity-sentinel[bot]", type: "Bot" },
  };
  const reciprocal: NativePullClosingIssues = {
    pull: structuredClone(identity),
    issues: [{ number: 1, nodeId: "I_1", repository }],
  };
  const record = workRecord("issue-ubiquity-ai.ubq.fi-1", {
    source: { kind: "issue", id: "1", revision: SHA1 },
  });
  const clock = new FakeClock();
  const calls: string[] = [], requests: HttpRequestV1[] = [];
  const count = { source: 0, rest: 0, reciprocal: 0 };
  type ReadKind = keyof typeof count;
  const control = {
    contents: true,
    protected: false,
    rules: false,
    paths: true,
    failProtections: false,
    failRules: false,
    failGit: false,
    queue: { status: "allow", basis: "native_absent" } as QueueGuardDecision,
    branchHead: SHA2 as GitSha | null,
    baseHead: SHA1 as GitSha | null,
    failRef: false,
    faults: {} as Partial<
      Record<ReadKind, "http" | "partial" | "missing" | "throw">
    >,
    beforeRead: (_kind: ReadKind, _count: number): void => {},
    beforeGit: (): void => {},
  };
  const extraPulls = new Map<number, NativeAssociationPull>();
  const auth = new FakeAuthProvider(), gate = new FakeCooldownGate();
  const native = new GitHubPrAssociationsClient({
    repository: REPO,
    apiBaseUrl: "https://api.github.com",
    clock,
    auth,
    cooldownGate: gate,
    http: (request) => {
      requests.push(request);
      const query = request.body === null
        ? ""
        : String(JSON.parse(request.body).query);
      const kind: ReadKind = request.method === "GET"
        ? "rest"
        : query.includes("SentinelIssuePullAssociations")
        ? "source"
        : "reciprocal";
      count[kind]++;
      calls.push(`${kind}:${count[kind]}`);
      control.beforeRead(kind, count[kind]);
      const fault = control.faults[kind];
      if (fault === "throw") {
        return Promise.reject(new Error("private transport"));
      }
      if (fault === "http") return Promise.resolve(response({}, 403));
      let body: unknown;
      if (kind === "rest") {
        const number = Number(request.url.split("/").at(-1));
        const row = number === pull.number ? pull : extraPulls.get(number);
        if (!row) return Promise.resolve(response({}, 404));
        body = restPull(row);
      } else if (kind === "source") {
        body = {
          data: {
            repository: {
              ...graphRepository(repository),
              issue: {
                ...source.issue,
                id: source.issue.nodeId,
                repository: graphRepository(source.issue.repository),
                state: source.issue.state.toUpperCase(),
                closedByPullRequestsReferences: page(
                  source.pulls.map(graphPull),
                ),
              },
            },
          },
        };
      } else {
        body = {
          data: {
            repository: {
              ...graphRepository(repository),
              pullRequest: {
                ...graphPull(reciprocal.pull),
                closingIssuesReferences: page(
                  reciprocal.issues.map((i) => ({
                    id: i.nodeId,
                    number: i.number,
                    repository: graphRepository(i.repository),
                  })),
                ),
              },
            },
          },
        };
      }
      if (fault === "partial") {
        body = {
          ...(body as object),
          errors: [{ message: "private partial data" }],
        };
      }
      if (fault === "missing") body = {};
      return Promise.resolve(response(body));
    },
  }, null);
  const deps: TakeoverDiscoveryDependencies = {
    repository: REPO,
    baseBranch: "development",
    clock,
    contentsWriteAllowed: () => control.contents,
    client: {
      readIssuePullAssociations: native.readIssuePullAssociations.bind(native),
      readAssociationPull: native.readAssociationPull.bind(native),
      readPullClosingIssues: native.readPullClosingIssues.bind(native),
      readProtections: (branch) => {
        calls.push("protections");
        return Promise.resolve(
          control.failProtections
            ? portError("unavailable", "synthetic")
            : portOk({
              branch,
              protected: control.protected,
              requiredStatusChecks: [],
              requiredApprovingReviewCount: 0,
              requireBranchUpToDate: false,
              enforceAdmins: false,
            }),
        );
      },
      readBranchRules: () => {
        calls.push("rules");
        return Promise.resolve(
          control.failRules ? portError("unavailable", "synthetic") : portOk(
            control.rules
              ? [parseBranchRuleWire({ type: "non_fast_forward" }, "$rule")]
              : [],
          ),
        );
      },
    },
    port: {
      readRef: (ref): Promise<PortResultV1<GitHubRefV1 | null>> => {
        calls.push(`ref:${ref}`);
        const sha = ref === `refs/heads/${pull.headRef}`
          ? control.branchHead
          : control.baseHead;
        return Promise.resolve(
          control.failRef
            ? portError("unavailable", "synthetic")
            : portOk(sha === null ? null : { ref, sha }),
        );
      },
      nativeQueue: {
        inspect: () => Promise.resolve(control.queue),
        inspectEffect: () => {
          calls.push("queue");
          return Promise.resolve(control.queue);
        },
        proveDelivery: () =>
          Promise.resolve({
            status: "unavailable",
            reason: "rule_unavailable",
          }),
      },
    },
    inspectNativeGit: () => {
      calls.push("git");
      control.beforeGit();
      return Promise.resolve(
        control.failGit
          ? portError("unavailable", "synthetic")
          : portOk({ protectedPathsClear: control.paths }),
      );
    },
  };
  return {
    source,
    pull,
    reciprocal,
    record,
    clock,
    control,
    deps,
    calls,
    requests,
    auth,
    gate,
    count,
    extraPulls,
    discover: () =>
      createTakeoverDiscovery(deps)({ record, deadline: T0 + 10_000 }),
  };
}
