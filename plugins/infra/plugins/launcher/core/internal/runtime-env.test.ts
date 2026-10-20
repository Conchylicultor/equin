import { describe, expect, test } from "bun:test";
import {
  RUNTIME_FORWARDED_ENV,
  RUNTIME_FORWARDED_PREFIXES,
  RUNTIME_FORWARDED_TOOL_ENV,
  RUNTIME_HOST_ENV,
  RUNTIME_WITHHELD_ENV,
  miseShimsDir,
  pickHostEnv,
  pickRuntimeEnv,
  runtimeEnvNames,
  runtimePath,
  runtimeShimsDir,
} from "./runtime-env";

const forwarded = Object.keys(RUNTIME_FORWARDED_ENV);
const withheld = Object.keys(RUNTIME_WITHHELD_ENV);
const prefixes = Object.keys(RUNTIME_FORWARDED_PREFIXES);

describe("pickRuntimeEnv", () => {
  test("keeps host, forwarded and prefix-matched names", () => {
    const picked = pickRuntimeEnv({
      HOME: "home-value",
      PATH: "/usr/bin",
      SINGULARITY_DIR: "/data",
      SINGULARITY_RELEASE_RUN_ID: "run-1",
      SINGULARITY_AUTH_GOOGLE_CLIENT_ID: "id",
    });
    expect(picked).toEqual({
      HOME: "home-value",
      PATH: "home-value/.local/share/mise/shims:/usr/bin",
      SINGULARITY_DIR: "/data",
      SINGULARITY_RELEASE_RUN_ID: "run-1",
      SINGULARITY_AUTH_GOOGLE_CLIENT_ID: "id",
    });
  });

  test("drops withheld names — the leak this exists to stop", () => {
    const picked = pickRuntimeEnv({
      HOME: "home-value",
      SINGULARITY_CONVERSATION_ID: "conv-1",
      SINGULARITY_PARENT_HOST: "http://singularity.localhost:9000",
      SINGULARITY_BUILD_ID: "build-1",
      SINGULARITY_HOST_GRANT: "4",
    });
    expect(picked).toEqual({ HOME: "home-value" });
  });

  test("drops names it has never heard of", () => {
    const picked = pickRuntimeEnv({
      TERM_SESSION_ID: "w0t0p0",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "s",
      WARP_IS_LOCAL_SHELL_SESSION: "1",
      SOCKET_PATH: "/sock",
      PGHOST: "elsewhere",
      SINGULARITY_SOMETHING_NEW: "x",
      // A prefix match is a prefix of the NAME, not a substring of it.
      MY_SINGULARITY_AUTH_X: "y",
    });
    expect(picked).toEqual({});
  });

  test("skips names whose value is undefined", () => {
    expect(pickRuntimeEnv({ HOME: undefined, SINGULARITY_DIR: "/d" })).toEqual({
      SINGULARITY_DIR: "/d",
    });
  });
});

describe("pickHostEnv", () => {
  test("keeps only the host facts, dropping installation settings too", () => {
    const picked = pickHostEnv({
      HOME: "home-value",
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      LC_ALL: undefined,
      SINGULARITY_DIR: "/data",
      SINGULARITY_AUTH_GOOGLE_CLIENT_SECRET: "secret",
      PLAYWRIGHT_BROWSERS_PATH: "/pw",
      CLAUDECODE: "1",
      CLAUDE_CODE_EXTRA_BODY: "{}",
      SOCKET_PATH: "/sock",
      SINGULARITY_CONVERSATION_ID: "conv-1",
    });
    expect(picked).toEqual({
      HOME: "home-value",
      PATH: "home-value/.local/share/mise/shims:/usr/bin",
      LANG: "en_US.UTF-8",
    });
  });
});

