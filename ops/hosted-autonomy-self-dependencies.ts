/** Credential-free fixed-location seed producer; no command arguments or env paths. */
import { writeHostedSelfDependencySeed } from "../src/host/hosted-self-dependencies.ts";

export async function hostedSelfDependenciesMain(): Promise<number> {
  try {
    if (Deno.args.length !== 0) throw new Error("arguments unavailable");
    await writeHostedSelfDependencySeed({
      launcherDir: await Deno.realPath(Deno.cwd()),
      trustedPath: Deno.env.get("PATH") ?? "",
    });
    console.log("sentinel self dependencies: prepared");
    return 0;
  } catch {
    console.error("sentinel self dependencies: unavailable");
    return 1;
  }
}
if (import.meta.main) Deno.exit(await hostedSelfDependenciesMain());
