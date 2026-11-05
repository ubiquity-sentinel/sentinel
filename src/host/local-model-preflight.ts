/** Uncharged trusted source-object prerequisites for an implementation start. */
import type { GitSha } from "../contracts/brands.ts";
import {
  type ModelRunRequestV1,
  portError,
  portOk,
  type PortResultV1,
} from "../contracts/ports.ts";
import { implementationInputRefusal } from "../repair/implementation-preflight.ts";
import { commitObjectPresent } from "./local-git.ts";
import type { LocalModelInputV1 } from "./local-model.ts";

export async function preflightLocalModel(
  input: LocalModelInputV1,
  request: ModelRunRequestV1,
): Promise<PortResultV1<void>> {
  const paths =
    input.targetConfigs?.find((config) =>
      config.repository.owner === request.repository.owner &&
      config.repository.name === request.repository.name
    )?.protectedPaths ?? [];
  const refusal = implementationInputRefusal(request, paths);
  if (refusal !== null) return portError("invalid", refusal);
  const checkoutBase = request.checkoutBase ?? request.base;
  if (
    checkoutBase !== request.base && input.ensureCandidateObjects !== undefined
  ) {
    try {
      const restored = await input.ensureCandidateObjects({
        base: request.base,
        head: checkoutBase,
        repository: request.repository,
      });
      if (!restored.ok) {
        return portError(
          restored.error.kind,
          "continuation candidate objects could not be restored",
        );
      }
    } catch {
      return portError(
        "unavailable",
        "continuation candidate object read failed",
      );
    }
  }
  const sourcePath = input.resolveSourcePath?.(request.repository) ??
    input.sourcePath;
  const required: [string, GitSha][] = [["target base", request.base]];
  if (checkoutBase !== request.base) {
    required.push(["checkout base", checkoutBase]);
  }
  if (request.mergeBase !== undefined) {
    required.push(["merge base", request.mergeBase]);
  }
  for (const [name, sha] of required) {
    const present = () =>
      commitObjectPresent({
        sourcePath,
        sha,
        scratch: input.scratch,
        trustedPath: input.trustedPath,
      });
    if (await present()) continue;
    if (input.ensureBaseObject !== undefined) {
      try {
        const ensured = await input.ensureBaseObject({
          repository: request.repository,
          base: sha,
        });
        if (!ensured.ok) {
          return portError(
            "unavailable",
            `${name} commit could not be read from the target`,
          );
        }
      } catch {
        return portError("unavailable", `${name} commit read failed`);
      }
      if (await present()) continue;
    }
    return portError(
      "not_found",
      `${name} commit does not exist in the target source mirror`,
    );
  }
  return portOk(undefined);
}
