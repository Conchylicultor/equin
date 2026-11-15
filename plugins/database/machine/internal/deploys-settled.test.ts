import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "node:os";
import { join } from "path";
import { flockTry } from "@plugins/packages/plugins/flock/core";
import { openOwnedFdSync } from "@plugins/packages/plugins/owned-fd/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { awaitLocksReleased } from "./deploys-settled";

const dir = mkdtempSync(join(os.tmpdir(), "deploys-settled-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function lockFile(name: string) {
  const path = asAppPath(join(dir, name));
  writeFileSync(path, "");
  return path;
}

/** Take `path`'s exclusive flock on a descriptor of this process (a deploy). */
function holdExclusively(path: ReturnType<typeof asAppPath>) {
  const fd = openOwnedFdSync(path, "r");
  if (!flockTry(fd.fd)) throw new Error(`could not take ${path}`);
  return fd;
}

describe("awaitLocksReleased", () => {
  test("nothing held, or no lock file at all: resolves at once, having waited on nothing", async () => {
    const free = lockFile("free.lock");
    const missing = asAppPath(join(dir, "never-created.lock"));
    const waited = await awaitLocksReleased(
      [
        { path: free, what: "a build" },
        { path: missing, what: "a deploy" },
      ],
      new AbortController().signal,
    );
    expect(waited).toEqual([]);
  });

  test("a held lock: resolves only once its holder lets go, naming it", async () => {
    const build = lockFile("build.lock");
    const holder = holdExclusively(build);
    let done = false;
    const waiting = awaitLocksReleased(
      [{ path: build, what: "a build of this checkout" }],
      new AbortController().signal,
    ).then((waited) => {
      done = true;
      return waited;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    holder.close();
    expect(await waiting).toEqual(["a build of this checkout"]);
  });

  test("an abort ends the wait", async () => {
    const deploy = lockFile("deploy.lock");
    const holder = holdExclusively(deploy);
    const stop = new AbortController();
    const waiting = awaitLocksReleased(
      [{ path: deploy, what: "a deploy" }],
      stop.signal,
    );
    stop.abort();
    let caught: unknown;
    try {
      await waiting;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(stop.signal.reason);
    holder.close();
  });
});
