import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type { PortResultV1, StateReadView } from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { ReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import {
  OWNER_DEVELOPMENT_INSTALL_RELEASE_BRANCH,
  OWNER_DEVELOPMENT_INSTALL_REPOSITORY,
} from "./owner-install-pins.ts";
import type {
  OwnerDevelopmentInstallFilesV1,
  OwnerDevelopmentInstallWriteV1,
} from "./owner-install-types.ts";
import { readOwnerDevelopmentInstallState } from "./owner-install-state.ts";
import {
  base64Text,
  ownerDevelopmentInstallApi,
  readNestedSha,
  readShaField,
  requireStatus,
  STATIC_API,
  STATIC_WRITE,
} from "./owner-install-api.ts";

/**
 * Create the explicitly owner-authorized state commit, recheck the release ref
 * against the exact expected head, publish it with force:false, then perform
 * exactly one confirmation read: the ref must equal the created commit and the
 * full read state must canonical-equal the planned snapshot. An ambiguous
 * response is settled by that same single reobservation; a mismatch fails
 * closed and the write is never retried.
 */
export async function writeOwnerDevelopmentInstallCommit(
  state: StateReadView,
  appToken: string,
  expectedHead: GitSha,
  planned: ReleaseStateSnapshotV1,
  files: OwnerDevelopmentInstallFilesV1,
  message: string,
  beforePublish?: () => Promise<boolean>,
): Promise<OwnerDevelopmentInstallWriteV1> {
  const baseTree = await readOwnerDevelopmentInstallCommitTree(
    appToken,
    expectedHead,
  );
  if (!baseTree.ok) {
    return notConfirmed(null, "base state tree is unavailable");
  }
  const manifestBlob = await createOwnerDevelopmentInstallBlob(
    appToken,
    files.manifest.text,
  );
  if (!manifestBlob.ok) {
    return notConfirmed(null, "manifest blob could not be created");
  }
  const recordBlob = await createOwnerDevelopmentInstallBlob(
    appToken,
    files.record.text,
  );
  if (!recordBlob.ok) {
    return notConfirmed(null, "runtime record blob could not be created");
  }
  const releaseBlob = files.releaseRecord === undefined
    ? undefined
    : await createOwnerDevelopmentInstallBlob(
      appToken,
      files.releaseRecord.text,
    );
  if (releaseBlob !== undefined && !releaseBlob.ok) {
    return notConfirmed(
      null,
      "hosted release record blob could not be created",
    );
  }
  const tree = await createOwnerDevelopmentInstallTree(
    appToken,
    baseTree.value,
    files,
    manifestBlob.value,
    recordBlob.value,
    releaseBlob?.ok ? releaseBlob.value : undefined,
  );
  if (!tree.ok) return notConfirmed(null, "state tree could not be created");
  const commit = await createOwnerDevelopmentInstallCommit(
    appToken,
    message,
    tree.value,
    expectedHead,
  );
  if (!commit.ok) {
    return notConfirmed(null, "installation commit could not be created");
  }

  const ref = await readOwnerDevelopmentInstallRef(appToken);
  if (!ref.ok) {
    return notConfirmed(commit.value, "release ref could not be rechecked");
  }
  if (ref.value !== expectedHead) {
    return notConfirmed(
      commit.value,
      "release ref moved before the installation commit was published",
    );
  }
  if (beforePublish !== undefined && !await beforePublish()) {
    return notConfirmed(
      commit.value,
      "startup repair custody or native quiescence changed before publication",
    );
  }
  const patch = await patchOwnerDevelopmentInstallRef(appToken, commit.value);
  if (!patch.ok && patch.error.kind === "auth_failed") {
    return notConfirmed(commit.value, "release ref could not be published");
  }

  const confirmed = await confirmOwnerDevelopmentInstall(
    state,
    appToken,
    commit.value,
    planned,
    files,
  );
  if (!confirmed) {
    return notConfirmed(
      commit.value,
      "created installation commit and intended snapshot were not confirmed",
    );
  }
  return { status: "confirmed", commit: commit.value };
}

export async function confirmOwnerDevelopmentInstall(
  state: StateReadView,
  appToken: string,
  commit: GitSha,
  planned: ReleaseStateSnapshotV1,
  files?: OwnerDevelopmentInstallFilesV1,
): Promise<boolean> {
  const ref = await readOwnerDevelopmentInstallRef(appToken);
  if (!ref.ok || ref.value !== commit) return false;
  const read = await readOwnerDevelopmentInstallState(state);
  if (read.status !== "found" || read.head !== commit) return false;
  if (canonicalStringify(read.snapshot) !== canonicalStringify(planned)) {
    return false;
  }
  if (files?.releaseRecord !== undefined) {
    for (const file of [files.manifest, files.record, files.releaseRecord]) {
      const response = await ownerDevelopmentInstallApi(
        appToken,
        "GET",
        `/repos/${OWNER_DEVELOPMENT_INSTALL_REPOSITORY}/contents/${file.path}?ref=${commit}`,
      );
      if (!response.ok || response.value.status !== 200) return false;
      const body = response.value.value as {
        encoding?: unknown;
        content?: unknown;
        type?: unknown;
      };
      if (
        body?.type !== "file" || body.encoding !== "base64" ||
        typeof body.content !== "string"
      ) return false;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          Uint8Array.from(
            atob(body.content.replaceAll("\n", "")),
            (c) => c.charCodeAt(0),
          ),
        );
        if (text !== file.text) return false;
      } catch {
        return false;
      }
    }
  }
  return true;
}

