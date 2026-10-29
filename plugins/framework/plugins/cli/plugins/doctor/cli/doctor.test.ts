import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";

const DOCTOR = join(import.meta.dir, "..", "doctor.sh");

/**
 * A machine the doctor can see nothing of but what a scenario puts there: PATH
 * is ONLY a directory of stub executables (the doctor's probes are builtins
 * plus the tools it checks), and HOME is empty.
 */
interface Machine {
  home: string;
  bin: string;
  shims: string;
}

const made: string[] = [];

function machine(): Machine {
  const home = mkdtempSync(join(tmpdir(), "sg-doctor-"));
  made.push(home);
  const bin = join(home, "stub-bin");
  const shims = join(home, ".local", "share", "mise", "shims");
  mkdirSync(bin, { recursive: true });
  mkdirSync(shims, { recursive: true });
  return { home, bin, shims };
}

function stub(dir: string, name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/** A healthy macOS user; each scenario then breaks one thing. */
function healthy(m: Machine): void {
  stub(m.bin, "id", "echo 501");
  stub(m.bin, "uname", "echo Darwin");
  stub(m.bin, "xcode-select", "echo /Library/Developer/CommandLineTools");
  stub(m.bin, "git", "echo 'git version 2.50.0'");
  stub(m.bin, "mise", "exit 0");
}

async function doctor(m: Machine, path: string[] = [m.bin, m.shims]) {
  const result = await spawnCaptured(["/bin/sh", DOCTOR], {
    cwd: m.home,
    env: { HOME: m.home, PATH: path.join(":"), SHELL: "/bin/zsh" },
    timeoutMs: 30_000,
  });
  return { code: result.exitCode, out: result.stdout + result.stderr };
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("doctor.sh", () => {
  test("a healthy machine passes", async () => {
    const m = machine();
    healthy(m);
    const { code, out } = await doctor(m);
    expect(out).toContain("all present");
    expect(code).toBe(0);
  });

  test("a clean Mac: every missing prerequisite is named in ONE run", async () => {
    const m = machine();
    stub(m.bin, "id", "echo 501");
    stub(m.bin, "uname", "echo Darwin");
    // No xcode-select success, no mise.
    stub(m.bin, "xcode-select", "exit 2");
    const { code, out } = await doctor(m, [m.bin]);
    expect(code).toBe(1);
    expect(out).toContain("2 missing");
    expect(out).toContain("xcode-select --install");
    expect(out).toContain("curl https://mise.run | sh");
    expect(out).not.toContain("claude");
  });

  test("root is refused", async () => {
    const m = machine();
    healthy(m);
    stub(m.bin, "id", "echo 0");
    const { code, out } = await doctor(m);
    expect(code).toBe(1);
    expect(out).toContain("Running as root");
  });

  test("mise installed but not active in the shell", async () => {
    const m = machine();
    healthy(m);
    rmSync(join(m.bin, "mise"));
    const local = join(m.home, ".local", "bin");
    mkdirSync(local, { recursive: true });
    stub(local, "mise", "exit 0");
    const { code, out } = await doctor(m, [m.bin]);
    expect(code).toBe(1);
    expect(out).toContain("1 missing");
    expect(out).toContain("not active in your shell");
    expect(out).toContain("mise activate zsh");
  });

  test("names the missing locked tools", async () => {
    const m = machine();
    healthy(m);
    stub(
      m.bin,
      "mise",
      [
        'case "$1 $2" in',
        '  "install --dry-run-code") exit 1 ;;',
        '  "ls --missing") echo "go    1.27.1"; echo "rust  1.95.0" ;;',
        "esac",
      ].join("\n"),
    );
    const { code, out } = await doctor(m);
    expect(code).toBe(1);
    expect(out).toContain("1 missing");
    expect(out).toContain("go@1.27.1 rust@1.95.0");
  });

  test("shims that do not resolve are named, with the reshim fix", async () => {
    const m = machine();
    healthy(m);
    // The 2026-09-27 state: every shim → shims/bun, and shims/bun → itself.
    symlinkSync(join(m.shims, "bun"), join(m.shims, "bun"));
    symlinkSync(join(m.shims, "bun"), join(m.shims, "go"));
    const { code, out } = await doctor(m);
    expect(code).toBe(1);
    expect(out).toContain("1 missing");
    expect(out).toContain(
      "mise shims do not resolve (a symlink loop, or mise moved): bun go",
    );
    expect(out).toContain(`${join(m.bin, "mise")} reshim --force`);
  });

  test("shims linked to the mise binary pass", async () => {
    const m = machine();
    healthy(m);
    symlinkSync(join(m.bin, "mise"), join(m.shims, "bun"));
    symlinkSync(join(m.bin, "mise"), join(m.shims, "go"));
    const { code, out } = await doctor(m);
    expect(out).toContain("all present");
    expect(code).toBe(0);
  });

  test("shims that install missing tools on first use are refused", async () => {
    const m = machine();
    healthy(m);
    const settings = (value: string) =>
      [
        'case "$1 $2 $3" in',
        `  "settings get not_found_auto_install") echo ${value} ;;`,
        "esac",
      ].join("\n");
    stub(m.bin, "mise", settings("true"));
    const on = await doctor(m);
    expect(on.code).toBe(1);
    expect(on.out).toContain("mise shims install missing tools on first use");
    expect(on.out).toContain("mise run setup");

    stub(m.bin, "mise", settings("false"));
    const off = await doctor(m);
    expect(off.out).toContain("all present");
    expect(off.code).toBe(0);
  });
});
