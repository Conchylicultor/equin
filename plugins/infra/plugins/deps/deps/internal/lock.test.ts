import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLockHeld, releaseLock, tryLock } from "./lock";

let base: string;
let path: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "deps-lock-"));
  path = join(base, "x.lock");
  await writeFile(path, "");
});
afterEach(() => rm(base, { recursive: true, force: true }));

// The probe takes the flock for a moment and releases it across an await; an
// overlapping in-process probe or attempt must never mistake it for a holder.
test("overlapping in-process probes never see each other as a holder", async () => {
  const answers = await Promise.all(
    Array.from({ length: 8 }, () => isLockHeld(path)),
  );
  expect(answers).toEqual(Array.from({ length: 8 }, () => false));
});

test("an attempt overlapping a probe takes the lock", async () => {
  const [held, lock] = await Promise.all([isLockHeld(path), tryLock(path)]);
  expect(held).toBe(false);
  expect(lock).not.toBeNull();
  expect(await isLockHeld(path)).toBe(true);
  await releaseLock(lock!);
  expect(await isLockHeld(path)).toBe(false);
});
