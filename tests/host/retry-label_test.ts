/**
 * The launcher's `sentinel:retry` label surface (redesign 2026-10-25, C6)
 * over a fake bounded request: one complete open-issue listing (pull requests
 * skipped, anything unproven refused) and a removal that counts only when
 * GitHub's answer no longer carries the label. No network.
 */
import assert from "node:assert/strict";
import { createHostedRetryLabel } from "../../ops/hosted-autonomy-retry-label.ts";

const REPO = { owner: "ubiquity", name: "passport.ubq.fi", installationId: 9 };
const URL = "https://api.github.com/repos/ubiquity/passport.ubq.fi";

type Call = { method: string; path: string };

function fakeRequest(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  const request = (method: string, path: string) => {
    calls.push({ method, path });
    return Promise.resolve(answer({ method, path }));
  };
  return { calls, request: request as never };
}

function issue(number: number, extra: Record<string, unknown> = {}) {
  return {
    number,
    state: "open",
    repository_url: URL,
    labels: [{ name: "bug" }, { name: "Sentinel:Retry" }],
    ...extra,
  };
}

Deno.test("the listing names open labelled issues and skips pull requests", async () => {
  const { calls, request } = fakeRequest(() => [
    issue(45),
    issue(46, { pull_request: { url: "x" } }),
    issue(54),
  ]);
  const listed = await createHostedRetryLabel(request, REPO)
    .listOpenRetryLabeled();
  assert.deepEqual([...listed!], [45, 54]);
  assert.deepEqual(calls, [{
    method: "GET",
    path:
      "/repos/ubiquity/passport.ubq.fi/issues?state=open&labels=sentinel%3Aretry&per_page=100&page=1",
  }]);
});

Deno.test("the listing reads every page and refuses anything it cannot prove", async () => {
  const full = Array.from({ length: 100 }, (_, index) => issue(index + 1));
  const paged = fakeRequest(({ path }) =>
    path.endsWith("page=1") ? full : [issue(101)]
  );
  const all = await createHostedRetryLabel(paged.request, REPO)
    .listOpenRetryLabeled();
  assert.equal(all?.size, 101);
  assert.equal(paged.calls.length, 2);
  for (
    const bad of [
      null,
      { message: "Not Found" },
      [issue(1, { state: "closed" })],
      [issue(1, { repository_url: "https://api.github.com/repos/a/b" })],
      [issue(1, { labels: [{ name: "bug" }] })],
      [issue(1, { labels: [{}] })],
      [issue(1), issue(1)],
      [{ ...issue(1), number: 0 }],
    ]
  ) {
    const { request } = fakeRequest(() => bad);
    assert.equal(
      await createHostedRetryLabel(request, REPO).listOpenRetryLabeled(),
      null,
      JSON.stringify(bad),
    );
  }
  // A listing that never ends within its page bound is refused.
  const endless = fakeRequest(({ path }) =>
    Array.from(
      { length: 100 },
      (_, index) => issue(Number(path.split("page=")[1]) * 1000 + index),
    )
  );
  assert.equal(
    await createHostedRetryLabel(endless.request, REPO).listOpenRetryLabeled(),
    null,
  );
});

Deno.test("a removal counts only when the remaining labels no longer carry it", async () => {
  const removed = fakeRequest(() => [{ name: "bug" }]);
  const label = createHostedRetryLabel(removed.request, REPO);
  assert.equal(await label.removeRetryLabel(45), true);
  assert.deepEqual(removed.calls, [{
    method: "DELETE",
    path: "/repos/ubiquity/passport.ubq.fi/issues/45/labels/sentinel%3Aretry",
  }]);
  for (const answer of [null, [{ name: "sentinel:retry" }], [{}], {}]) {
    const { request } = fakeRequest(() => answer);
    assert.equal(
      await createHostedRetryLabel(request, REPO).removeRetryLabel(45),
      false,
      JSON.stringify(answer),
    );
  }
  const none = fakeRequest(() => []);
  assert.equal(
    await createHostedRetryLabel(none.request, REPO).removeRetryLabel(0),
    false,
  );
  assert.deepEqual(none.calls, []);
});
