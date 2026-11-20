/**
 * The hermetic handle and the tunnel argv — pure: files in a scratch dir, no
 * ssh spawned.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { materializeHermetic, type HermeticHandle } from "./session";
import { sshTunnelArgv } from "./tunnel";
import type { SshTarget } from "./types";

const target: SshTarget = {
  host: "box.example",
  port: 2222,
  user: "deploy",
  privateKey: "-----BEGIN KEY-----\nabc\n-----END KEY-----",
  hostKey: {
    mode: "pinned",
    knownHostsLine: "[box.example]:2222 ssh-ed25519 AAAA",
  },
};

const handles: HermeticHandle[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.dispose();
});

async function open(
  t: SshTarget = target,
  budgetMs?: number,
): Promise<HermeticHandle> {
  const h = await materializeHermetic(
    t,
    budgetMs === undefined ? {} : { budgetMs },
  );
  handles.push(h);
  return h;
}

/** The value following `-o <Keyword>=`, or undefined. */
function option(argv: readonly string[], keyword: string): string | undefined {
  for (let i = 0; i < argv.length - 1; i++) {
    const next = argv[i + 1];
    if (argv[i] === "-o" && next?.startsWith(`${keyword}=`))
      return next.slice(keyword.length + 1);
  }
  return undefined;
}

describe("materializeHermetic", () => {
  test("writes the key 0600 and the pin, both newline-terminated, until dispose", async () => {
    const h = await open();
    const key = `${h.dir}/id`;
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(readFileSync(key, "utf8").endsWith("\n")).toBe(true);
    expect(readFileSync(`${h.dir}/known_hosts`, "utf8")).toBe(
      "[box.example]:2222 ssh-ed25519 AAAA\n",
    );
    await h.dispose();
    expect(existsSync(h.dir)).toBe(false);
    // Idempotent.
    await h.dispose();
  });

  test("argv: isolation block first, then extra, then positionals", async () => {
    const h = await open();
    const argv = h.argv("ssh", ["-o", "Extra=1"], ["--", h.host, "true"]);
    expect(argv[0]).toBe("ssh");
    expect(argv.slice(-3)).toEqual(["--", "box.example", "true"]);
    expect(option(argv, "IdentitiesOnly")).toBe("yes");
    expect(option(argv, "IdentityAgent")).toBe("none");
    expect(option(argv, "StrictHostKeyChecking")).toBe("yes");
    expect(option(argv, "Port")).toBe("2222");
    expect(option(argv, "User")).toBe("deploy");
    expect(argv.indexOf("Extra=1")).toBeGreaterThan(
      argv.indexOf("BatchMode=yes"),
    );
    expect(argv.indexOf("Extra=1")).toBeGreaterThan(
      argv.indexOf(`${h.dir}/id`),
    );
  });

  test("ConnectTimeout: a fraction of a budget, the cap without one", async () => {
    expect(
      option(
        (await open(target, 10_000)).argv("ssh", [], []),
        "ConnectTimeout",
      ),
    ).toBe("6");
    expect(option((await open()).argv("ssh", [], []), "ConnectTimeout")).toBe(
      "15",
    );
  });

  test("learn mode starts from an empty known_hosts and accepts new keys", async () => {
    const h = await open({ ...target, hostKey: { mode: "learn" } });
    expect(readFileSync(`${h.dir}/known_hosts`, "utf8")).toBe("");
    expect(option(h.argv("ssh", [], []), "StrictHostKeyChecking")).toBe(
      "accept-new",
    );
    expect(await h.learnedHostKey()).toBeNull();
  });

  test("argv after dispose throws: its key is gone", async () => {
    const h = await open();
    await h.dispose();
    expect(() => h.argv("ssh", [], [])).toThrow(/disposed/);
  });
});

describe("sshTunnelArgv", () => {
  test("a forward-only ssh: -N, the tunnel options, one -L per forward, the host last", async () => {
    const h = await open();
    const argv = sshTunnelArgv(h, [
      { localSocket: `${h.dir}/d0.sock`, remotePort: 4100 },
      { localSocket: `${h.dir}/d1.sock`, remotePort: 4101 },
    ]);
    expect(argv[0]).toBe("ssh");
    expect(argv).toContain("-N");
    expect(option(argv, "ExitOnForwardFailure")).toBe("yes");
    expect(option(argv, "ServerAliveInterval")).toBe("15");
    expect(option(argv, "ServerAliveCountMax")).toBe("3");
    expect(option(argv, "StreamLocalBindUnlink")).toBe("yes");
    // The isolation block is still there, ahead of the tunnel's own options.
    expect(argv.indexOf("IdentitiesOnly=yes")).toBeLessThan(argv.indexOf("-N"));
    const specs = argv.flatMap((a, i) => (a === "-L" ? [argv[i + 1]] : []));
    expect(specs).toEqual([
      `${h.dir}/d0.sock:127.0.0.1:4100`,
      `${h.dir}/d1.sock:127.0.0.1:4101`,
    ]);
    expect(argv.slice(-2)).toEqual(["--", "box.example"]);
  });

  test("a socket path at or past 104 bytes is refused, loudly", async () => {
    const h = await open();
    const long = `/${"a".repeat(103)}`; // 104 bytes
    expect(() =>
      sshTunnelArgv(h, [{ localSocket: long, remotePort: 1 }]),
    ).toThrow(/104 bytes.*sun_path/);
    expect(() =>
      sshTunnelArgv(h, [{ localSocket: `/${"a".repeat(102)}`, remotePort: 1 }]),
    ).not.toThrow();
    // Bytes, not characters.
    expect(() =>
      sshTunnelArgv(h, [{ localSocket: `/${"é".repeat(52)}`, remotePort: 1 }]),
    ).toThrow(/105 bytes/);
  });

  test("refuses forwards that can never work", async () => {
    const h = await open();
    expect(() => sshTunnelArgv(h, [])).toThrow(/no forward/);
    expect(() =>
      sshTunnelArgv(h, [{ localSocket: "d0.sock", remotePort: 1 }]),
    ).toThrow(/absolute/);
    expect(() =>
      sshTunnelArgv(h, [{ localSocket: "/a:b.sock", remotePort: 1 }]),
    ).toThrow(/':'/);
    expect(() =>
      sshTunnelArgv(h, [{ localSocket: "/a.sock", remotePort: 0 }]),
    ).toThrow(/not a TCP port/);
    expect(() =>
      sshTunnelArgv(h, [{ localSocket: "/a.sock", remotePort: 70_000 }]),
    ).toThrow(/not a TCP port/);
  });
});
