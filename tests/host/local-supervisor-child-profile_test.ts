/**
 * Issue #100: the child Seatbelt profile and its single Codex exemption.
 *
 * Pure, platform-independent checks of the exact profile text the fixed local
 * supervisor hands to `/usr/bin/sandbox-exec`, the resolver that decides
 * whether the owner-installed native Codex executable may leave the child
 * boundary (so Codex can apply its own narrower tool sandbox instead of
 * failing nested), and the fail-closed selection that falls back to today's
 * exact profile. The real platform behaviour is exercised on darwin by
 * `local-supervisor-boundary_test.ts` and by `deno task check:macos-boundary`.
 *
 * The exemption is the owner's explicit choice: without the fixed opt-in file
 * outside the state root (which neither the confined child nor any installed
 * runtime can write) a valid Codex still keeps today's exact profile, because
 * opting in lets merged repair-host code reach an unconfined Codex.
 */

import assert from "node:assert/strict";

import {
  buildChildSandboxProfile,
  type CodexExecExemptionV1,
  codexExemptionRule,
  readCodexOptInV1,
  resolveCodexExecExemptionV1,
  resolveCodexExecutableV1,
  selectChildSandboxProfile,
} from "../../src/host/local-supervisor-child.ts";
import {
  CHILD_MUTABLE_STATE_DIRS,
  CODEX_EXECUTABLE_SEGMENTS,
  CODEX_OPT_IN_ACK,
  CODEX_OPT_IN_SEGMENTS,
  joinPath,
} from "../../src/host/local-supervisor-shared.ts";

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/host\/local-supervisor-child-profile_test\.ts$/,
  "",
);

const GOLDEN_ROOT = "/Users/owner/.local/state/sentinel-local";

/**
 * The exact profile the supervisor rendered before issue #100 (generation 79
 * runtime source, `buildChildSandboxProfile`). Without an exemption the
 * rendering must stay byte-identical.
 */
const GOLDEN_PROFILE = [
  "(version 1)",
  "(allow default)",
  "(deny file-write* file-link)",
  `(allow file-write* file-link (subpath "${GOLDEN_ROOT}/state.git"))`,
  `(allow file-write* file-link (subpath "${GOLDEN_ROOT}/state-scratch"))`,
  `(allow file-write* file-link (subpath "${GOLDEN_ROOT}/source"))`,
  `(allow file-write* file-link (subpath "${GOLDEN_ROOT}/checkouts"))`,
  `(allow file-write* file-link (subpath "${GOLDEN_ROOT}/clients"))`,
  `(allow file-write* file-link (subpath "${GOLDEN_ROOT}/tmp"))`,
  `(allow file-write* file-link (subpath "${GOLDEN_ROOT}/deno"))`,
  `(allow file-write* file-link (subpath "${GOLDEN_ROOT}/model-results"))`,
  `(allow file-write* file-link (subpath "${GOLDEN_ROOT}/review-checkout"))`,
  `(allow file-write* (literal "${GOLDEN_ROOT}/runner.lock"))`,
  `(allow file-write* (literal "${GOLDEN_ROOT}/session-active.json"))`,
  `(allow file-write* (literal "${GOLDEN_ROOT}/status.json"))`,
  '(allow file-write* (literal "/dev/null"))',
  `(allow file-write-mode (literal "${GOLDEN_ROOT}"))`,
  `(deny file-write-unlink (literal "${GOLDEN_ROOT}/state.git"))`,
  `(deny file-write-unlink (literal "${GOLDEN_ROOT}/state-scratch"))`,
  `(deny file-write-unlink (literal "${GOLDEN_ROOT}/source"))`,
  `(deny file-write-unlink (literal "${GOLDEN_ROOT}/checkouts"))`,
  `(deny file-write-unlink (literal "${GOLDEN_ROOT}/clients"))`,
  `(deny file-write-unlink (literal "${GOLDEN_ROOT}/tmp"))`,
  `(deny file-write-unlink (literal "${GOLDEN_ROOT}/deno"))`,
  `(deny file-write-unlink (literal "${GOLDEN_ROOT}/model-results"))`,
  `(deny file-write-unlink (literal "${GOLDEN_ROOT}/review-checkout"))`,
].join("\n");

/** arm64 thin Mach-O header bytes (MH_MAGIC_64 as stored on disk). */
const MACHO_ARM64 = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]);
/** Universal (fat) binary header bytes. */
const MACHO_FAT = new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]);

interface LayoutV1 {
  root: string;
  home: string;
  stateRoot: string;
  spelled: string;
  release: string;
  binary: string;
  /** The owner's opt-in file (written unless the layout is built without). */
  optIn: string;
}

