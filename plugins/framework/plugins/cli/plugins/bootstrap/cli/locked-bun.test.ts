import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  LOCKED_BUN_REEXEC_ENV,
  lockedBunVersion,
  reexecUnderLockedBun,
} from "./locked-bun";

const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const LOCK = `[[tools.bun]]
version = "1.4.3"
backend = "core:bun"

[tools.bun."platforms.macos-arm64"]
url = "https://example/bun-v9.9.9.zip"

[[tools.go]]
version = "1.27.2"
`;

/** A checkout with LOCK and a mise data dir holding the given bun installs. */
function fixture(installed: string[]): {
  root: string;
  home: string;
  binOf: (v: string) => string;
} {
  const dir = mkdtempSync(join(os.tmpdir(), "locked-bun-"));
  fixtures.push(dir);
  const root = join(dir, "repo");
  const home = join(dir, "home");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "mise.lock"), LOCK);
  const data = join(home, ".local/share/mise");
  mkdirSync(join(data, "shims"), { recursive: true });
  const binOf = (v: string) => join(data, "installs/bun", v, "bin/bun");
  for (const v of installed) {
    mkdirSync(join(data, "installs/bun", v, "bin"), { recursive: true });
    writeFileSync(binOf(v), "");
  }
  return { root, home, binOf };
}

function recordingSpawn(exitCode = 0) {
  const calls: { argv: string[]; env: Record<string, string | undefined> }[] =
    [];
  return {
    calls,
    spawn: (argv: string[], env: Record<string, string | undefined>) => {
      calls.push({ argv, env });
      return Promise.resolve({ exitCode });
    },
  };
}

test("reads the one exact bun release, ignoring platform subtables and other tools", () => {
  expect(lockedBunVersion(LOCK)).toBe("1.4.3");
  expect(lockedBunVersion('[[tools.bun]]\nversion = "latest"\n')).toBeNull();
  expect(lockedBunVersion('[[tools.go]]\nversion = "1.0.0"\n')).toBeNull();
});

test("runs on when the running Bun is the locked one", async () => {
  const { root, home } = fixture(["1.4.3"]);
  const { calls, spawn } = recordingSpawn();
  const outcome = await reexecUnderLockedBun("/e.ts", {
    root,
    running: "1.4.3",
    env: { HOME: home },
    spawn,
  });
  expect(outcome).toEqual({ kind: "running-locked" });
  expect(calls).toHaveLength(0);
});

test("re-execs under the locked install with a shims-first PATH and the marker", async () => {
  const { root, home, binOf } = fixture(["1.4.2", "1.4.3"]);
  const { calls, spawn } = recordingSpawn(7);
  const outcome = await reexecUnderLockedBun("/e.ts", {
    root,
    running: "1.4.2",
    args: ["build", "--allow-main"],
    env: {
      HOME: home,
      PATH: `${home}/.local/share/mise/installs/bun/1.4.2/bin:/usr/bin`,
    },
    spawn,
  });
  expect(outcome).toEqual({ kind: "reexeced", exitCode: 7 });
  expect(calls[0]!.argv).toEqual([
    binOf("1.4.3"),
    "/e.ts",
    "build",
    "--allow-main",
  ]);
  expect(calls[0]!.env.PATH).toBe(`${home}/.local/share/mise/shims:/usr/bin`);
  expect(calls[0]!.env[LOCKED_BUN_REEXEC_ENV]).toBe("1");
});

test("installs a missing locked release, then re-execs under it", async () => {
  const { root, home, binOf } = fixture(["1.4.2"]);
  const { calls, spawn } = recordingSpawn();
  const installs: string[] = [];
  const outcome = await reexecUnderLockedBun("/e.ts", {
    root,
    running: "1.4.2",
    env: { HOME: home },
    install: (version) => {
      installs.push(version);
      mkdirSync(join(binOf(version), ".."), { recursive: true });
      writeFileSync(binOf(version), "");
      return Promise.resolve(0);
    },
    spawn,
  });
  expect(installs).toEqual(["1.4.3"]);
  expect(outcome).toEqual({ kind: "reexeced", exitCode: 0 });
  expect(calls[0]!.argv[0]).toBe(binOf("1.4.3"));
});

test("runs on, saying why, when the missing release cannot be installed", async () => {
  const { root, home } = fixture(["1.4.2"]);
  const { calls, spawn } = recordingSpawn();
  for (const [exit, says] of [
    [null, "mise is not installed"],
    [1, "failed (exit 1)"],
  ] as const) {
    const outcome = await reexecUnderLockedBun("/e.ts", {
      root,
      running: "1.4.2",
      env: { HOME: home },
      install: () => Promise.resolve(exit),
      spawn,
    });
    expect(outcome.kind).toBe("mismatch");
    if (outcome.kind === "mismatch") expect(outcome.reason).toContain(says);
  }
  expect(calls).toHaveLength(0);
});

test("never re-execs twice, and takes the marker out of the environment", async () => {
  const { root, home } = fixture(["1.4.3"]);
  const { calls, spawn } = recordingSpawn();
  const env: Record<string, string | undefined> = {
    HOME: home,
    [LOCKED_BUN_REEXEC_ENV]: "1",
  };
  const outcome = await reexecUnderLockedBun("/e.ts", {
    root,
    running: "1.4.2",
    env,
    spawn,
  });
  expect(outcome.kind).toBe("mismatch");
  expect(calls).toHaveLength(0);
  expect(env[LOCKED_BUN_REEXEC_ENV]).toBeUndefined();
});

test("does nothing outside a checkout with a lock", async () => {
  const dir = mkdtempSync(join(os.tmpdir(), "locked-bun-"));
  fixtures.push(dir);
  const { spawn, calls } = recordingSpawn();
  expect(
    await reexecUnderLockedBun("/e.ts", { root: dir, running: "1.0.0", spawn }),
  ).toEqual({ kind: "no-lock" });
  expect(calls).toHaveLength(0);
});
