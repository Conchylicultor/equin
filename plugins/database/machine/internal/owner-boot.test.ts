import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "node:os";
import { join } from "path";
import { flockTry } from "@plugins/packages/plugins/flock/core";
import { openOwnedFdSync } from "@plugins/packages/plugins/owned-fd/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { awaitLocksReleased } from "./deploys-settled";
import {
  claimOwnerBootAt,
  readOwnerBootRecordAt,
  settleSchemaOwnerBoot,
  type OwnerBootPaths,
} from "./owner-boot";

const dir = mkdtempSync(join(os.tmpdir(), "owner-boot-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function freshPaths(): OwnerBootPaths {
  n++;
  return {
    lock: asAppPath(join(dir, `ns-${String(n)}`, "schema-owner-boot.lock")),
    record: asAppPath(join(dir, `ns-${String(n)}`, "schema-owner-boot.json")),
  };
}

// The module holds one claim per process (a serving backend's): never leak one
// into the next test.
afterEach(() => settleSchemaOwnerBoot({ kind: "recorded" }));

/** A build: the checkout's build lock, held exclusively on a descriptor of this process. */
function startBuild() {
  const path = asAppPath(join(dir, `build-${String(++n)}.lock`));
  writeFileSync(path, "");
  const fd = openOwnedFdSync(path, "r");
  if (!flockTry(fd.fd)) throw new Error(`could not take ${path}`);
  return { path, exit: () => fd.close() };
}

const tick = (ms = 300) => new Promise((r) => setTimeout(r, ms));

describe("the schema-owner boot marker", () => {
  test("a build exits on a deadline arm while its backend still boots: the child keeps waiting, and runs once the stamp is recorded", async () => {
    // The build restarted the backend, which claimed the marker at its entry.
    const build = startBuild();
    const paths = freshPaths();
    await claimOwnerBootAt(paths, 1_000);
    expect(await readOwnerBootRecordAt(paths.record)).toMatchObject({
      kind: "booting",
      pid: process.pid,
      startedAt: 1_000,
    });

    let settled = false;
    const waiting = awaitLocksReleased(
      [
        { path: build.path, what: "a build of this checkout" },
        {
          path: paths.lock,
          what: "the serving backend's boot",
          heldBy: "shared",
        },
      ],
      new AbortController().signal,
    ).then((waited) => {
      settled = true;
      return waited;
    });
    await tick();
    expect(settled).toBe(false);

    // "server still booting under host load": the build reports ok and exits,
    // dropping its lock, before the backend's onReady.
    build.exit();
    await tick();
    expect(settled).toBe(false);

    // The backend's onReady recorded the stamp.
    await settleSchemaOwnerBoot({ kind: "recorded" });
    expect(await waiting).toEqual([
      "a build of this checkout",
      "the serving backend's boot",
    ]);
    expect(await readOwnerBootRecordAt(paths.record)).toMatchObject({
      kind: "recorded",
    });
  });

  test("a failed stamp write is recorded before the marker is let go", async () => {
    const paths = freshPaths();
    await claimOwnerBootAt(paths, 2_000);
    const waiting = awaitLocksReleased(
      [
        {
          path: paths.lock,
          what: "the serving backend's boot",
          heldBy: "shared",
        },
      ],
      new AbortController().signal,
    );
    await settleSchemaOwnerBoot({ kind: "stamp-failed", error: "boom" });
    expect(await waiting).toEqual(["the serving backend's boot"]);
    // What the woken child reads: the failure, never `booting`.
    expect(await readOwnerBootRecordAt(paths.record)).toEqual({
      kind: "stamp-failed",
      error: "boom",
      pid: process.pid,
      startedAt: 2_000,
    });
  });

  test("no backend booting (marker free or never created): nothing to wait for", async () => {
    const paths = freshPaths();
    expect(
      await awaitLocksReleased(
        [
          {
            path: paths.lock,
            what: "the serving backend's boot",
            heldBy: "shared",
          },
        ],
        new AbortController().signal,
      ),
    ).toEqual([]);
    expect(await readOwnerBootRecordAt(paths.record)).toBeNull();
    await claimOwnerBootAt(paths, 3_000);
    await settleSchemaOwnerBoot({ kind: "recorded" });
    expect(
      await awaitLocksReleased(
        [
          {
            path: paths.lock,
            what: "the serving backend's boot",
            heldBy: "shared",
          },
        ],
        new AbortController().signal,
      ),
    ).toEqual([]);
  });

  test("a second claim in one process is refused", async () => {
    await claimOwnerBootAt(freshPaths(), 4_000);
    let caught: unknown;
    try {
      await claimOwnerBootAt(freshPaths(), 4_001);
    } catch (err) {
      caught = err;
    }
    expect(String(caught)).toContain("claimed twice");
  });
});
