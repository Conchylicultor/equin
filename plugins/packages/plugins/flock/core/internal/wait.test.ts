import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flockTry } from "./flock";
import { waitForFlock, type HeldFlock } from "./wait";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const within = <T>(p: Promise<T>, ms: number): Promise<T | "timeout"> =>
  Promise.race([
    p,
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms)),
  ]);

describe("waitForFlock (real flocks)", () => {
  // macOS wakes ONE blocked flock waiter per release and parks the others
  // behind it, so shared waiters used to be granted one at a time — each only
  // when the one before it released. On 2026-11-18 ten agent builds waiting
  // shared at the build gate ran strictly one after the other on an idle host.
  test("every shared waiter is granted once the exclusive holder releases", async () => {
    dir = mkdtempSync(join(tmpdir(), "flock-wait-"));
    const file = join(dir, "gate.lock");
    const fd = openSync(file, "w");
    expect(flockTry(fd)).toBe(true);

    const waits = [0, 1, 2].map(() => waitForFlock(file, { shared: true }));
    // Let all three block in the kernel behind the exclusive holder.
    await new Promise((r) => setTimeout(r, 1500));
    closeSync(fd);

    const held: HeldFlock[] = [];
    try {
      const all = await within(
        Promise.all(waits.map((w) => w.then((h) => (held.push(h), h)))),
        5000,
      );
      expect(all).not.toBe("timeout");
      expect(held.length).toBe(3);
    } finally {
      await Promise.all(held.map((h) => h.release()));
      // A waiter never granted releases the moment it is.
      void Promise.all(waits.map((w) => w.then((h) => h.release())));
    }
  }, 20_000);
});
