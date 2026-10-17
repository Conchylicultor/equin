/**
 * The toolchain `mise.toml` declares, as data: how to ask each tool which
 * version is running, the lowest version the repo accepts and why, and what
 * proves a new version of it works beyond the check and test suites.
 *
 * This is a CLOSED list on purpose — `toolchain:resolved` fails when
 * `mise.toml` declares a tool that is missing here (or the reverse), so adding a
 * tool means saying how to probe and smoke-test it.
 */

import type { Hold } from "@plugins/infra/plugins/deps/plugins/updates/core";

/** One command a new version of a tool must still pass. Run from the repo root. */
export interface ToolSmoke {
  /** Stable name — the identity a failure is compared by, before and after. */
  name: string;
  argv: readonly string[];
  /** Repo-relative working directory; the repo root when omitted. */
  cwd?: string;
  timeoutMs: number;
}

export interface ToolSpec {
  /** The key under `[tools]` in `mise.toml`, and under `[[tools.<name>]]` in `mise.lock`. */
  name: string;
  /** Prints the running version; resolved through PATH, so through mise's shims. */
  versionArgv: readonly string[];
  /** Captures the version out of `versionArgv`'s stdout, as group 1. */
  versionPattern: RegExp;
  /** The lowest version the repo accepts, with the reason it cannot go lower. */
  floor?: { version: string; reason: string };
  /**
   * What a new version of this tool must still pass, beyond the full check and
   * test suites (which already exercise Bun end to end).
   */
  smoke: readonly ToolSmoke[];
}

const MINUTE = 60_000;

export const TOOLS: readonly ToolSpec[] = [
  {
    name: "bun",
    versionArgv: ["bun", "--version"],
    versionPattern: /^(\S+)/,
    floor: {
      version: "1.4.0",
      reason:
        "Bun up to 1.3.14 closes a finished child's extra stdio fds a second time at garbage collection, " +
        "killing pooled Postgres sockets mid-query (oven-sh/bun#33828, first fixed in 1.4.0). " +
        "The bun-runtime check re-proves the running Bun is free of it.",
    },
    // The check and test suites run on Bun: they are its smoke test.
    smoke: [],
  },
  {
    name: "go",
    versionArgv: ["go", "version"],
    versionPattern: /\bgo(\d+\.\d+(?:\.\d+)?)\b/,
    floor: {
      version: "1.24",
      reason:
        "Go before 1.24 omits LC_UUID from the binaries it links, and macOS 26's dyld refuses to load the gateway binary.",
    },
    smoke: [
      {
        name: "go vet (gateway)",
        argv: ["go", "vet", "./..."],
        cwd: "gateway",
        timeoutMs: 10 * MINUTE,
      },
      {
        name: "go test (gateway)",
        argv: ["go", "test", "./..."],
        cwd: "gateway",
        timeoutMs: 15 * MINUTE,
      },
    ],
  },
  {
    name: "tmux",
    versionArgv: ["tmux", "-V"],
    versionPattern: /^tmux (\S+)/,
    smoke: [
      {
        // A private server on its own socket, so the smoke test never touches
        // the server the agent sessions live in.
        name: "tmux server round-trip",
        argv: [
          "sh",
          "-c",
          "tmux -L singularity-toolchain-smoke -f /dev/null new-session -d 'sleep 30' && " +
            "tmux -L singularity-toolchain-smoke list-sessions && " +
            "tmux -L singularity-toolchain-smoke kill-server",
        ],
        timeoutMs: MINUTE,
      },
    ],
  },
  {
    name: "rust",
    versionArgv: ["rustc", "--version"],
    versionPattern: /^rustc (\d+\.\d+\.\d+)/,
    smoke: [
      {
        name: "cargo check (tauri)",
        argv: [
          "cargo",
          "check",
          "--manifest-path",
          "tauri/src-tauri/Cargo.toml",
        ],
        timeoutMs: 45 * MINUTE,
      },
    ],
  },
  {
    // Python's package manager, the runtime of `infra/deps`' python kind: it
    // downloads its own CPython and installs each `python/` project's env on
    // first use. The one piece of the Python stack small enough (~35 MB) to
    // give everyone.
    name: "uv",
    versionArgv: ["uv", "--version"],
    versionPattern: /^uv (\d+\.\d+\.\d+)/,
    // A `python/` project's `uv sync --frozen` / `uv lock` are exercised by the
    // test suite and the `uv` updater's own smoke tests; this proves the
    // binary itself runs.
    smoke: [
      {
        name: "uv runs",
        argv: ["uv", "--version"],
        timeoutMs: MINUTE,
      },
    ],
  },
];

/** Where {@link HOLDS} is declared, named in a hold's messages. */
export const HOLDS_FILE = "plugins/toolchain/core/internal/tools.ts";

/**
 * Releases not to move to, as the shared bounded `Hold` of infra/deps/updates
 * (`names` are tool names). Added by the agent running a toolchain upgrade when
 * a new release regresses something that is not ours to fix, with the reason,
 * the upstream issue and an `until` at most 90 days out. While active,
 * `toolchain upgrade` skips a held release, detection lists it as HELD and
 * `toolchain:resolved` fails if the lock records it; the day after `until` it is
 * inert. Delete it once it no longer matters; renew it (a new `until` and
 * reason) only when it still does.
 */
export const HOLDS: readonly Hold[] = [];

/** The task category the upgrade tasks are filed under. */
export const TOOLCHAIN_CATEGORY_ID = "toolchain";
