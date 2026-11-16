/**
 * The trusted publication validator (`GitReviewSnapshot.validatePublication`,
 * the check candidate preservation runs) over a candidate that edits
 * docs/DECISIONS.md, the change sentinel issue 249 asks for. The validator
 * scans every newly exposed blob and commit message whole, so an ordinary
 * finding id in the record (`task-acceptance-not-fulfilled`) refused every
 * such candidate with `secret_shaped_text`; a real key still refuses one.
 */
import assert from "node:assert/strict";
import {
  PUBLICATION_METADATA_SECRET_DETAIL,
  PUBLICATION_SECRET_DETAIL,
} from "../../src/github/snapshot-policy.ts";
import {
  commitAll,
  producer,
  publicationInput,
  withRepo,
} from "./review-snapshot-helpers.ts";

const RECORD = await Deno.readTextFile(
  new URL("../../docs/DECISIONS.md", import.meta.url),
);
const ID = "task-acceptance-not-fulfilled";
/** A synthetic project-key-shaped value, assembled so this file is not. */
const KEY = ["s", "k-proj-", "FAKE", "0123456789abcdefABCDEF_-".repeat(4)].join(
  "",
);

Deno.test("publication: a candidate editing docs/DECISIONS.md passes the secret scan; a key in it still refuses", async (t) => {
  await withRepo(async (repo) => {
    await Deno.mkdir(`${repo}/docs`);
    await Deno.writeTextFile(`${repo}/docs/DECISIONS.md`, RECORD);
    await Deno.writeTextFile(`${repo}/notes.txt`, "notes\n");
    const base = await commitAll(repo, "base");

    await t.step("the whole record as a newly exposed blob", async () => {
      await Deno.writeTextFile(
        `${repo}/docs/DECISIONS.md`,
        `${RECORD}\nA corrected note on the ${ID} finding.\n`,
      );
      const head = await commitAll(repo, "docs: correct a decision note");
      const result = await producer(repo).validatePublication(
        publicationInput(base, head),
      );
      assert.ok(result.ok, result.ok ? "" : result.error.detail);
    });

    await t.step("the finding id in a commit message", async () => {
      await Deno.writeTextFile(`${repo}/notes.txt`, "notes v2\n");
      const head = await commitAll(repo, `docs: correct the ${ID} note`);
      const result = await producer(repo).validatePublication(
        publicationInput(base, head),
      );
      assert.ok(result.ok, result.ok ? "" : result.error.detail);
    });

    await t.step("a key after a hyphen in the record", async () => {
      await Deno.writeTextFile(
        `${repo}/docs/DECISIONS.md`,
        `${RECORD}\ndeploy-key-${KEY}\n`,
      );
      const head = await commitAll(repo, "docs: add a deployment note");
      const result = await producer(repo).validatePublication(
        publicationInput(base, head),
      );
      assert.ok(!result.ok, "a key-shaped blob must refuse");
      assert.equal(result.error.detail, PUBLICATION_SECRET_DETAIL);
    });

    await t.step(
      "a key after an ordinary word in a commit message",
      async () => {
        await Deno.writeTextFile(`${repo}/notes.txt`, "notes v3\n");
        const head = await commitAll(repo, `docs: rotate task-${KEY}`);
        const result = await producer(repo).validatePublication(
          publicationInput(base, head),
        );
        assert.ok(!result.ok, "key-shaped commit metadata must refuse");
        assert.equal(result.error.detail, PUBLICATION_METADATA_SECRET_DETAIL);
      },
    );
  });
});
