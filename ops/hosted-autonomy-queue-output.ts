/** Native workflow gate, deliberately outside the R80 stdout protocol. */
export async function writeQueueCustodyOutput(
  path: string | null,
  ready: boolean,
): Promise<void> {
  if (path === null || path.length === 0) return;
  await Deno.writeTextFile(
    path,
    `queueCustodyReady=${ready === true ? "true" : "false"}\n`,
    { append: true },
  );
}