export async function readOwnerDevelopmentInstallCommitTree(
  token: string,
  commitSha: GitSha,
): Promise<PortResultV1<GitSha>> {
  const response = await ownerDevelopmentInstallApi(
    token,
    "GET",
    `/repos/${OWNER_DEVELOPMENT_INSTALL_REPOSITORY}/git/commits/${commitSha}`,
  );
  if (!response.ok) return response;
  const value = requireStatus(response.value, 200);
  if (!value.ok) return value;
  const tree = readNestedSha(value.value, "tree");
  if (tree === null) return portError("invalid", STATIC_API);
  return portOk(tree);
}

export async function createOwnerDevelopmentInstallBlob(
  token: string,
  text: string,
): Promise<PortResultV1<GitSha>> {
  const response = await ownerDevelopmentInstallApi(
    token,
    "POST",
    `/repos/${OWNER_DEVELOPMENT_INSTALL_REPOSITORY}/git/blobs`,
    { content: base64Text(text), encoding: "base64" },
  );
  if (!response.ok) return response;
  const value = requireStatus(response.value, 201);
  if (!value.ok) return value;
  const sha = readShaField(value.value, "sha");
  if (sha === null) return portError("invalid", STATIC_API);
  return portOk(sha);
}

export async function createOwnerDevelopmentInstallTree(
  token: string,
  baseTree: GitSha,
  files: OwnerDevelopmentInstallFilesV1,
  manifestBlob: GitSha,
  recordBlob: GitSha,
  releaseBlob?: GitSha,
): Promise<PortResultV1<GitSha>> {
  const response = await ownerDevelopmentInstallApi(
    token,
    "POST",
    `/repos/${OWNER_DEVELOPMENT_INSTALL_REPOSITORY}/git/trees`,
    {
      base_tree: baseTree,
      tree: [
        {
          path: files.manifest.path,
          mode: "100644",
          type: "blob",
          sha: manifestBlob,
        },
        {
          path: files.record.path,
          mode: "100644",
          type: "blob",
          sha: recordBlob,
        },
        ...(files.releaseRecord === undefined || releaseBlob === undefined
          ? []
          : [{
            path: files.releaseRecord.path,
            mode: "100644",
            type: "blob",
            sha: releaseBlob,
          }]),
      ],
    },
  );
  if (!response.ok) return response;
  const value = requireStatus(response.value, 201);
  if (!value.ok) return value;
  const sha = readShaField(value.value, "sha");
  if (sha === null) return portError("invalid", STATIC_API);
  return portOk(sha);
}

export async function createOwnerDevelopmentInstallCommit(
  token: string,
  message: string,
  tree: GitSha,
  parent: GitSha,
): Promise<PortResultV1<GitSha>> {
  const response = await ownerDevelopmentInstallApi(
    token,
    "POST",
    `/repos/${OWNER_DEVELOPMENT_INSTALL_REPOSITORY}/git/commits`,
    { message, tree, parents: [parent] },
  );
  if (!response.ok) return response;
  const value = requireStatus(response.value, 201);
  if (!value.ok) return value;
  const sha = readShaField(value.value, "sha");
  if (sha === null) return portError("invalid", STATIC_API);
  return portOk(sha);
}

export async function readOwnerDevelopmentInstallRef(
  token: string,
): Promise<PortResultV1<GitSha>> {
  const response = await ownerDevelopmentInstallApi(
    token,
    "GET",
    `/repos/${OWNER_DEVELOPMENT_INSTALL_REPOSITORY}/git/ref/heads/${OWNER_DEVELOPMENT_INSTALL_RELEASE_BRANCH}`,
  );
  if (!response.ok) return response;
  if (response.value.status === 404) {
    return portError("not_found", STATIC_WRITE);
  }
  const value = requireStatus(response.value, 200);
  if (!value.ok) return value;
  const sha = readNestedSha(value.value, "object");
  if (sha === null) return portError("invalid", STATIC_API);
  return portOk(sha);
}

export async function patchOwnerDevelopmentInstallRef(
  token: string,
  commit: GitSha,
): Promise<PortResultV1<GitSha>> {
  const response = await ownerDevelopmentInstallApi(
    token,
    "PATCH",
    `/repos/${OWNER_DEVELOPMENT_INSTALL_REPOSITORY}/git/refs/heads/${OWNER_DEVELOPMENT_INSTALL_RELEASE_BRANCH}`,
    { sha: commit, force: false },
  );
  if (!response.ok) return response;
  const value = requireStatus(response.value, 200);
  if (!value.ok) return value;
  const sha = readNestedSha(value.value, "object");
  if (sha === null) return portError("invalid", STATIC_API);
  return portOk(sha);
}

export function notConfirmed(
  commit: GitSha | null,
  detail: string,
): OwnerDevelopmentInstallWriteV1 {
  return { status: "not_confirmed", commit, detail };
}
