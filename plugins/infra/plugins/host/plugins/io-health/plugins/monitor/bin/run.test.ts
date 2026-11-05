import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { run } from "./run";

const tmp = mkdtempSync(join(tmpdir(), "fs-latency-run-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("run", () => {
  // launchd gives a LaunchDaemon no locale; in C, ps writes `·` as `M-BM-7`.
  test("ps names a process with a non-ASCII name in UTF-8, whatever this process's locale", () => {
    const name = "equin · test · run";
    const exe = join(tmp, name);
    copyFileSync("/bin/sleep", exe);
    const child = Bun.spawn([exe, "30"], { env: {} });
    try {
      const comm = run(["ps", "-o", "comm=", "-p", String(child.pid)]).trim();
      expect(basename(comm)).toBe(name);
    } finally {
      child.kill();
    }
  });
});
