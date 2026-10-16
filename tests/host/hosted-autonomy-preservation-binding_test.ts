/**
 * The disposition pass owns exactly two closed blocked classes and binds each
 * to the one consumed charge that produced its candidate. A record under any
 * other blocker, parked custody whose intent names another operation, and a
 * reservation row the record does not own are never this pass's: nothing is
 * judged or written, and no other task's, installation's or purpose's charge
 * is ever borrowed as the producing admission.
 */
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  candidatePreservationRef,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import { T0 } from "../state/helpers.ts";
import {
  DAY,
  expectDisposed,
  expectNotJudged,
  expectRetained,
  parkedFixture,
  REFUSED,
  refusedFixture,
  REPO,
} from "./hosted-autonomy-preservation-cases.ts";

/** Past artifact retention: the parked class is disposed here. */
const PARKED_AT = T0 + 9 * DAY;
/** Past pacing with the base advanced: the refused class is disposed here. */
const REFUSED_AT = T0 + 2 * DAY;

const RUNTIME_MISMATCH =
  `authenticated historical matrix runtime mismatch; producer=37996641586:1; runtime=${
    "3".repeat(40)
  }; plan=${"6".repeat(64)}; artifact=11648843445; archive=sha256:${
    "b".repeat(64)
  }; planner=114045303039; result=${
    "a".repeat(64)
  }; original admission retained`;

Deno.test("preservation binding: a same-shaped record blocked on another reason is never judged", async () => {
  const control = await refusedFixture();
  await expectDisposed([control.record], [control.charge], REFUSED_AT, [
    `preservation:${control.record.id}:unrecoverable:refused`,
  ]);
  for (
    const message of [
      "candidate touches a protected path",
      "candidate preservation validation unavailable",
      `${REFUSED}; retry`,
    ]
  ) {
    const { record, charge } = await refusedFixture({ message });
    await expectNotJudged([record], [charge], {}, REFUSED_AT);
  }
});

/**
 * Parked custody variants. The record parser already refuses an intent whose
 * key is not its request's, or that carries a result or a pull request; those
 * are injected past it (`unparsed`) so the class predicate keeps its own
 * binding for a reader that skipped the parser.
 */
for (
  const [name, unparsed, variant] of [
    [
      "under the runtime-mismatch blocker another authority owns",
      false,
      (record: WorkRecordV1) => ({
        ...record,
        blocker: { ...record.blocker!, message: RUNTIME_MISMATCH },
      }),
    ],
    [
      "whose intent names another operation key",
      true,
      async (record: WorkRecordV1) => {
        const key = implementationIntentKey("f".repeat(64));
        return {
          ...record,
          intent: {
            ...record.intent!,
            key,
            branch: await candidatePreservationRef(REPO, record.id, key),
          },
        };
      },
    ],
    [
      "whose intent already ingested a result",
      true,
      (record: WorkRecordV1) => ({
        ...record,
        intent: { ...record.intent!, resultId: "result-1" },
      }),
    ],
    [
      "whose intent names a pull request",
      true,
      (record: WorkRecordV1) => ({
        ...record,
        intent: { ...record.intent!, pr: 1012 },
      }),
    ],
    [
      "that is waiting",
      false,
      (record: WorkRecordV1) => ({
        ...record,
        wait: { reason: "manual", since: T0 + 600, until: null },
      }),
    ],
  ] as const
) {
  Deno.test(`preservation binding: parked custody ${name} is never judged`, async () => {
    const { record, charge } = await parkedFixture();
    // The unmodified custody under the same charge and facts is disposed.
    await expectDisposed([record], [charge], PARKED_AT, [
      `preservation:${record.id}:unrecoverable:absent`,
    ]);
    const changed = await variant(record) as WorkRecordV1;
    await expectNotJudged([changed], [charge], {}, PARKED_AT, unparsed);
  });
}

for (
  const [name, foreign] of [
    ["another task's", { taskId: "issue-ubiquity-ai.ubq.fi-428" }],
    ["another installation's", { repository: { ...REPO, installationId: 1 } }],
    ["a review request", { purpose: "review_request" }],
  ] as const
) {
  Deno.test(`preservation binding: ${name} charge at the producing attempt binds neither class`, async () => {
    const parked = await parkedFixture();
    await expectRetained(
      [parked.record],
      [{ ...parked.charge, ...foreign }],
      {},
      PARKED_AT,
      parked.record.id,
      "binding",
    );
    const refused = await refusedFixture();
    await expectRetained(
      [refused.record],
      [{ ...refused.charge, ...foreign }],
      {},
      REFUSED_AT,
      refused.record.id,
      "charge",
    );
  });
}

Deno.test("preservation binding: two producing rows at the refused attempt bind nothing", async () => {
  const { record, charge } = await refusedFixture();
  for (const outcome of ["ambiguous", "submitted"]) {
    const sibling = {
      ...charge,
      id: "e".repeat(64),
      purpose: "implementation",
      outcome,
    };
    await expectRetained(
      [record],
      [charge, sibling],
      {},
      REFUSED_AT,
      record.id,
      "charge",
    );
  }
});

Deno.test("preservation binding: parked custody binds only the charge its intent names", async () => {
  const { record, charge } = await parkedFixture();
  // Same task, attempt, base and settlement under another request id.
  const sibling = { ...charge, id: "e".repeat(64), purpose: "implementation" };
  await expectRetained(
    [record],
    [sibling],
    {},
    PARKED_AT,
    record.id,
    "binding",
  );
});

Deno.test("preservation binding: a first attempt's implementation charge binds both classes", async () => {
  // The live parked 879 and 880 were produced by attempt-1 implementation
  // admissions, not retries.
  const parked = await parkedFixture({
    issue: 879,
    attempt: 1,
    purpose: "implementation",
  });
  const refused = await refusedFixture({
    attempt: 1,
    purpose: "implementation",
  });
  await expectDisposed(
    [parked.record, refused.record],
    [parked.charge, refused.charge],
    PARKED_AT,
    [
      `preservation:${parked.record.id}:unrecoverable:absent`,
      `preservation:${refused.record.id}:unrecoverable:refused`,
    ],
  );
});