/**
 * A disposable copy of the native Codex standalone installer layout:
 * `~/.codex/bin/codex -> packages/standalone/current/bin/codex`, with
 * `current -> releases/<version>` and a Mach-O file at the release path.
 */
/**
 * Deno.symlink needs unscoped read/write grants, so links are created with
 * the permitted `ln` subprocess; they are still real symlinks.
 */
async function symlink(target: string, path: string): Promise<void> {
  const linked = await new Deno.Command("ln", {
    args: ["-s", target, path],
    stdin: "null",
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!linked.success) {
    throw new Error(`ln -s failed: ${new TextDecoder().decode(linked.stderr)}`);
  }
}

async function makeLayout(
  header: Uint8Array = MACHO_ARM64,
  optedIn = true,
): Promise<LayoutV1> {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "sentinel-local-profile-", dir: ROOT }),
  );
  try {
    return await buildLayout(root, header, optedIn);
  } catch (error) {
    // Setup failed after this call created its own root: remove only it.
    await Deno.remove(root, { recursive: true }).catch(() => {});
    throw error;
  }
}

async function buildLayout(
  root: string,
  header: Uint8Array,
  optedIn: boolean,
): Promise<LayoutV1> {
  const home = `${root}/home`;
  const stateRoot = `${home}/.local/state/sentinel-local`;
  const standalone = `${home}/.codex/packages/standalone`;
  const release = `${standalone}/releases/0.154.0`;
  const binary = `${release}/bin/codex`;
  await Deno.mkdir(`${release}/bin`, { recursive: true });
  await Deno.mkdir(`${home}/.codex/bin`, { recursive: true });
  await Deno.mkdir(stateRoot, { recursive: true });
  await Deno.writeFile(binary, header);
  await Deno.chmod(binary, 0o755);
  await symlink(release, `${standalone}/current`);
  const spelled = `${home}/.codex/bin/codex`;
  await symlink(`${standalone}/current/bin/codex`, spelled);
  const optIn = `${home}/.config/sentinel-local/codex-exemption-opt-in`;
  if (optedIn) await writeOptIn(optIn);
  return { root, home, stateRoot, spelled, release, binary, optIn };
}

/** Exactly what the owner instructions tell the owner to run. */
async function writeOptIn(path: string, text = `${CODEX_OPT_IN_ACK}\n`) {
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, text);
  await Deno.chmod(path, 0o644);
}

async function withLayout(
  fn: (layout: LayoutV1) => Promise<void>,
  header?: Uint8Array,
  optedIn = true,
): Promise<void> {
  const layout = await makeLayout(header, optedIn);
  try {
    await fn(layout);
  } finally {
    await Deno.remove(layout.root, { recursive: true }).catch(() => {});
  }
}

async function relink(spelled: string, target: string): Promise<void> {
  await Deno.remove(spelled);
  await symlink(target, spelled);
}

function absent(reason: string): CodexExecExemptionV1 {
  return { kind: "absent", reason } as CodexExecExemptionV1;
}

function goldenDirs(): string[] {
  return CHILD_MUTABLE_STATE_DIRS.map((name) => joinPath(GOLDEN_ROOT, name));
}

Deno.test("child profile: without an exemption the profile is byte-identical to the generation 79 rendering", () => {
  assert.equal(
    buildChildSandboxProfile(GOLDEN_ROOT, goldenDirs()),
    GOLDEN_PROFILE,
  );
});

Deno.test("child profile: the Codex exemption is one quoted process-exec rule", () => {
  assert.equal(
    codexExemptionRule([
      "/Users/o/.codex/bin/codex",
      '/Users/o/we"ird\\/codex',
    ]),
    '(allow process-exec (with no-sandbox) (literal "/Users/o/.codex/bin/codex") (literal "/Users/o/we\\"ird\\\\/codex"))',
  );
  assert.throws(
    () => codexExemptionRule(["/Users/o/a\nb/codex"]),
    /control character/,
  );
  assert.throws(() => codexExemptionRule([]), /exemption/);
});

