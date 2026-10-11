import { postDrainTaskScenario } from "./entrypoints-post-drain-helpers.ts";

Deno.test("entrypoint: post-drain consumes the exact charged task review and merges in the same invocation", () =>
  postDrainTaskScenario());
Deno.test("entrypoint: post-drain consumes a completed review before the pending wait expires", () =>
  postDrainTaskScenario("future"));
Deno.test("entrypoint: post-drain lost merge response reconciles without repeat charge and closes after production acceptance", () =>
  postDrainTaskScenario("lost-merge"));
Deno.test("entrypoint: post-drain foreign-only key collision never reaches the configured observation port", () =>
  postDrainTaskScenario("foreign-only"));
Deno.test("entrypoint: post-drain foreign-first key collision advances only the configured target", () =>
  postDrainTaskScenario("foreign-first"));
for (
  const mode of [
    "matrix-deferred",
    "matrix-fresh",
    "matrix-horizon",
    "matrix-deadline",
    "matrix-step-limit",
  ] as const
) {
  Deno.test(`entrypoint: post-drain ${mode} keeps delivery and matrix ownership separate`, () =>
    postDrainTaskScenario(mode));
}
for (
  const mode of [
    "wrong-key",
    "wrong-head",
    "unavailable",
    "missing-acceptance",
    "missing-acceptance-capped",
    "failed-drain",
    "deadline",
  ] as const
) {
  Deno.test(`entrypoint: post-drain refuses ${mode}`, () =>
    postDrainTaskScenario(mode));
}
