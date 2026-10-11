import assert from "node:assert/strict";
import { makeRoot, type ProducedStatusV1 } from "./local-status-helpers.ts";

// ---------------------------------------------------------------------------
// Real embedded renderer, extracted unchanged from the workflow YAML
// ---------------------------------------------------------------------------

const WORKFLOW_URL = new URL(
  "../../.github/workflows/local-status.yml",
  import.meta.url,
);

let rendererSourceCache: string | null = null;

function rendererSource(): string {
  if (rendererSourceCache !== null) return rendererSourceCache;
  const lines = Deno.readTextFileSync(WORKFLOW_URL).split("\n");
  const start = lines.findIndex((line) => line.trim() === "deno eval '");
  const end = lines.findIndex((line, index) =>
    index > start && line.trim() === "'"
  );
  assert.ok(start >= 0, "the workflow embeds the renderer");
  assert.ok(end > start, "the embedded renderer is terminated");
  rendererSourceCache = lines.slice(start + 1, end).join("\n");
  return rendererSourceCache;
}

interface RenderResultV1 {
  code: number;
  summary: string;
  stdout: string;
  stderr: string;
}

export async function render(raw: string | undefined): Promise<RenderResultV1> {
  const root = await makeRoot("sentinel-local-render-");
  try {
    const eventPath = `${root}/event.json`;
    const summaryPath = `${root}/summary.md`;
    await Deno.writeTextFile(
      eventPath,
      JSON.stringify({ inputs: raw === undefined ? {} : { status: raw } }),
    );
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["eval", rendererSource()],
      clearEnv: true,
      env: {
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_STEP_SUMMARY: summaryPath,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    let summary = "";
    try {
      summary = await Deno.readTextFile(summaryPath);
    } catch {
      summary = "";
    }
    return {
      code: output.code,
      summary,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
    };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

export async function expectRecorded(
  raw: string,
  verdict: "GREEN" | "RED",
  fragment: string,
): Promise<RenderResultV1> {
  const result = await render(raw);
  assert.ok(
    result.summary.includes(`Result: RECORDED - ${verdict}`),
    result.summary || result.stderr,
  );
  assert.ok(result.summary.includes(fragment), result.summary);
  assert.equal(result.code, verdict === "GREEN" ? 0 : 1);
  return result;
}

export async function expectRejected(
  raw: string | undefined,
  fragment: string,
): Promise<RenderResultV1> {
  const result = await render(raw);
  assert.ok(result.summary.includes("NOT RECORDED"), result.summary);
  assert.ok(result.summary.includes(fragment), result.summary);
  assert.equal(result.code, 1);
  return result;
}

export function mutated(
  produced: ProducedStatusV1,
  change: (status: Record<string, unknown>) => void,
): string {
  const clone = JSON.parse(produced.fileText) as Record<string, unknown>;
  change(clone);
  return JSON.stringify(clone);
}
