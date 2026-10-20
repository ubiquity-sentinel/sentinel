import { parseHostedRuntimeRecordV1 } from "../contracts/hosted-supervisor-runtime.ts";
import { parseHostedExecutionSettlementV1 } from "../contracts/hosted-supervisor-execution.ts";
import {
  FOLLOW_STATE_REF,
  FollowError,
  type HostedRuntimeFollowApi,
  record,
  sha,
} from "./hosted-runtime-follow-api.ts";

export interface FollowState {
  head: string;
  installedRevision: string;
  executionInFlight: boolean;
  installationUnresolved: boolean;
  failedRevisions: Set<string>;
}

/** An exact immutable state tree, never a mutable contents API directory. */
export async function readFollowState(
  api: HostedRuntimeFollowApi,
): Promise<FollowState> {
  const head = await api.ref(FOLLOW_STATE_REF);
  const commit = record(await api.get(`/git/commits/${head}`));
  if (commit.sha !== head) throw new FollowError("state_identity_mismatch");
  const treeSha = sha(record(commit.tree).sha);
  const tree = record(
    await api.get(`/git/trees/${treeSha}`, { recursive: "1" }),
  );
  if (
    tree.sha !== treeSha || tree.truncated !== false ||
    !Array.isArray(tree.tree) || tree.tree.length > 10_000
  ) {
    throw new FollowError("incomplete_state_tree");
  }
  const runtimes: unknown[] = [];
  const installations: unknown[] = [];
  const paths = new Set<string>();
  for (const raw of tree.tree) {
    const entry = record(raw);
    if (typeof entry.path !== "string" || paths.has(entry.path)) {
      throw new FollowError("incomplete_state_tree");
    }
    paths.add(entry.path);
    if (["hostedRuntimes", "hostedInstallations"].includes(entry.path)) {
      if (entry.type !== "tree" || entry.mode !== "040000") {
        throw new FollowError("invalid_state_record");
      }
      continue;
    }
    if (
      /^(hostedRuntimes|hostedInstallations)\//.test(entry.path) &&
      !/^(hostedRuntimes|hostedInstallations)\/[^/]+\.json$/.test(entry.path)
    ) throw new FollowError("invalid_state_record");
    if (
      !/^(hostedRuntimes|hostedInstallations)\/[^/]+\.json$/.test(entry.path)
    ) continue;
    if (entry.type !== "blob" || entry.mode !== "100644") {
      throw new FollowError("invalid_state_record");
    }
    const value = await readBlob(api, sha(entry.sha));
    (entry.path.startsWith("hostedRuntimes/") ? runtimes : installations).push(
      value,
    );
  }
  if (runtimes.length !== 1) {
    throw new FollowError("installed_pointer_unavailable");
  }
  let runtime;
  try {
    runtime = parseHostedRuntimeRecordV1(runtimes[0]);
  } catch {
    throw new FollowError("invalid_installed_pointer");
  }
  const failedRevisions = new Set<string>();
  const installationIds = new Set<string>();
  let installationUnresolved = false;
  for (const raw of installations) {
    const row = record(raw);
    const candidate = sha(row.candidateRevision);
    if (installationIds.has(candidate)) {
      throw new FollowError("invalid_installation_journal");
    }
    installationIds.add(candidate);
    const phases = [
      "requested",
      "bootstrapping",
      "accepted",
      "rollback_pending",
      "rollback_verifying",
      "rolled_back",
      "rollback_failed",
    ];
    if (
      row.version !== "v1" || row.kind !== "hosted_installation" ||
      row.id !== `installation:${candidate}` ||
      typeof row.phase !== "string" || !phases.includes(row.phase) ||
      row.bootstrapProof === undefined
    ) {
      throw new FollowError("invalid_installation_journal");
    }
    installationUnresolved ||= !["accepted", "rolled_back", "rollback_failed"]
      .includes(row.phase);
    // W10 retains the exact failed bootstrap settlement through every rollback
    // phase. Read its existing proof contract; an absent collection is valid.
    if (row.bootstrapProof !== null) {
      try {
        const proof = parseHostedExecutionSettlementV1(row.bootstrapProof);
        if (
          proof.execution.revision !== candidate ||
          proof.execution.launcherSha !== candidate ||
          proof.execution.id !== row.bootstrapExecutionId ||
          proof.execution.purpose !== "bootstrap" ||
          proof.execution.generation !== (row.previousGeneration as number) + 1
        ) throw new Error();
        if (row.phase === "accepted") {
          if (proof.outcome !== "healthy") throw new Error();
        } else if (
          ![
            "rollback_pending",
            "rollback_verifying",
            "rolled_back",
            "rollback_failed",
          ].includes(row.phase) || proof.outcome === "healthy"
        ) {
          throw new Error();
        }
        if (proof.outcome !== "healthy") failedRevisions.add(candidate);
      } catch {
        throw new FollowError("invalid_installation_journal");
      }
    } else if (
      [
        "accepted",
        "rollback_pending",
        "rollback_verifying",
        "rolled_back",
        "rollback_failed",
      ].includes(row.phase)
    ) {
      throw new FollowError("invalid_installation_journal");
    }
  }
  return {
    head,
    installedRevision: runtime.activeRevision,
    executionInFlight: runtime.execution !== null,
    installationUnresolved,
    failedRevisions,
  };
}

async function readBlob(
  api: HostedRuntimeFollowApi,
  identity: string,
): Promise<unknown> {
  const blob = record(await api.get(`/git/blobs/${identity}`));
  if (
    blob.sha !== identity || blob.encoding !== "base64" ||
    typeof blob.content !== "string" || blob.content.length > 1_500_000
  ) {
    throw new FollowError("invalid_state_record");
  }
  try {
    const bytes = Uint8Array.from(
      atob(blob.content.replace(/\n/g, "")),
      (char) => char.charCodeAt(0),
    );
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new FollowError("invalid_state_record");
  }
}
