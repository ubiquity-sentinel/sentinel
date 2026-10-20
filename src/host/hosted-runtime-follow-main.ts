import { fetchHttpTransport, type HttpTransportV1 } from "../github/http.ts";
import {
  type HostedRuntimeFollowJournal,
  runHostedRuntimeFollow,
} from "./hosted-runtime-follow.ts";

export interface FollowMainDeps {
  env: (name: string) => string | undefined;
  write: (
    path: string,
    text: string,
    options: { append: boolean },
  ) => Promise<void>;
  http: HttpTransportV1;
  log: (journal: HostedRuntimeFollowJournal) => void;
}

/** Actions adapter: only the native repository token reaches the controller. */
export async function runHostedRuntimeFollowMain(
  deps: FollowMainDeps,
): Promise<number> {
  const result = await runHostedRuntimeFollow({
    http: deps.http,
    token: deps.env("GITHUB_TOKEN") ?? "",
    flag: deps.env("SENTINEL_AUTO_FOLLOW") ?? "off",
    log: deps.log,
  });
  const output = deps.env("GITHUB_OUTPUT");
  if (output !== undefined) {
    await deps.write(
      output,
      `launcher-sha=${
        result.launcherSha ?? ""
      }\nfollow-ready=${result.safeToDispatch}\ndecision=${result.journal.decision}\n`,
      { append: true },
    );
  }
  const summary = deps.env("GITHUB_STEP_SUMMARY");
  if (summary !== undefined) {
    await deps.write(
      summary,
      `### Hosted runtime follow\n\n\`\`\`json\n${
        JSON.stringify(result.journal)
      }\n\`\`\`\n`,
      { append: true },
    );
  }
  return result.exitCode;
}

if (import.meta.main) {
  Deno.exit(
    await runHostedRuntimeFollowMain({
      env: (name) => Deno.env.get(name),
      write: (path, text, options) => Deno.writeTextFile(path, text, options),
      http: fetchHttpTransport(),
      log: (journal) => console.log(JSON.stringify(journal)),
    }),
  );
}
