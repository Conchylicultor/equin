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
  test("the user agent stands aside only while a root tick is recent, in awake time", () => {
    const boot = "boot-a";
    const now = { at: 10_000, awakeMs: 5_000_000, boot };
    const window = ROOT_FRESH_INTERVALS * 30 * 1000;
    const rootAwakeAgo = (ms: number, wallS = ms / 1000) => ({
      at: now.at - wallS,
      awakeMs: now.awakeMs - ms,
      boot,
    });
    expect(rootIsWriting(undefined, now, 30)).toBe(false);
    expect(rootIsWriting(rootAwakeAgo(30_000), now, 30)).toBe(true);
    expect(rootIsWriting(rootAwakeAgo(window), now, 30)).toBe(true);
    // A root daemon that stopped while the machine is awake: caught as before.
    expect(rootIsWriting(rootAwakeAgo(window + 1), now, 30)).toBe(false);
    expect(rootIsWriting(rootAwakeAgo(10 * 60_000), now, 30)).toBe(false);
  });

  test("a nap does not age the root's last tick (main, 2026-11-20: a user tick on every wake)", () => {
    const boot = "boot-a";
    // 04:45:59: the user agent fired 1 s before the root on a wake from a
    // 769 s sleep; the root's last tick was 30 s of awake time earlier.
    const now = { at: 1_795_149_959, awakeMs: 5_000_000, boot };
    const root = { at: now.at - 30 - 769, awakeMs: now.awakeMs - 30_000, boot };
    expect(rootIsWriting(root, now, 30)).toBe(true);
    // The same tick a root that also stopped writing before the nap left:
    // 3 min of awake time old, so the user agent ticks and says so.
    const stopped = { ...root, awakeMs: now.awakeMs - 180_000 };
    expect(rootIsWriting(stopped, now, 30)).toBe(false);
  });

  test("a tick from another boot is aged on the wall clock", () => {
    const now = { at: 10_000, awakeMs: 60_000, boot: "boot-b" };
    // The awake clock restarted at boot: its 60 s says nothing about boot-a's tick.
    expect(
      rootIsWriting(
        { at: now.at - 3600, awakeMs: 10_000, boot: "boot-a" },
        now,
        30,
      ),
    ).toBe(false);
    expect(
      rootIsWriting(
        { at: now.at - 30, awakeMs: 9_999_999, boot: "boot-a" },
        now,
        30,
      ),
    ).toBe(true);
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