describe("the declaration", () => {
  test("forwarded and withheld are disjoint", () => {
    expect(forwarded.filter((name) => withheld.includes(name))).toEqual([]);
  });

  test("no withheld name is forwarded by a prefix", () => {
    expect(
      withheld.filter((name) => prefixes.some((p) => name.startsWith(p))),
    ).toEqual([]);
  });

  test("every forwarded, withheld and prefix key is a SINGULARITY_ name", () => {
    for (const name of [...forwarded, ...withheld, ...prefixes]) {
      expect(name).toStartWith("SINGULARITY_");
    }
  });

  test("host and tool names are not SINGULARITY_ names", () => {
    for (const name of [
      ...RUNTIME_HOST_ENV,
      ...Object.keys(RUNTIME_FORWARDED_TOOL_ENV),
    ]) {
      expect(name).not.toStartWith("SINGULARITY_");
    }
  });
});

describe("runtimeEnvNames", () => {
  test("lists every declared name, and each prefix as <prefix>*", () => {
    const names = runtimeEnvNames();
    expect(names).toContain("HOME");
    expect(names).toContain("SINGULARITY_DIR");
    expect(names).toContain("SINGULARITY_AUTH_*");
    expect(names).not.toContain("SINGULARITY_CONVERSATION_ID");
    expect(new Set(names).size).toBe(names.length);
  });

  test("every entry is a gateway-parsable name: no comma, no =, * only as a suffix", () => {
    for (const entry of runtimeEnvNames()) {
      expect(entry).toMatch(/^[A-Za-z_][A-Za-z0-9_]*\*?$/);
    }
  });
});

describe("runtimePath", () => {
  // Fixture roots, deliberately not this machine's: the function transforms a
  // PATH string by shape, and a test that named real system directories would
  // both bake a developer's layout into source and read as a claim about it.
  const HOME = "/fixture/home";
  const MISE = `${HOME}/.local/share/mise`;
  const at = (PATH: string) => runtimePath({ HOME, PATH });

  test("drops mise's resolved tool directories and puts its shims first", () => {
    expect(
      at(
        `/fixture/pkg/bin:${MISE}/installs/bun/latest/bin:${MISE}/installs/go/1.24.13/bin:${MISE}/installs/rust/1.99.1:${MISE}/shims:/fixture/bin`,
      ),
    ).toBe(`${MISE}/shims:/fixture/pkg/bin:/fixture/bin`);
  });

  test("a system copy of a tool can never shadow the one mise declares", () => {
    // The 2026-09-16 shape: Homebrew and rustup ahead of the shims, so the
    // runtime ran their rust instead of mise's.
    expect(
      at(`/fixture/homebrew/bin:/fixture/home/.cargo/bin:${MISE}/shims`),
    ).toBe(`${MISE}/shims:/fixture/homebrew/bin:/fixture/home/.cargo/bin`);
  });

  test("the version frozen into PATH is exactly what must not survive", () => {
    const normalized = at(`${MISE}/installs/bun/1.3.13/bin:${MISE}/shims`);
    expect(normalized).not.toContain("1.3.13");
    expect(normalized).toBe(`${MISE}/shims`);
  });

  test("derives the shims dir from a stripped install dir, over the env default", () => {
    const other = "/fixture/elsewhere/mise";
    expect(at(`${other}/installs/bun/1.4.2/bin:/fixture/bin`)).toBe(
      `${other}/shims:/fixture/bin`,
    );
  });

  test("an explicit shims entry wins over every derived one", () => {
    const explicit = "/fixture/custom/mise/shims";
    expect(
      runtimePath({
        HOME,
        MISE_DATA_DIR: "/fixture/data/mise",
        PATH: `/fixture/bin:/fixture/other/mise/installs/go/1/bin:${explicit}`,
      }),
    ).toBe(`${explicit}:/fixture/bin`);
  });

  test("a PATH that never mentions mise still gets mise's shims first", () => {
    // The 2026-09-18 clean-VM shape: mise installed, never activated, so the
    // starter's PATH has no mise entry and rustc was simply absent.
    expect(at("/fixture/pkg/bin:/fixture/bin")).toBe(
      `${MISE}/shims:/fixture/pkg/bin:/fixture/bin`,
    );
  });

  test("returns PATH unchanged when nothing says where mise would live", () => {
    expect(runtimePath({ PATH: "/fixture/bin" })).toBe("/fixture/bin");
  });

  test("is idempotent, even for a child that did not inherit MISE_DATA_DIR", () => {
    const once = runtimePath({
      HOME,
      MISE_DATA_DIR: "/fixture/data/mise",
      PATH: "/fixture/bin",
    });
    expect(once).toBe("/fixture/data/mise/shims:/fixture/bin");
    expect(runtimePath({ HOME, PATH: once })).toBe(once);
  });

  test("a path that merely mentions mise elsewhere is not a tool directory", () => {
    expect(at("/fixture/mise-tools/bin:/fixture/mise/installs-backup")).toBe(
      `${MISE}/shims:/fixture/mise-tools/bin:/fixture/mise/installs-backup`,
    );
  });
});