Deno.test("child profile: an applied exemption is the last and only added line", async () => {
  const base = buildChildSandboxProfile(GOLDEN_ROOT, goldenDirs());
  const literals = [
    "/Users/owner/.codex/bin/codex",
    "/Users/owner/.codex/packages/standalone/releases/0.154.0/bin/codex",
  ];
  const validated: string[] = [];
  const selection = await selectChildSandboxProfile(
    base,
    { kind: "exempt", literals },
    (profile) => {
      validated.push(profile);
      return Promise.resolve(true);
    },
  );
  assert.equal(selection.note, "codex-exemption: applied");
  assert.equal(selection.profile, `${base}\n${codexExemptionRule(literals)}`);
  assert.ok(selection.profile.startsWith(`${GOLDEN_PROFILE}\n`));
  assert.equal(
    selection.profile.split("\n").length,
    GOLDEN_PROFILE.split("\n").length + 1,
  );
  assert.deepEqual(
    validated,
    [selection.profile],
    "the exact exemption profile is validated once before any launch",
  );
});

Deno.test("child profile: a rejected or failing validation falls back to the exact base profile", async () => {
  const base = buildChildSandboxProfile(GOLDEN_ROOT, goldenDirs());
  const exemption: CodexExecExemptionV1 = {
    kind: "exempt",
    literals: ["/Users/owner/.codex/bin/codex"],
  };
  const rejected = await selectChildSandboxProfile(
    base,
    exemption,
    () => Promise.resolve(false),
  );
  assert.deepEqual(rejected, {
    profile: base,
    note: "codex-exemption: rejected",
  });
  const thrown = await selectChildSandboxProfile(
    base,
    exemption,
    () => Promise.reject(new Error("sandbox-exec missing")),
  );
  assert.deepEqual(thrown, {
    profile: base,
    note: "codex-exemption: rejected",
  });
});

Deno.test("child profile: an absent exemption keeps the base profile and never validates", async () => {
  const base = buildChildSandboxProfile(GOLDEN_ROOT, goldenDirs());
  for (
    const reason of [
      "missing",
      "not_regular_file",
      "not_executable",
      "inside_state_root",
      "system_executable",
      "not_codex",
      "not_macho",
      "control_character",
      "not_opted_in",
      "opt_in_invalid",
    ]
  ) {
    let calls = 0;
    const selection = await selectChildSandboxProfile(
      base,
      absent(reason),
      () => {
        calls++;
        return Promise.resolve(true);
      },
    );
    assert.deepEqual(selection, {
      profile: base,
      note: `codex-exemption: absent:${reason}`,
    });
    assert.equal(calls, 0, `${reason} must not reach platform validation`);
  }
});

Deno.test("codex exemption resolver: the standalone installer layout yields the spelled and real paths", async () => {
  await withLayout(async (layout) => {
    const canonical = await Deno.realPath(layout.stateRoot);
    assert.deepEqual(
      await resolveCodexExecExemptionV1(layout.home, canonical),
      { kind: "exempt", literals: [layout.spelled, layout.binary] },
    );
  });
  await withLayout(async (layout) => {
    // A universal binary is accepted too; a direct file has one literal.
    await Deno.remove(layout.spelled);
    await Deno.copyFile(layout.binary, layout.spelled);
    await Deno.chmod(layout.spelled, 0o755);
    const canonical = await Deno.realPath(layout.stateRoot);
    assert.deepEqual(
      await resolveCodexExecExemptionV1(layout.home, canonical),
      { kind: "exempt", literals: [layout.spelled] },
    );
  }, MACHO_FAT);
});

