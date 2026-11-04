import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { acquireDrainerLock, releaseDrainerLock } from "./drainer-lock";

// flock is per open file description, so two acquires in one process contend
// exactly like two main backends across a deploy.
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "outbox-drainer-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("the successor becomes the drainer only once the holder lets go", async () => {
  const path = asAppPath(join(dir, "drainer.lock"));
  const first = await acquireDrainerLock(path, new AbortController().signal);

  let second: Awaited<ReturnType<typeof acquireDrainerLock>> | null = null;
  const waiting = acquireDrainerLock(path, new AbortController().signal).then(
    (fd) => {
      second = fd;
    },
  );
  await Bun.sleep(300);
  expect(second).toBeNull();

  releaseDrainerLock(first);
  await waiting;
  expect(second).not.toBeNull();
  releaseDrainerLock(second!);
});

test("a shutdown while still waiting gives up without the lock", async () => {
  const path = asAppPath(join(dir, "drainer.lock"));
  const holder = await acquireDrainerLock(path, new AbortController().signal);
  const abort = new AbortController();
  const waiting = acquireDrainerLock(path, abort.signal);
  abort.abort(new Error("shutting down"));
  expect(waiting).rejects.toThrow("shutting down");
  releaseDrainerLock(holder);
});
