import { afterAll, expect, test } from "bun:test";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flockTry } from "@plugins/packages/plugins/flock/core";
import { defineFileWatcher } from "@plugins/infra/plugins/file-watcher/server";
import { systemOrigin } from "@plugins/infra/plugins/request-origin/core";
import { relPath } from "../../core/internal/rel-path";
import { LockBusyError } from "../../core/internal/types";
import type { FileRootSpec } from "../../server";
import { describeDataFilesConformance } from "../../server/testing";
import {
  createDiskDataFiles,
  restoreLedgerEntry,
  type BoundRoot,
} from "./disk-store";
import { diskTree, writeRawAtomic } from "./disk-tree";

/**
 * The error `p` rejected with; throws if it resolved. (`expect(p).rejects` is
 * typed `void` under bun:test, so it cannot be awaited under `await-thenable`.)
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    if (err instanceof Error) return err;
    throw err;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

let watchers = 0;

/** A disk provider over a fresh temp dir: each root a subdir named by its id. */
async function diskHarness() {
  const tmp = await mkdtemp(join(tmpdir(), "data-files-"));
  const bound = new Map<string, BoundRoot>();
  const store = createDiskDataFiles({
    lockWaitMs: 500,
    bound: (spec: FileRootSpec) => {
      let b = bound.get(spec.id);
      if (b === undefined) {
        const watch = spec.watch;
        const watcher =
          watch === undefined
            ? null
            : defineFileWatcher({
                // Watcher names are process-unique: one per harness.
                name: `${watch.name}.${++watchers}`,
                description: watch.description,
                extensions: watch.extensions && [...watch.extensions],
              });
        watcher?.register();
        b = { dir: () => join(tmp, spec.id), watcher, ledger: null };
        bound.set(spec.id, b);
      }
      return b;
    },
  });
  return {
    store,
    dispose: () => rm(tmp, { recursive: true, force: true }),
  };
}

describeDataFilesConformance("disk", diskHarness);

const temps: string[] = [];
afterAll(async () => {
  for (const t of temps) await rm(t, { recursive: true, force: true });
});

test("withLock takes <key>.lock inside the root, and gives up on a wedged holder", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "data-files-lock-"));
  temps.push(tmp);
  const tree = diskTree({ dir: () => tmp, label: "test", lockWaitMs: 300 });
  mkdirSync(join(tmp, "_picks"), { recursive: true });
  // Another open file description holding the same lock file: what another
  // process (the CLI) holding it looks like.
  const fd = openSync(join(tmp, "_picks", "p-1.lock"), "a");
  expect(flockTry(fd)).toBe(true);
  try {
    expect(
      await rejection(
        tree.withLock(relPath("_picks", "p-1"), async () => "never"),
      ),
    ).toBeInstanceOf(LockBusyError);
  } finally {
    closeSync(fd);
  }
  expect(
    await tree.withLock(relPath("_picks", "p-1"), async () => "free"),
  ).toBe("free");
});

test("a write's temp file never shows in a listing", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "data-files-tmp-"));
  temps.push(tmp);
  const tree = diskTree({ dir: () => tmp, label: "test" });
  const w = { writer: systemOrigin("disk test") };
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      tree.write(relPath("a.json"), `{"i":${i}}`, w),
    ),
  );
  const listed = await tree.list(relPath());
  expect(listed.kind === "listed" && listed.entries.map((e) => e.name)).toEqual(
    ["a.json"],
  );
});

test("a read's bytes are read: a remove after it cannot fail them", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "data-files-race-"));
  temps.push(tmp);
  const tree = diskTree({ dir: () => tmp, label: "test" });
  const w = { writer: systemOrigin("disk test") };
  await tree.write(relPath("p", "a.html"), "<p>a</p>", w);
  const read = await tree.read(relPath("p", "a.html"));
  // An editor's atomic save, or the folder trashed, after the read returned.
  await rm(join(tmp, "p"), { recursive: true });
  expect(read.kind === "file" && (await read.blob.text())).toBe("<p>a</p>");
  expect((await tree.read(relPath("p", "a.html"))).kind).toBe("missing");
  expect((await tree.list(relPath("p"))).kind).toBe("missing");
});

test("withLock's deadline covers the wait behind a holder in this process too", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "data-files-inproc-"));
  temps.push(tmp);
  const tree = diskTree({ dir: () => tmp, label: "test", lockWaitMs: 200 });
  const key = relPath("_history", "p-1");
  let release!: () => void;
  const holding = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  const holder = tree.withLock(key, async () => {
    entered();
    await holding;
  });
  await inside;
  let ran = false;
  expect(
    await rejection(
      tree.withLock(key, async () => {
        ran = true;
      }),
    ),
  ).toBeInstanceOf(LockBusyError);
  release();
  await holder;
  // The waiter that gave up never runs, and the lock is free again.
  expect(ran).toBe(false);
  expect(await tree.withLock(key, async () => "free")).toBe("free");
});

test("a ledger entry restores by its one role, a role recorded before the root's included", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "data-files-ledger-"));
  temps.push(tmp);
  const file = join(tmp, "_picks", "p-1.json");
  await writeRawAtomic(file, '{"agent":true}');
  // What the prototypes picks store recorded before its ledger moved onto
  // the root: the same one-file snapshot, under the role `picks`.
  const legacy = {
    ledgerId: "prototype-picks",
    key: "p-1",
    paths: { picks: file },
    before: { picks: { present: true, bytes: '{"user":true}' } },
    after: { picks: { present: true, bytes: '{"agent":true}' } },
    source: "s",
    operations: ["set"],
    firstWriteAt: "",
    lastWriteAt: "",
  } as unknown as Parameters<typeof restoreLedgerEntry>[0];
  await restoreLedgerEntry(legacy);
  expect(await Bun.file(file).text()).toBe('{"user":true}');
  const twoRoles = {
    ...legacy,
    paths: { a: file, b: file },
  } as unknown as Parameters<typeof restoreLedgerEntry>[0];
  expect((await rejection(restoreLedgerEntry(twoRoles))).message).toContain(
    "exactly one file",
  );
});