Deno.test("codex exemption resolver: every refusal is a precise absent reason", async () => {
  const cases: [
    string,
    (layout: LayoutV1) => Promise<string | undefined>,
  ][] = [
    ["missing", async (layout) => {
      await Deno.remove(layout.spelled);
      return layout.home;
    }],
    ["missing", () => Promise.resolve(undefined)],
    ["missing", () => Promise.resolve("relative/home")],
    ["not_regular_file", async (layout) => {
      await relink(layout.spelled, layout.release);
      return layout.home;
    }],
    ["not_executable", async (layout) => {
      await Deno.chmod(layout.binary, 0o644);
      return layout.home;
    }],
    ["inside_state_root", async (layout) => {
      const planted = `${layout.stateRoot}/tmp/codex`;
      await Deno.mkdir(`${layout.stateRoot}/tmp`, { recursive: true });
      await Deno.copyFile(layout.binary, planted);
      await Deno.chmod(planted, 0o755);
      await relink(layout.spelled, planted);
      return layout.home;
    }],
    ["inside_state_root", async (layout) => {
      // An intermediate link the confined child could rewrite.
      const hop = `${layout.stateRoot}/tmp/hop`;
      await Deno.mkdir(`${layout.stateRoot}/tmp`, { recursive: true });
      await symlink(layout.binary, hop);
      await relink(layout.spelled, hop);
      return layout.home;
    }],
    ["opt_in_invalid", async (layout) => {
      // A HOME beneath the state root makes the spelled path and the opt-in
      // child-writable: the child could forge the owner's choice.
      const inner = `${layout.stateRoot}/tmp/home`;
      await Deno.mkdir(`${inner}/.codex/bin`, { recursive: true });
      await symlink(layout.binary, `${inner}/.codex/bin/codex`);
      await writeOptIn(joinPath(inner, ...CODEX_OPT_IN_SEGMENTS));
      return inner;
    }],
    ["system_executable", async (layout) => {
      await relink(layout.spelled, "/usr/bin/env");
      return layout.home;
    }],
    ["not_codex", async (layout) => {
      const renamed = `${layout.release}/bin/node`;
      await Deno.rename(layout.binary, renamed);
      await relink(layout.spelled, renamed);
      return layout.home;
    }],
    ["not_macho", async (layout) => {
      await Deno.writeTextFile(layout.binary, '#!/bin/sh\nexec /bin/sh "$@"\n');
      return layout.home;
    }],
    ["not_macho", async (layout) => {
      await Deno.writeFile(layout.binary, new Uint8Array([0xcf, 0xfa]));
      return layout.home;
    }],
    ["control_character", () => Promise.resolve("/Users/own\ner")],
    ["control_character", async (layout) => {
      const odd = `${layout.root}/rel\u0007ease/bin`;
      await Deno.mkdir(odd, { recursive: true });
      await Deno.copyFile(layout.binary, `${odd}/codex`);
      await Deno.chmod(`${odd}/codex`, 0o755);
      await relink(layout.spelled, `${odd}/codex`);
      return layout.home;
    }],
  ];
  for (const [index, [reason, arrange]] of cases.entries()) {
    await withLayout(async (layout) => {
      const home = await arrange(layout);
      const canonical = await Deno.realPath(layout.stateRoot);
      assert.deepEqual(
        await resolveCodexExecExemptionV1(home, canonical),
        absent(reason),
        `case ${index} must refuse as ${reason}`,
      );
    });
  }
});

Deno.test("codex exemption resolver: a HOME beneath the state root is refused for the Codex spelling too", async () => {
  await withLayout(async (layout) => {
    const inner = `${layout.stateRoot}/tmp/home`;
    await Deno.mkdir(`${inner}/.codex/bin`, { recursive: true });
    await symlink(layout.binary, `${inner}/.codex/bin/codex`);
    const canonical = await Deno.realPath(layout.stateRoot);
    assert.deepEqual(
      await resolveCodexExecutableV1(inner, canonical),
      absent("inside_state_root"),
    );
  });
});

Deno.test("codex exemption resolver: a link loop is refused without blocking", async () => {
  await withLayout(async (layout) => {
    const loop = `${layout.root}/loop`;
    await symlink(loop, loop);
    await relink(layout.spelled, loop);
    const canonical = await Deno.realPath(layout.stateRoot);
    assert.deepEqual(
      await resolveCodexExecExemptionV1(layout.home, canonical),
      absent("missing"),
    );
  });
});

Deno.test("codex exemption: the pinned spelling matches the local repair host launch path exactly once", async () => {
  assert.deepEqual([...CODEX_EXECUTABLE_SEGMENTS], [".codex", "bin", "codex"]);
  const source = await Deno.readTextFile(`${ROOT}/src/host/local.ts`);
  const spelling = 'joinPath(home, ".codex", "bin", "codex")';
  assert.equal(
    source.split(spelling).length - 1,
    1,
    "src/host/local.ts must launch Codex from the exempted spelling",
  );
});

Deno.test("codex exemption opt-in: the fixed opt-in file sits outside the supervisor's state root", async () => {
  assert.deepEqual(
    [...CODEX_OPT_IN_SEGMENTS],
    [".config", "sentinel-local", "codex-exemption-opt-in"],
  );
  const home = "/Users/owner";
  const optIn = joinPath(home, ...CODEX_OPT_IN_SEGMENTS);
  const stateRoot = joinPath(home, ".local", "state", "sentinel-local");
  assert.ok(!optIn.startsWith(`${stateRoot}/`), optIn);
  // The installed supervisor's fixed state root is exactly that spelling, so
  // the opt-in is never in a directory the confined child may write.
  const source = await Deno.readTextFile(
    `${ROOT}/src/host/local-supervisor.ts`,
  );
  assert.equal(
    source.split('joinPath(home, ".local", "state", "sentinel-local")').length -
      1,
    1,
    "src/host/local-supervisor.ts must keep the fixed state root spelling",
  );
  assert.match(CODEX_OPT_IN_ACK, /unconfined Codex/);
});

