/** Existing trusted App release writer consumes independently verified produced evidence only. */
import { canonicalStringify } from "../contracts/canonical.ts";
import { parseReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { parseHostedReleaseRecordV1 } from "../contracts/hosted-supervisor.ts";
import type { ReadInput } from "./owner-install-future-recovery.ts";
import { ownerDevelopmentInstallFiles } from "./owner-install-snapshot.ts";
import { writeOwnerDevelopmentInstallCommit } from "./owner-install-git.ts";
import {
  consumeOwnerSuccessorAcceptance,
  ownerSuccessorAcceptanceUnchanged,
  readOwnerSuccessorAcceptanceAuthority,
} from "./owner-successor-acceptance-proof.ts";

export async function runOwnerSuccessorAcceptanceAppend(
  input: ReadInput,
  appToken: string,
): Promise<"none" | "appended" | "waiting"> {
  const eligible = input.current.snapshot.hostedReleases.some((r) =>
    r.phase === "owner_superseded" && r.ownerAcceptance === undefined
  );
  if (!eligible) return "none";
  const authority = await readOwnerSuccessorAcceptanceAuthority(input);
  if (!authority) return "waiting";
  const acceptance = consumeOwnerSuccessorAcceptance(authority, input),
    now = Date.now();
  const planned = parseReleaseStateSnapshotV1({
    ...input.current.snapshot,
    stateHead: input.current.head,
    sequence: input.current.snapshot.sequence + 1,
    updatedAt: now,
    hostedReleases: input.current.snapshot.hostedReleases.map((r) =>
      r.id === acceptance.review.binding.releaseId
        ? parseHostedReleaseRecordV1({
          ...r,
          ownerAcceptance: acceptance,
          updatedAt: now,
        })
        : r
    ),
  });
  const files = await ownerDevelopmentInstallFiles(
    planned,
    input.current.head,
    acceptance.review.binding.releaseId,
  );
  const message = `owner-successor-task-acceptance\n\n${
    canonicalStringify({
      id: acceptance.id,
      releaseId: acceptance.review.binding.releaseId,
      expectedRepairHead: acceptance.expectedRepairHead,
      expectedReleaseHead: input.current.head,
    })
  }\n`;
  const written = await writeOwnerDevelopmentInstallCommit(
    input.state,
    appToken,
    input.current.head,
    planned,
    files,
    message,
    () => ownerSuccessorAcceptanceUnchanged(input, authority),
  );
  return written.status === "confirmed" ? "appended" : "waiting";
}
