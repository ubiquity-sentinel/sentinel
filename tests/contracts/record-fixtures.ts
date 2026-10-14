/** Shared fixtures only; this module registers no tests. */

export async function readFixture(dir: string, file: string): Promise<unknown> {
  const text = await Deno.readTextFile(
    new URL(`../fixtures/contracts/${dir}/${file}`, import.meta.url),
  );
  return JSON.parse(text);
}