Deno.test("codex exemption opt-in: a valid Codex without the owner's opt-in keeps today's exact profile", async () => {
  await withLayout(
    async (layout) => {
      const canonical = await Deno.realPath(layout.stateRoot);
      assert.equal(
        await readCodexOptInV1(layout.home, canonical),
        "not_opted_in",
      );
      const exemption = await resolveCodexExecExemptionV1(
        layout.home,
        canonical,
      );
      assert.deepEqual(exemption, absent("not_opted_in"));
      // The Codex install itself is valid: only the owner's choice is missing.
      assert.deepEqual(
        await resolveCodexExecutableV1(layout.home, canonical),
        { kind: "exempt", literals: [layout.spelled, layout.binary] },
      );
      const base = buildChildSandboxProfile(GOLDEN_ROOT, goldenDirs());
      let calls = 0;
      assert.deepEqual(
        await selectChildSandboxProfile(base, exemption, () => {
          calls++;
          return Promise.resolve(true);
        }),
        { profile: base, note: "codex-exemption: absent:not_opted_in" },
      );
      assert.equal(calls, 0, "no exemption profile is even validated");
      // The owner's explicit opt-in is the only switch.
      await writeOptIn(layout.optIn);
      assert.equal(await readCodexOptInV1(layout.home, canonical), "opted_in");
      assert.deepEqual(
        await resolveCodexExecExemptionV1(layout.home, canonical),
        { kind: "exempt", literals: [layout.spelled, layout.binary] },
      );
    },
    undefined,
    false,
  );
});

Deno.test("codex exemption opt-in: anything but the owner's exact regular opt-in file is opt_in_invalid", async () => {
  const cases: [string, (layout: LayoutV1) => Promise<void>][] = [
    ["empty file (touch)", async (layout) => {
      await writeOptIn(layout.optIn, "");
    }],
    ["other text", async (layout) => {
      await writeOptIn(layout.optIn, "yes\n");
    }],
    ["oversized", async (layout) => {
      await writeOptIn(
        layout.optIn,
        `${CODEX_OPT_IN_ACK}\n${" ".repeat(8192)}\n`,
      );
    }],
    ["directory", async (layout) => {
      await Deno.mkdir(layout.optIn, { recursive: true });
    }],
    ["symlink to a valid file", async (layout) => {
      const real = `${layout.root}/elsewhere-opt-in`;
      await writeOptIn(real);
      await Deno.mkdir(layout.optIn.slice(0, layout.optIn.lastIndexOf("/")), {
        recursive: true,
      });
      await symlink(real, layout.optIn);
    }],
    ["hard link to a file inside the state root", async (layout) => {
      // The child could rewrite the shared inode through its own path.
      const inside = `${layout.stateRoot}/tmp/opt-in`;
      await writeOptIn(inside);
      await Deno.mkdir(layout.optIn.slice(0, layout.optIn.lastIndexOf("/")), {
        recursive: true,
      });
      const linked = await new Deno.Command("ln", {
        args: [inside, layout.optIn],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).output();
      assert.ok(linked.success, "ln must create the hard link");
    }],
    ["group writable", async (layout) => {
      await writeOptIn(layout.optIn);
      await Deno.chmod(layout.optIn, 0o664);
    }],
    ["resolves inside the state root", async (layout) => {
      // ~/.config linked into a directory the confined child can write.
      const inside = `${layout.stateRoot}/tmp/config`;
      await Deno.mkdir(`${inside}/sentinel-local`, { recursive: true });
      await symlink(inside, `${layout.home}/.config`);
      await writeOptIn(layout.optIn);
    }],
  ];
  for (const [label, arrange] of cases) {
    await withLayout(
      async (layout) => {
        await arrange(layout);
        const canonical = await Deno.realPath(layout.stateRoot);
        assert.equal(
          await readCodexOptInV1(layout.home, canonical),
          "opt_in_invalid",
          label,
        );
        assert.deepEqual(
          await resolveCodexExecExemptionV1(layout.home, canonical),
          absent("opt_in_invalid"),
          label,
        );
      },
      undefined,
      false,
    );
  }
  // Surrounding whitespace from an editor is tolerated; the words are not.
  await withLayout(
    async (layout) => {
      await writeOptIn(layout.optIn, `  ${CODEX_OPT_IN_ACK}\r\n\n`);
      const canonical = await Deno.realPath(layout.stateRoot);
      assert.equal(await readCodexOptInV1(layout.home, canonical), "opted_in");
    },
    undefined,
    false,
  );
});
