/** Lightweight observations are advisory, strict, and never CI evidence. */
import assert from "node:assert/strict";
import {
  checkRunWire,
  checksPageWire,
  commitStatusWire,
  httpRespond,
  makePort,
  SHA1,
  SHA2,
  statusesPageWire,
} from "./helpers.ts";

const COMMIT = `/repos/ubiquity-sentinel/sentinel/commits/${SHA1}`;
const CHECKS = `${COMMIT}/check-runs?per_page=100&page=1`;
const STATUSES = `${COMMIT}/statuses?per_page=100&page=1`;

Deno.test("live input checks: port preserves the advisory option and skips job, event and backup reads", async () => {
  let backupReads = 0;
  const { port, transport } = makePort({
    backupCi: {
      mode: "on",
      reader: {
        targets: [],
        target: () => {
          backupReads++;
          return null;
        },
        read: () => {
          backupReads++;
          return Promise.reject(new Error("unexpected backup evidence read"));
        },
      },
    },
    script: [
      httpRespond(
        "GET",
        CHECKS,
        200,
        checksPageWire([
          checkRunWire({
            id: 31,
            conclusion: "failure",
            app: { slug: "github-actions" },
            details_url:
              "https://github.com/ubiquity-sentinel/sentinel/actions/runs/41/job/31",
          }),
        ]),
      ),
      httpRespond("GET", STATUSES, 200, statusesPageWire([])),
    ],
  });
  const read = await port.readChecks(SHA1, undefined, {
    liveInputsOnly: true,
    events: true,
  });
  assert.ok(read.ok);
  assert.equal(read.value.head, SHA1);
  assert.equal(read.value.checks.length, 1);
  assert.equal(read.value.checks[0].conclusion, "failure");
  assert.equal(read.value.checks[0].neverStarted, undefined);
  assert.equal(read.value.checks[0].event, undefined);
  assert.equal(transport.requests.length, 2);
  assert.equal(backupReads, 0);
});

Deno.test("live input checks: native commit statuses are still collected", async () => {
  const { client, transport } = makePort({
    script: [
      httpRespond("GET", CHECKS, 200, checksPageWire([checkRunWire()])),
      httpRespond(
        "GET",
        STATUSES,
        200,
        statusesPageWire([
          commitStatusWire({ context: "native-status", state: "failure" }),
        ]),
      ),
    ],
  });
  const read = await client.readChecks(SHA1, undefined, {
    liveInputsOnly: true,
  });
  assert.ok(read.ok);
  assert.deepEqual(
    read.value.checks.map((check) => [check.name, check.conclusion]),
    [["ci", "success"], ["native-status", "failure"]],
  );
  assert.equal(transport.requests.length, 2);
});

Deno.test("live input checks: malformed, mismatched and unavailable collections still fail closed", async () => {
  const cases = [
    [httpRespond("GET", CHECKS, 503, {})],
    [httpRespond(
      "GET",
      CHECKS,
      200,
      checksPageWire([
        checkRunWire({ head_sha: SHA2 }),
      ]),
    )],
    [httpRespond(
      "GET",
      CHECKS,
      200,
      checksPageWire([
        checkRunWire({ status: "untrusted" }),
      ]),
    )],
    [
      httpRespond("GET", CHECKS, 200, checksPageWire([checkRunWire()])),
      httpRespond("GET", STATUSES, 503, {}),
    ],
    [
      httpRespond("GET", CHECKS, 200, checksPageWire([checkRunWire()])),
      httpRespond("GET", STATUSES, 200, [{}]),
    ],
  ];
  for (const script of cases) {
    const { client, transport } = makePort({ script });
    const read = await client.readChecks(SHA1, undefined, {
      liveInputsOnly: true,
    });
    assert.equal(read.ok, false, "unavailable is never an empty observation");
    assert.equal(transport.requests.length, script.length);
  }
});
