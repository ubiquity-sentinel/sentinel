import assert from "node:assert/strict";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy.ts";
import {
  authorizingReceipt,
  BASE,
  checkRun,
  checkRunPage,
  deliveryRecord,
  FOREIGN_BRANCH,
  FOREIGN_PR,
  FOREIGN_REPO,
  FOREIGN_TASK_BODY,
  FOREIGN_TASK_TITLE,
  foreignReceipt,
  foreignRecord,
  HEAD,
  isForeignPath,
  isSelfPath,
  jsonResponse,
  pullFacts,
  SELF_REPO,
  SHARED_ISSUE_NUMBER,
} from "./hosted-autonomy-fixtures.ts";
import {
  makeRig,
  readRequests,
  repairSnapshot,
  run,
} from "./hosted-autonomy-rig.ts";

Deno.test(
  "hosted autonomy: the check gate reads every page and refuses an incomplete, drifted, duplicated or malformed listing",
  async () => {
    const withFetch = async (
      handler: (url: string) => unknown,
      check: () => Promise<boolean>,
    ): Promise<boolean> => {
      const original = globalThis.fetch;
      globalThis.fetch = ((input: string | URL | Request) =>
        Promise.resolve(
          jsonResponse(handler(String(input))),
        )) as typeof fetch;
      try {
        return await check();
      } finally {
        globalThis.fetch = original;
      }
    };
    const self = () => createHostedAutonomyGitHub("fixture-token", SELF_REPO);
    const foreign = () =>
      createHostedAutonomyGitHub("fixture-token", FOREIGN_REPO);
    const pageOf = (offset: number) =>
      Array.from(
        { length: 100 },
        (_, index) => checkRun(`run-${offset + index}`),
      );
    const pageNumber = (url: string) =>
      Number(new URL(url).searchParams.get("page"));

    // The named self check is on the SECOND page: only a complete listing finds
    // it, and the read must actually ask for that page.
    const requested: number[] = [];
    const selfFound = await withFetch((url) => {
      const page = pageNumber(url);
      requested.push(page);
      return page === 1
        ? checkRunPage(pageOf(0), 101)
        : checkRunPage([checkRun("test-local")], 101);
    }, () => self().hasSuccessfulCheck(HEAD));
    assert.equal(selfFound, true);
    assert.deepEqual(requested, [1, 2]);

    // A later-page failure makes the whole foreign head not green even when the
    // first page is entirely green.
    assert.equal(
      await withFetch(
        (url) =>
          pageNumber(url) === 1 ? checkRunPage(pageOf(0), 101) : checkRunPage(
            [checkRun("verify-artifact", { conclusion: "failure" })],
            101,
          ),
        () => foreign().hasAllChecksGreen(HEAD),
      ),
      false,
    );
    // Count drift between pages is an unproven listing, never green.
    assert.equal(
      await withFetch(
        (url) =>
          pageNumber(url) === 1
            ? checkRunPage(pageOf(0), 101)
            : checkRunPage([checkRun("validate")], 102),
        () => foreign().hasAllChecksGreen(HEAD),
      ),
      false,
    );
    // A duplicated run id across pages is an unproven listing, never green.
    const duplicate = checkRun("validate");
    assert.equal(
      await withFetch(
        (url) =>
          pageNumber(url) === 1
            ? checkRunPage([...pageOf(0).slice(0, 99), duplicate], 101)
            : checkRunPage([duplicate], 101),
        () => foreign().hasAllChecksGreen(HEAD),
      ),
      false,
    );
    // A listing that promises more runs than it ever returns is incomplete.
    assert.equal(
      await withFetch(
        (url) => checkRunPage(pageNumber(url) === 1 ? pageOf(0) : [], 150),
        () => foreign().hasAllChecksGreen(HEAD),
      ),
      false,
    );
    // A run without a usable id is malformed: the listing is not evidence.
    assert.equal(
      await withFetch(() =>
        checkRunPage([{
          name: "validate",
          head_sha: HEAD,
          status: "completed",
          conclusion: "success",
        }], 1), () => foreign().hasAllChecksGreen(HEAD)),
      false,
    );
    // A missing page count cannot prove completeness: never green.
    assert.equal(
      await withFetch(
        () => ({ check_runs: [checkRun("validate")] }),
        () => foreign().hasAllChecksGreen(HEAD),
      ),
      false,
    );
  },
);

Deno.test(
  "hosted autonomy: a parked approval run on a later page is still listed",
  async () => {
    const runs = (offset: number) =>
      Array.from({ length: 50 }, (_, index) => ({
        id: 10_000 + offset + index,
        head_sha: HEAD,
        conclusion: "success",
      }));
    const parked = {
      id: 20_001,
      head_sha: HEAD,
      conclusion: "action_required",
    };
    const pages: number[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      pages.push(page);
      return Promise.resolve(jsonResponse({
        total_count: 51,
        workflow_runs: page === 1 ? runs(0) : [parked],
      }));
    }) as typeof fetch;
    try {
      const listed = await createHostedAutonomyGitHub(
        "fixture-token",
        SELF_REPO,
      ).listParkedRuns(HEAD);
      assert.deepEqual(listed, [parked.id]);
      assert.deepEqual(pages, [1, 2]);
    } finally {
      globalThis.fetch = original;
    }
  },
);

