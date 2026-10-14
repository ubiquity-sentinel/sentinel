import { type GitSha, isGitSha, type WorkItemId } from "../contracts/brands.ts";
import { portError, portOk, type PortResultV1 } from "../contracts/ports.ts";
import { STATIC_LOCAL_CANDIDATE } from "./local-policy.ts";
import { importCandidate, localCheckoutKey } from "./local-checkout.ts";
import { runTrustedGitResult } from "./local-git.ts";
import { joinPath } from "./local-io.ts";

/** Three-way availability of one exact object in one verified repository. */
type LocalObjectStateV1 = "present" | "absent" | "unknown";

/** Three-way path state: only a NotFound error proves the path is missing. */
type LocalPathStateV1 = "present" | "absent" | "unknown";

/** Direct candidate-checkout mapping read bound (bytes). */
const CANDIDATE_MAPPING_MAX_BYTES = 64 * 1024;

/** Path state where every failure other than NotFound stays unknown. */
async function localPathState(path: string): Promise<LocalPathStateV1> {
  try {
    await Deno.stat(path);
    return "present";
  } catch (error) {
    return error instanceof Deno.errors.NotFound ? "absent" : "unknown";
  }
}

/**
 * Trusted exact-object loader for candidate preservation.
 *
 * It first checks the private source mirror (already-imported objects need no
 * checkout access), then resolves EXACTLY the task's mapped producer checkout
 * under `<stateRoot>/checkouts/<localCheckoutKey(taskId)>` through a direct
 * bounded mapping read and the exact requested SHA. Only then is that exact
 * commit imported into the source mirror — never a mutable HEAD and never a
 * different task's checkout.
 *
 * Availability is three-way and never conflates failure with loss: an object
 * is `present` only in a verified repository, `absent` only after the
 * documented missing-revision exit code 1, and every unreadable, corrupt,
 * wrong-type, wrong-task/version/kind/base or mismatched mapping state is
 * `unavailable`. `not_found` is returned ONLY after the source mirror AND the
 * exact mapped checkout/object both prove positive absence. Files are never
 * deleted or rewritten.
 */
