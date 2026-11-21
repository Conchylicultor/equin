import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * decide.sh — the release workflow's validate step — over a throwaway git
 * repo with release tags, its decision read back from $GITHUB_OUTPUT the way
 * GitHub Actions reads it.
 */

const DECIDE = join(import.meta.dir, "decide.sh");
const CRATE = "plugins/installer/plugins/window/rust";

const gitEnv = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

let root: string;

function git(repo: string, ...args: string[]): string {
  const r = spawnSync("git", args, {
    cwd: repo,
    env: gitEnv,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repo with annotated release tags, a lightweight one and a non-release one. */
function makeRepo(name: string, opts: { crate: boolean }): string {
  const repo = join(root, name);
  mkdirSync(repo);
  git(repo, "init", "-q");
  writeFileSync(join(repo, "install.sh"), "echo hi\n");
  if (opts.crate) {
    mkdirSync(join(repo, CRATE), { recursive: true });
    writeFileSync(join(repo, CRATE, "Cargo.toml"), "[package]\n");
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "tag", "-a", "v2026.11.18", "-m", "old");
  git(repo, "tag", "-a", "v2026.11.18.2", "-m", "newest");
  git(repo, "tag", "v2026.11.17");
  git(repo, "tag", "-a", "vnot-a-release", "-m", "x");
  return repo;
}

type Decision = {
  status: number | null;
  stdout: string;
  outputs: Record<string, string>;
};

function decide(
  repo: string,
  env: {
    REF: string;
    EVENT: "push" | "workflow_dispatch";
    INPUT_PUBLISH?: string;
    INPUT_WINDOW?: string;
  },
): Decision {
  const output = join(
    repo,
    "..",
    `${repo.split("/").at(-1)}-${Math.random()}.out`,
  );
  writeFileSync(output, "");
  const r = spawnSync("bash", [DECIDE], {
    cwd: repo,
    env: {
      ...gitEnv,
      GITHUB_OUTPUT: output,
      INPUT_PUBLISH: "",
      INPUT_WINDOW: "",
      ...env,
    },
    encoding: "utf8",
  });
  const outputs: Record<string, string> = {};
  for (const line of readFileSync(output, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) outputs[line.slice(0, i)] = line.slice(i + 1);
  }
  return { status: r.status, stdout: r.stdout, outputs };
}

let plain: string;
let windowed: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "release-decide-"));
  plain = makeRepo("plain", { crate: false });
  windowed = makeRepo("windowed", { crate: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("decide.sh", () => {
  test("a pushed release tag publishes; the newest is latest", () => {
    const d = decide(plain, { REF: "v2026.11.18.2", EVENT: "push" });
    expect(d.status).toBe(0);
    expect(d.outputs).toEqual({
      ref: "v2026.11.18.2",
      commit: git(plain, "rev-parse", "HEAD"),
      build: "true",
      window: "false",
      publish: "true",
      latest: "true",
    });
    expect(d.stdout).toContain("predates the installer window");
  });

  test("an older release tag is not latest", () => {
    const d = decide(plain, { REF: "v2026.11.18", EVENT: "push" });
    expect(d.status).toBe(0);
    expect(d.outputs["latest"]).toBe("false");
  });

  test("a pushed non-release tag builds and publishes nothing, without error", () => {
    const d = decide(plain, { REF: "vnot-a-release", EVENT: "push" });
    expect(d.status).toBe(0);
    expect(d.outputs["build"]).toBe("false");
    expect(d.outputs["publish"]).toBe("false");
    expect(d.stdout).toContain("::notice::vnot-a-release is not a release tag");
  });

  test("a manual run cannot publish a non-release ref", () => {
    const d = decide(plain, {
      REF: "vnot-a-release",
      EVENT: "workflow_dispatch",
      INPUT_PUBLISH: "true",
    });
    expect(d.status).toBe(1);
    expect(d.stdout).toContain("::error::Only a release tag");
    expect(d.outputs).toEqual({});
  });

  test("a manual run with publish off builds any ref", () => {
    const d = decide(windowed, {
      REF: "vnot-a-release",
      EVENT: "workflow_dispatch",
      INPUT_PUBLISH: "false",
      INPUT_WINDOW: "true",
    });
    expect(d.status).toBe(0);
    expect(d.outputs["build"]).toBe("true");
    expect(d.outputs["publish"]).toBe("false");
    expect(d.outputs["window"]).toBe("true");
  });

  test("a lightweight release tag is refused", () => {
    const d = decide(plain, { REF: "v2026.11.17", EVENT: "push" });
    expect(d.status).toBe(1);
    expect(d.stdout).toContain("is not an annotated tag");
  });

  test("a pushed tag with the crate builds no window while WINDOW_ON_TAGS is off", () => {
    const d = decide(windowed, { REF: "v2026.11.18.2", EVENT: "push" });
    expect(d.status).toBe(0);
    expect(d.outputs["window"]).toBe("false");
    expect(d.stdout).toContain("The installer window is off");
  });

  test("a manual run decides the window with its input", () => {
    const on = decide(windowed, {
      REF: "v2026.11.18.2",
      EVENT: "workflow_dispatch",
      INPUT_PUBLISH: "true",
      INPUT_WINDOW: "true",
    });
    expect(on.status).toBe(0);
    expect(on.outputs["window"]).toBe("true");
    expect(on.outputs["publish"]).toBe("true");
    const off = decide(windowed, {
      REF: "v2026.11.18.2",
      EVENT: "workflow_dispatch",
      INPUT_PUBLISH: "false",
      INPUT_WINDOW: "false",
    });
    expect(off.outputs["window"]).toBe("false");
    expect(off.outputs["publish"]).toBe("false");
  });
});
