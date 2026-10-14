/** Hosted actions-candidates-legacy-proof responsibility. */
import type { GitSha } from "../contracts/brands.ts";
import type { GitHubCooldownGateV1, PortResultV1 } from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import { exactCommitAt, pathPresent } from "./actions-candidates-objects.ts";
import type { PreserverGitRunV1 } from "./actions-candidates-objects.ts";
import {
  LEGACY_LOSS_STORE_PREFIX,
  STATIC_LOSS_PRESENT,
  STATIC_LOSS_PROOF,
} from "./actions-candidates-legacy-bindings.ts";

/**
 * H1 must be absent as BOTH a commit and an object in the fetched store. Only a
 * normal, fully settled exit 1 with empty stdout proves absence; a present
 * object of any type is `conflict`, and every other exit, throw, truncation or
 * unproved settlement is unavailable.
 */
async function provedAbsentObject(
  runGit: PreserverGitRunV1,
  store: string,
  lost: GitSha,
): Promise<PortResultV1<void>> {
  for (const peeled of [`${lost}^{commit}`, `${lost}^{object}`]) {
    const read = await runGit(
      store,
      ["rev-parse", "--verify", "--quiet", peeled],
      false,
    );
    if (read === null) return portError("unavailable", STATIC_LOSS_PROOF);
    if (read.code === 0) return portError("conflict", STATIC_LOSS_PRESENT);
    if (read.code !== 1 || read.stdout.trim() !== "") {
      return portError("unavailable", STATIC_LOSS_PROOF);
    }
  }
  return portOk(undefined);
}

/**
 * One bounded read-only absence proof. A NEW empty bare object store is created
 * in owned scratch; exactly the fixed remote and the exact task branch are
 * fetched with bounded credential-scoped Git after the durable cooldown;
 * `FETCH_HEAD` must equal the predecessor H0, the lost base B0 must be a
 * present commit and an ancestor of H0, H1 must be absent as both a commit and
 * an object, and shallow/replace/alternate masking is refused. Nothing is
 * pushed, executed or validated. Only the exact task-owned store is removed,
 * and only after every child process was proved settled.
 */
export async function legacyLossAbsenceProof(input: {
  runGit: PreserverGitRunV1;
  gate: GitHubCooldownGateV1;
  /** Exact installation scope every gate admission is charged to. */
  installationId: number;
  remoteUrl: string;
  branch: string;
  base: GitSha;
  lost: GitSha;
  predecessor: GitSha;
  scratch: string;
}): Promise<PortResultV1<void>> {
  const {
    gate,
    installationId,
    remoteUrl,
    branch,
    base,
    lost,
    predecessor,
    scratch,
  } = input;
  let store: string;
  try {
    store = await Deno.makeTempDir({
      dir: scratch,
      prefix: LEGACY_LOSS_STORE_PREFIX,
    });
  } catch {
    return portError("unavailable", STATIC_LOSS_PROOF);
  }
  // True when any child run could not be proved settled: the exact task-owned
  // store is then preserved for diagnosis instead of removed.
  let uncertain = false;
  const run: PreserverGitRunV1 = async (cwd, args, credentials) => {
    const result = await input.runGit(cwd, args, credentials);
    if (result === null || !result.settled) {
      uncertain = true;
      return null;
    }
    if (!result.exited || result.truncated) return null;
    return result;
  };
  try {
    const init = await run(store, ["init", "--bare", "-q"], false);
    if (init === null || init.code !== 0) {
      return portError("unavailable", STATIC_LOSS_PROOF);
    }
    // Durable cooldown immediately before the one credential-scoped fetch.
    let cooled: PortResultV1<void>;
    try {
      cooled = await gate.beforeRequest(installationId);
    } catch {
      return portError("unavailable", STATIC_LOSS_PROOF);
    }
    if (!cooled.ok) return cooled;
    const fetched = await run(
      store,
      ["fetch", "--no-tags", remoteUrl, `refs/heads/${branch}`],
      true,
    );
    if (fetched === null || fetched.code !== 0) {
      return portError("unavailable", STATIC_LOSS_PROOF);
    }
    const head = await run(
      store,
      ["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"],
      false,
    );
    if (
      head === null || head.code !== 0 || head.stdout.trim() !== predecessor
    ) {
      return portError("unavailable", STATIC_LOSS_PROOF);
    }
    const basePresent = await exactCommitAt(run, store, base);
    if (basePresent === null || !basePresent) {
      return portError("unavailable", STATIC_LOSS_PROOF);
    }
    const ancestry = await run(
      store,
      ["merge-base", "--is-ancestor", base, predecessor],
      false,
    );
    if (ancestry === null || ancestry.code !== 0) {
      return portError("unavailable", STATIC_LOSS_PROOF);
    }
    // No shallow, replace-object or alternate masking may hide a present
    // object or a different object graph.
    const shallow = await run(
      store,
      ["rev-parse", "--is-shallow-repository"],
      false,
    );
    if (
      shallow === null || shallow.code !== 0 ||
      shallow.stdout.trim() !== "false"
    ) {
      return portError("unavailable", STATIC_LOSS_PROOF);
    }
    const replaced = await run(
      store,
      ["for-each-ref", "--format=%(refname)", "refs/replace"],
      false,
    );
    if (
      replaced === null || replaced.code !== 0 || replaced.stdout.trim() !== ""
    ) {
      return portError("unavailable", STATIC_LOSS_PROOF);
    }
    const alternates = await pathPresent(`${store}/objects/info/alternates`);
    if (alternates === null || alternates) {
      return portError("unavailable", STATIC_LOSS_PROOF);
    }
    const absent = await provedAbsentObject(run, store, lost);
    if (!absent.ok) return absent;
    return portOk(undefined);
  } finally {
    // Clean only the exact task-owned store after every child run settled; an
    // unproved settlement keeps the owned scratch intact.
    if (!uncertain) {
      await Deno.remove(store, { recursive: true }).catch(() => {});
    }
  }
}