describe("runtimeShimsDir", () => {
  test("names the directory runtimePath puts first", () => {
    const env = {
      HOME: "/fixture/home",
      PATH: "/fixture/bin:/fixture/custom/mise/shims",
    };
    expect(runtimeShimsDir(env)).toBe("/fixture/custom/mise/shims");
    expect(runtimePath(env).split(":")[0]).toBe(runtimeShimsDir(env));
    expect(runtimeShimsDir({ PATH: "/fixture/bin" })).toBeUndefined();
  });
});

describe("miseShimsDir", () => {
  test("follows mise's own lookup order: MISE_DATA_DIR, XDG_DATA_HOME, HOME", () => {
    const env = {
      HOME: "/fixture/home",
      XDG_DATA_HOME: "/fixture/xdg",
      MISE_DATA_DIR: "/fixture/data/",
    };
    expect(miseShimsDir(env)).toBe("/fixture/data/shims");
    expect(miseShimsDir({ ...env, MISE_DATA_DIR: undefined })).toBe(
      "/fixture/xdg/mise/shims",
    );
    expect(miseShimsDir({ HOME: "/fixture/home" })).toBe(
      "/fixture/home/.local/share/mise/shims",
    );
    expect(miseShimsDir({})).toBeUndefined();
  });
});

describe("pickRuntimeEnv normalizes PATH", () => {
  test("the gateway can never be handed a version-pinned tool directory", () => {
    const mise = "/fixture/home/.local/share/mise";
    const picked = pickRuntimeEnv({
      HOME: "/fixture/home",
      PATH: `${mise}/installs/bun/latest/bin:${mise}/shims:/fixture/bin`,
    });
    expect(picked.PATH).toBe(`${mise}/shims:/fixture/bin`);
    expect(picked.HOME).toBe("/fixture/home");
  });
});

describe("pickHostEnv normalizes PATH", () => {
  test("a tool the runtime runs never inherits a version-pinned tool directory", () => {
    const mise = "/fixture/home/.local/share/mise";
    const picked = pickHostEnv({
      HOME: "/fixture/home",
      PATH: `${mise}/installs/bun/1.3.13/bin:${mise}/shims:/fixture/bin`,
    });
    expect(picked.PATH).toBe(`${mise}/shims:/fixture/bin`);
  });

  test("an already-normalized PATH passes through unchanged", () => {
    const path = "/fixture/home/.local/share/mise/shims:/fixture/bin";
    expect(pickHostEnv({ HOME: "/fixture/home", PATH: path }).PATH).toBe(path);
  });
});

describe("the starter's mise config", () => {
  test("a starter's own MISE_GLOBAL_CONFIG_FILE never reaches the runtime", () => {
    const source = {
      HOME: "/home/u",
      PATH: "/usr/bin",
      MISE_GLOBAL_CONFIG_FILE: "/home/u/elsewhere.toml",
    };
    expect(pickRuntimeEnv(source)).not.toHaveProperty(
      "MISE_GLOBAL_CONFIG_FILE",
    );
    expect(pickHostEnv(source)).not.toHaveProperty("MISE_GLOBAL_CONFIG_FILE");
  });
});
