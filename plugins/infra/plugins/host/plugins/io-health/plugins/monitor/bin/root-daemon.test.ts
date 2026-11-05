import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ROOT_FRESH_INTERVALS,
  installRootCommand,
  renderRootDaemonPlist,
  rootIsWriting,
} from "./root-daemon";
import { exec } from "./run";

const tmp = mkdtempSync(join(tmpdir(), "fs-latency-root-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const spec = {
  label: "dev.equin.fs-latency-monitor",
  executable: "/opt/x y/equin.app/Contents/MacOS/fs-latency-monitor",
  dir: "/opt/x y/logs/<monitors> & co",
  intervalS: 30,
};

describe("root daemon", () => {
  test("the user agent stands aside only while a root tick is recent", () => {
    const now = 10_000;
    expect(rootIsWriting(undefined, now, 30)).toBe(false);
    expect(rootIsWriting(now - 30, now, 30)).toBe(true);
    expect(rootIsWriting(now - ROOT_FRESH_INTERVALS * 30, now, 30)).toBe(true);
    expect(rootIsWriting(now - ROOT_FRESH_INTERVALS * 30 - 1, now, 30)).toBe(
      false,
    );
  });

  test("its plist parses (plutil) and runs the tick with the same label and interval", () => {
    const path = join(tmp, "root.plist");
    writeFileSync(path, renderRootDaemonPlist(spec));
    expect(exec(["plutil", "-lint", path]).exitCode).toBe(0);
    const json = JSON.parse(
      exec(["plutil", "-convert", "json", "-o", "-", path]).stdout,
    ) as { Label: string; ProgramArguments: string[]; StartInterval: number };
    expect(json.Label).toBe(spec.label);
    expect(json.StartInterval).toBe(30);
    expect(json.ProgramArguments).toEqual([
      spec.executable,
      "--dir",
      spec.dir,
      "--root-label",
      spec.label,
      "--interval-s",
      "30",
    ]);
  });

  test("an empty plist is what plutil refuses (the 2026-11-04 failure)", () => {
    const path = join(tmp, "empty.plist");
    writeFileSync(path, "");
    expect(exec(["plutil", "-lint", path]).exitCode).not.toBe(0);
  });

  test("the repair command quotes its paths as single shell words", () => {
    const argv = exec([
      "/bin/sh",
      "-c",
      `set -- ${installRootCommand(spec).replace(/^sudo /, "")}; for a; do printf '%s\\n' "$a"; done`,
    ]).stdout.split("\n");
    expect(argv.slice(0, 4)).toEqual([
      spec.executable,
      "install-root",
      "--dir",
      spec.dir,
    ]);
  });
});
