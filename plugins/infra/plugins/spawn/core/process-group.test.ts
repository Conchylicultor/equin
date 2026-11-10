/**
 * A `processGroup: "own"` child takes everything it started with it: what it
 * left in its group when it exited is named in `leftBehind` and is dead by the
 * time the call resolves (2026-11-08: test helpers a runner left behind sat
 * reparented to pid 1 for 45 h).
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnPassthrough } from "./internal/spawn-passthrough";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
}

/** Bounded wait for a test-only condition (a readiness gate, not app logic). */
async function until(what: string, ok: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`);
    await Bun.sleep(25);
  }
}

test("what the child left in its group is named and killed once it exits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "process-group-"));
  try {
    const pidFile = join(dir, "grandchild.pid");
    // A grandchild two levels down, still running when its parent exits.
    const result = await spawnPassthrough(
      [
        "/bin/sh",
        "-c",
        `/bin/sh -c 'sleep 600 & echo $! > ${pidFile}; wait' & sleep 0.2; exit 3`,
      ],
      { processGroup: "own" },
    );
    expect(result.exitCode).toBe(3);
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    expect(result.leftBehind.map((p) => p.pid)).toContain(grandchild);
    expect(
      result.leftBehind.find((p) => p.pid === grandchild)?.command,
    ).toContain("sleep 600");
    // SIGKILLed; gone once launchd has reaped the orphaned zombie.
    await until(`${grandchild} reaped`, () => !alive(grandchild));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a child that leaves nothing behind reports nothing", async () => {
  const result = await spawnPassthrough(["/bin/sh", "-c", "exit 0"], {
    processGroup: "own",
  });
  expect(result.exitCode).toBe(0);
  expect(result.leftBehind).toEqual([]);
});
