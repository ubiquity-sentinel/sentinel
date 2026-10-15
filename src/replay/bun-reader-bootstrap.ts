/** Fixed trusted bytes. Only the verified confinement wrapper runs before enforcement. */
export const BUN_READER_BOOTSTRAP_PATH = ".sentinel-bun-reader.ts";
export const BUN_READER_PREFLIGHT_PATH = ".sentinel-bun-preflight.ts";
export const BUN_READER_PREFLIGHT_STDOUT = "sentinel-bun-reader-preflight:v1\n";
export const BUN_READER_EXECUTABLE = "/tmp/sentinel-bun-runtime/bun";
const POLICY =
  `import { applyLinuxPermissions } from "./src/runtime/permissions-linux.ts";
const receipt = applyLinuxPermissions({
  read: [import.meta.dir, process.execPath, "/dev/urandom", "/dev/null"],
  write: [],
});
if (receipt.landlockAbi < 8 || receipt.filesystemThreadSync !== true || receipt.processThreadSync !== true || !receipt.seccomp) process.exit(78);
`;
export const BUN_READER_BOOTSTRAP = POLICY +
  'await import("./scripts/replay.ts");\n';
/** Same irreversible boundary with no product import or private inputs. */
export const BUN_READER_PREFLIGHT = POLICY +
  `process.stdout.write(${JSON.stringify(BUN_READER_PREFLIGHT_STDOUT)});\n`;