Deno.test(
  "hosted autonomy: a later-page failed check-run prevents the merge",
  async () => {
    const runs = (offset: number) =>
      Array.from(
        { length: 100 },
        (_, index) => checkRun(`validate-${offset + index}`),
      );
    const pages: number[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = String(input);
      if (!isForeignPath(url)) {
        return Promise.resolve(new Response("{}", { status: 404 }));
      }
      if (url.includes("/check-runs")) {
        const page = Number(new URL(url).searchParams.get("page"));
        pages.push(page);
        return Promise.resolve(jsonResponse(
          page === 1 ? checkRunPage(runs(0), 101) : checkRunPage(
            [checkRun("verify-artifact", { conclusion: "failure" })],
            101,
          ),
        ));
      }
      if (url.includes("/actions/runs")) {
        return Promise.resolve(jsonResponse({
          total_count: 0,
          workflow_runs: [],
        }));
      }
      const payload = url.includes(`/pulls/${FOREIGN_PR}`)
        ? {
          state: "open",
          merged: false,
          merge_commit_sha: null,
          head: { sha: HEAD },
          base: { ref: FOREIGN_BRANCH },
          user: { login: "github-actions[bot]" },
          number: FOREIGN_PR,
        }
        : url.includes("/git/ref/")
        ? { ref: `refs/heads/${FOREIGN_BRANCH}`, object: { sha: BASE } }
        : url.includes("/issues/")
        ? {
          state: "open",
          number: SHARED_ISSUE_NUMBER,
          title: FOREIGN_TASK_TITLE,
          body: FOREIGN_TASK_BODY,
        }
        : { default_branch: FOREIGN_BRANCH };
      return Promise.resolve(jsonResponse(payload));
    }) as typeof fetch;
    try {
      const { rig } = await makeRig("autonomy-foreign-paged", {
        repair: repairSnapshot([foreignRecord()], [foreignReceipt()]),
        resolver: (repository) =>
          createHostedAutonomyGitHub("fixture-token", repository),
      });
      const result = await run(rig);
      assert.equal(result.reason, "checks_pending", JSON.stringify(result));
      assert.equal(rig.merges, 0);
      assert.deepEqual(pages, [1, 2]);
      await Deno.remove(rig.tmp, { recursive: true });
    } finally {
      globalThis.fetch = original;
    }
  },
);

Deno.test(
  "hosted autonomy: the self target still requires its named check and an accepted release",
  async () => {
    // The self deterministic gate is the named `test-local` check-run: a head
    // that only carries other green checks is not green, and every read stays
    // on the sentinel scope.
    const requests: string[] = [];
    const gate = async (checkRuns: unknown[]): Promise<boolean> => {
      const original = globalThis.fetch;
      globalThis.fetch = ((input: string | URL | Request) => {
        const url = String(input);
        requests.push(url);
        if (!isSelfPath(url)) {
          return Promise.resolve(new Response("{}", { status: 404 }));
        }
        return Promise.resolve(
          jsonResponse(checkRunPage(checkRuns, checkRuns.length)),
        );
      }) as typeof fetch;
      try {
        return await createHostedAutonomyGitHub("fixture-token", SELF_REPO)
          .hasSuccessfulCheck(HEAD);
      } finally {
        globalThis.fetch = original;
      }
    };
    assert.equal(
      await gate([checkRun("validate"), checkRun("verify-artifact")]),
      false,
    );
    assert.equal(await gate([checkRun("test-local")]), true);
    assert.equal(
      await gate([checkRun("test-local", {
        status: "in_progress",
        conclusion: null,
      })]),
      false,
    );
    assert.equal(
      await gate([checkRun("test-local", { conclusion: "failure" })]),
      false,
    );
    assert.ok(requests.length >= 4);
    assert.ok(requests.every(isSelfPath));

    // A self head with a red deterministic check is never merged.
    const red = await makeRig("autonomy-self-red", {
      repair: repairSnapshot([deliveryRecord()], [authorizingReceipt()]),
      pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
      checkGreen: false,
    });
    const redResult = await run(red.rig, red.github);
    assert.equal(red.rig.merges, 0);
    assert.equal(redResult.reason, "checks_pending");

    // A merged self head with a completed receipt but NO accepted hosted
    // release still writes the exact release request and closes nothing: the
    // trusted release path stays the only closure authority for self.
    const merged = await makeRig("autonomy-self-release-gate", {
      repair: repairSnapshot([deliveryRecord()], [authorizingReceipt()]),
      pull: pullFacts(),
    });
    const mergedResult = await run(merged.rig, merged.github);
    assert.equal(mergedResult.reason, "applied");
    assert.equal((await readRequests(merged.rig)).length, 1);
    assert.equal(merged.rig.closed.length, 0);
    const read = await merged.rig.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("unreadable");
    }
    assert.equal(read.value.snapshot.work[0].nextStep, "delivery");

    await Promise.all(
      [red, merged].map((entry) =>
        Deno.remove(entry.rig.tmp, { recursive: true })
      ),
    );
  },
);

/** Read the current repair snapshot from the real store. */
