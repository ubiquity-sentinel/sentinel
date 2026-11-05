/**
 * Deterministic candidate-shape refusal: an unapplied patch is not a repair.
 *
 * ai.ubq.fi 1281/1282 and 1210/1211 needed edits to protected files
 * (`src/auth/passport.ts`, `ops/gpg-dsh.sh`). The model committed only tests
 * and a `patches/issue-….patch` file that nothing applies, so the real file
 * stayed the base blob. Every such head consumed a charged native review
 * round only to fail task acceptance, then its corrections repeated it. The
 * shape is visible from the trusted changed-path list alone, so the trusted
 * implementation result refuses it before publication and review.
 *
 * Conservative by construction: the candidate is refused only when it
 * changes at least one patch-shaped path and EVERY other changed path is a
 * test path. A patch file next to a real source/config change (a
 * patch-package dependency patch with its `package.json`, or a correction
 * that applies the change and removes the patch) is never refused here.
 */

/**
 * A `*.patch` / `*.diff` file anywhere, or a file directly under the
 * root-level `patches/` directory. A source directory that happens to be
 * named `patches` (`src/patches/x.ts`) is ordinary code, never patch-shaped.
 */
export function patchShapedPath(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  const base = segments[segments.length - 1] ?? "";
  return base.endsWith(".patch") || base.endsWith(".diff") ||
    (segments.length === 2 && segments[0] === "patches");
}

const TEST_DIRECTORIES = new Set([
  "test",
  "tests",
  "__tests__",
  "spec",
  "specs",
  "e2e",
]);

/** A test file by directory (`tests/…`) or name (`x_test.ts`, `x.spec.js`). */
export function testShapedPath(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  const base = segments[segments.length - 1] ?? "";
  return segments.slice(0, -1).some((segment) =>
    TEST_DIRECTORIES.has(segment)
  ) ||
    /[._-](test|spec)\.[a-z0-9]+$/.test(base) || base.startsWith("test_");
}

/**
 * True when the change set is an unapplied patch: at least one patch-shaped
 * path and nothing else but test paths. Empty is false (the no-change lane).
 */
export function unappliedPatchOnly(paths: readonly string[]): boolean {
  return paths.some(patchShapedPath) &&
    paths.every((path) => patchShapedPath(path) || testShapedPath(path));
}
