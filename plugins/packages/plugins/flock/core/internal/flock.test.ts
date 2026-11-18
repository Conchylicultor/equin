import { afterEach, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flockSharedSync, flockTry, flockTryShared } from "./flock";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

// The boot lease's acquire (main-slots/boot-lease): the same flock on macOS and
// Linux — it was macOS's O_SHLOCK open, which made every Linux main deploy fail.
test("flockSharedSync holds a shared lock: shares with readers, keeps a writer out", () => {
  dir = mkdtempSync(join(tmpdir(), "flock-shared-sync-"));
  const file = join(dir, "tree.lock");
  const held = openSync(file, "a");
  const other = openSync(file, "a");
  try {
    flockSharedSync(held);
    expect(flockTry(other)).toBe(false);
    expect(flockTryShared(other)).toBe(true);
  } finally {
    closeSync(other);
    closeSync(held);
  }
  // Closing the descriptor dropped it.
  const after = openSync(file, "a");
  try {
    expect(flockTry(after)).toBe(true);
  } finally {
    closeSync(after);
  }
});