export function createLocalCandidateLoader(input: {
  stateRoot: string;
  sourcePath: string;
  scratch: string;
  trustedPath: string;
}): (taskId: WorkItemId, head: GitSha) => Promise<PortResultV1<void>> {
  const gitAt = async (
    dir: string,
    args: string[],
  ): Promise<{ code: number; stdout: string } | null> => {
    try {
      return await runTrustedGitResult({
        args: ["-C", dir, ...args],
        cwd: input.stateRoot,
        scratch: input.scratch,
        trustedPath: input.trustedPath,
        // Read-only object queries must never lazy-fetch, substitute replace
        // refs or reach any protocol: the same isolation the publication
        // validator already applies to its local object reads.
        extraEnv: {
          GIT_NO_LAZY_FETCH: "1",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_ALLOW_PROTOCOL: "",
        },
      });
    } catch {
      return null;
    }
  };
  /**
   * Exact commit availability in one verified repository.
   *
   * The repository is verified first; `rev-parse --verify --quiet <sha>^{commit}`
   * then has exactly one positive absence: exit code 1 with empty stdout.
   * Exit 128, a throw, truncation, an unreadable repository and a present
   * non-commit object (wrong type) are all `unknown`, never absence.
   */
  const objectState = async (
    dir: string,
    head: GitSha,
  ): Promise<LocalObjectStateV1> => {
    const repo = await gitAt(dir, ["rev-parse", "--absolute-git-dir"]);
    if (repo === null || repo.code !== 0 || repo.stdout.trim().length === 0) {
      return "unknown";
    }
    // Parent-directory discovery is refused: the resolved Git directory must be
    // this exact repository itself (bare source mirror) or its own `.git`
    // (mapped producer clone). Any read or path identity mismatch is unknown.
    try {
      const gitDir = await Deno.realPath(repo.stdout.trim());
      const repoDir = await Deno.realPath(dir);
      if (gitDir !== repoDir) {
        const dotGit = await Deno.realPath(joinPath(dir, ".git"));
        if (gitDir !== dotGit) return "unknown";
      }
    } catch {
      return "unknown";
    }
    const peeled = await gitAt(dir, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${head}^{commit}`,
    ]);
    if (peeled === null) return "unknown";
    if (peeled.code === 0) {
      return peeled.stdout.trim() === head ? "present" : "unknown";
    }
    if (peeled.code !== 1 || peeled.stdout.trim() !== "") return "unknown";
    // The revision is missing OR names a present non-commit object: never
    // report the wrong type as positive loss.
    const object = await gitAt(dir, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${head}^{object}`,
    ]);
    if (object === null || object.code !== 1) return "unknown";
    return object.stdout.trim() === "" ? "absent" : "unknown";
  };
  /**
   * Direct bounded mapping read for this exact task/key; the shared legacy
   * checkout-mapping helper is deliberately not used here.
   */
  const mappingState = async (
    mappingPath: string,
    taskId: WorkItemId,
    key: string,
  ): Promise<"exact" | "missing" | "unusable"> => {
    let text: string;
    try {
      const stat = await Deno.stat(mappingPath);
      if (!stat.isFile || stat.size > CANDIDATE_MAPPING_MAX_BYTES) {
        return "unusable";
      }
      text = await Deno.readTextFile(mappingPath);
    } catch (error) {
      return error instanceof Deno.errors.NotFound ? "missing" : "unusable";
    }
    let parsed: Record<string, unknown>;
    try {
      const value = JSON.parse(text);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return "unusable";
      }
      parsed = value as Record<string, unknown>;
    } catch {
      return "unusable";
    }
    if (
      parsed.version !== "v1" || parsed.kind !== "local_checkout" ||
      typeof parsed.taskId !== "string" || typeof parsed.key !== "string" ||
      typeof parsed.base !== "string" || !isGitSha(parsed.base)
    ) {
      return "unusable";
    }
    return parsed.taskId === taskId && parsed.key === key
      ? "exact"
      : "unusable";
  };
  return async (taskId, head) => {
    if (typeof taskId !== "string" || taskId.length === 0 || !isGitSha(head)) {
      return portError("invalid", STATIC_LOCAL_CANDIDATE);
    }
    // 1. The trusted source mirror already owning the exact objects wins.
    const inSource = await objectState(input.sourcePath, head);
    if (inSource === "present") return portOk(undefined);
    // A failed source read is never ignored and never becomes not_found.
    if (inSource === "unknown") {
      return portError("unavailable", STATIC_LOCAL_CANDIDATE);
    }
    // 2. The exact task-mapped producer checkout; anything else refuses.
    const key = await localCheckoutKey(taskId);
    const checkoutsDir = joinPath(input.stateRoot, "checkouts");
    const checkout = joinPath(checkoutsDir, key);
    const mapping = await mappingState(
      joinPath(checkoutsDir, `${key}.json`),
      taskId,
      key,
    );
    if (mapping === "unusable") {
      return portError("unavailable", STATIC_LOCAL_CANDIDATE);
    }
    const checkoutPath = await localPathState(checkout);
    if (checkoutPath === "unknown") {
      return portError("unavailable", STATIC_LOCAL_CANDIDATE);
    }
    if (mapping === "missing") {
      // No mapped producer checkout was ever published for this task: only a
      // provably absent checkout path can prove the candidate was never made.
      return checkoutPath === "absent"
        ? portError("not_found", STATIC_LOCAL_CANDIDATE)
        : portError("unavailable", STATIC_LOCAL_CANDIDATE);
    }
    if (checkoutPath === "absent") {
      return portError("not_found", STATIC_LOCAL_CANDIDATE);
    }
    const inCheckout = await objectState(checkout, head);
    if (inCheckout === "unknown") {
      return portError("unavailable", STATIC_LOCAL_CANDIDATE);
    }
    if (inCheckout === "absent") {
      return portError("not_found", STATIC_LOCAL_CANDIDATE);
    }
    let imported = false;
    try {
      imported = await importCandidate({
        sourcePath: input.sourcePath,
        checkout,
        head,
        key,
        scratch: input.scratch,
        trustedPath: input.trustedPath,
      });
    } catch {
      return portError("unavailable", STATIC_LOCAL_CANDIDATE);
    }
    if (!imported) return portError("unavailable", STATIC_LOCAL_CANDIDATE);
    return portOk(undefined);
  };
}
