import assert from "node:assert/strict";
import { parse } from "@std/yaml";

type Obj = Record<string, unknown>;
const workflow = async (file: string) =>
  parse(await Deno.readTextFile(`.github/workflows/${file}`)) as Obj;

Deno.test("a leg completion reaches a separate unprivileged trusted router", async () => {
  const dispatcher = await workflow("supervisor-dispatch.yml");
  const event = (dispatcher.on as Obj).workflow_run as Obj;
  assert((event.workflows as string[]).includes("sentinel-backup-ci-leg"));
  const router = (dispatcher.jobs as Obj).backup_completion as Obj;
  assert(
    router,
    "the completion router exists independently of supervisor dispatch",
  );
  assert.equal("environment" in router, false);
  assert.deepEqual(router.permissions, { contents: "read", actions: "write" });
  assert(String(router.if).includes("backup-ci-leg.yml"));
  assert.notEqual(
    (router.concurrency as Obj).group,
    "sentinel-supervisor-dispatch",
  );
  const steps = router.steps as Obj[];
  assert(
    steps.some((s) =>
      String(s.run).includes("ops/backup-ci-completion-main.ts")
    ),
  );
  assert(!JSON.stringify(router).includes("secrets."));
  const ordinary = (dispatcher.jobs as Obj).dispatch as Obj;
  assert(String(ordinary.if).includes(".github/workflows/supervisor.yml"));
  assert.deepEqual(ordinary.concurrency, {
    group: "sentinel-supervisor-dispatch",
    "cancel-in-progress": false,
  });
});

Deno.test("completion routing preserves the protected backup pass boundary", async () => {
  const backup = await workflow("backup-ci.yml");
  assert.deepEqual(Object.keys(backup.on as Obj), ["workflow_dispatch"]);
  const job = (backup.jobs as Obj).backup_ci as Obj;
  assert(
    String(job.if).includes("github.ref == 'refs/heads/sentinel-supervisor'"),
  );
  assert(String(job.if).includes("github.run_attempt == 1"));
  assert.deepEqual(job.environment, { name: "sentinel-supervisor" });
});
