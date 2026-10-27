// The DataFiles contract as one suite, run against every provider — so the
// desktop's disk and a browser host's memory cannot drift apart. A provider's
// own test file calls `describeDataFilesConformance` with a harness that hands
// out a fresh, empty root per test.

import { afterEach, describe, expect, test } from "bun:test";
import { systemOrigin } from "@plugins/infra/plugins/request-origin/core";
// Own-plugin test code: the internal files, never the public barrel.
import {
  copyTree,
  readText,
  stageThenRename,
} from "../../core/internal/helpers";
import { relPath, type RelPath } from "../../core/internal/rel-path";
import type { DataChange } from "../../core/internal/types";
import type {
  DataFilesImpl,
  FileRootSpec,
  FileRootStore,
} from "../internal/service";

/** The extensions the suite's watched root reports. */
export const CONFORMANCE_WATCH_EXTENSIONS = [".txt", ".json"] as const;

export interface ConformanceHarness {
  /** A provider with nothing in it. */
  store: DataFilesImpl;
  /** Tear down whatever the harness made (a temp dir). */
  dispose(): Promise<void>;
}

/** The suite's root: watched, with {@link CONFORMANCE_WATCH_EXTENSIONS}. */
export const CONFORMANCE_ROOT: FileRootSpec = {
  id: "conformance.files",
  dir: "cache/data-files-conformance",
  watch: {
    name: "data-files.conformance",
    description: "Hears the conformance suite's writes.",
    extensions: [...CONFORMANCE_WATCH_EXTENSIONS],
  },
};

/** A root that declares no watch. */
export const CONFORMANCE_UNWATCHED_ROOT: FileRootSpec = {
  id: "conformance.unwatched",
  dir: "cache/data-files-conformance-unwatched",
};

const writer = systemOrigin("data-files conformance");
const w = { writer };

/** Settles once `predicate` holds over the changes seen, or rejects after `ms`. */
function collectChanges(ms: number) {
  const seen: DataChange[] = [];
  let wake: (() => void) | null = null;
  return {
    seen,
    handler: (change: DataChange) => {
      seen.push(change);
      wake?.();
    },
    async until(predicate: (seen: DataChange[]) => boolean): Promise<void> {
      const deadline = Date.now() + ms;
      while (!predicate(seen)) {
        const left = deadline - Date.now();
        if (left <= 0) {
          throw new Error(
            `no matching change within ${ms}ms; saw ${JSON.stringify(seen)}`,
          );
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, left);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = null;
      }
    },
  };
}

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

const changedPaths = (seen: readonly DataChange[]): RelPath[] =>
  seen.flatMap((c) => (c.kind === "changed" ? [...c.paths] : []));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/**
 * Register the conformance suite for one provider. `makeHarness` is called once
 * per test.
 */
export function describeDataFilesConformance(
  provider: string,
  makeHarness: () => Promise<ConformanceHarness>,
  opts: { watchTimeoutMs?: number } = {},
): void {
  const watchTimeoutMs = opts.watchTimeoutMs ?? 5_000;
  describe(`DataFiles conformance: ${provider}`, () => {
    let harness: ConformanceHarness | null = null;
    const fresh = async (): Promise<FileRootStore> => {
      harness = await makeHarness();
      return harness.store.root(CONFORMANCE_ROOT);
    };
    afterEach(async () => {
      await harness?.dispose();
      harness = null;
    });

    test("a missing directory is not an empty one", async () => {
      const s = await fresh();
      expect(await s.list(relPath())).toEqual({ kind: "missing" });
      expect(await s.stat(relPath("d"))).toEqual({ kind: "missing" });
      await s.write(relPath("d", "x.txt"), "x", w);
      const listed = await s.list(relPath("d"));
      expect(listed.kind).toBe("listed");
      expect(
        listed.kind === "listed" && listed.entries.map((e) => e.name),
      ).toEqual(["x.txt"]);
      await s.remove(relPath("d", "x.txt"), { ...w, recursive: false });
      expect(await s.list(relPath("d"))).toEqual({
        kind: "listed",
        entries: [],
      });
      expect(await s.list(relPath("nope"))).toEqual({ kind: "missing" });
    });

    test("write then read and stat: text, bytes and blobs", async () => {
      const s = await fresh();
      await s.write(relPath("a.txt"), "héllo", w);
      await s.write(relPath("b.bin"), new Uint8Array([1, 2, 3]), w);
      await s.write(relPath("c.json"), new Blob(['{"k":1}']), w);
      const a = await readText(s, relPath("a.txt"));
      expect(a.kind === "text" && a.text).toBe("héllo");
      const b = await s.read(relPath("b.bin"));
      expect(b.kind).toBe("file");
      if (b.kind === "file") {
        expect([...new Uint8Array(await b.blob.arrayBuffer())]).toEqual([
          1, 2, 3,
        ]);
        expect(b.entry).toMatchObject({ name: "b.bin", kind: "file", size: 3 });
      }
      const c = await s.stat(relPath("c.json"));
      expect(c.kind === "found" && c.entry.size).toBe(7);
      const root = await s.list(relPath());
      expect(root.kind === "listed" && root.entries.map((e) => e.name)).toEqual(
        ["a.txt", "b.bin", "c.json"],
      );
      expect(await s.read(relPath("nope.txt"))).toEqual({ kind: "missing" });
    });

    test("directories are listed as dirs, and reading one throws", async () => {
      const s = await fresh();
      await s.write(relPath("d", "e", "f.txt"), "f", w);
      const st = await s.stat(relPath("d", "e"));
      expect(st.kind === "found" && st.entry.kind).toBe("dir");
      expect(await rejection(s.read(relPath("d")))).toBeInstanceOf(Error);
      expect(
        await rejection(s.list(relPath("d", "e", "f.txt"))),
      ).toBeInstanceOf(Error);
    });

    test("a write replaces whole and leaves no temp file", async () => {
      const s = await fresh();
      await s.write(relPath("a.txt"), "first version, longer", w);
      await s.write(relPath("a.txt"), "second", w);
      const a = await readText(s, relPath("a.txt"));
      expect(a.kind === "text" && a.text).toBe("second");
      const root = await s.list(relPath());
      expect(root.kind === "listed" && root.entries.map((e) => e.name)).toEqual(
        ["a.txt"],
      );
    });

    test("a write onto a directory, under a file, or of the root throws", async () => {
      const s = await fresh();
      await s.write(relPath("d", "x.txt"), "x", w);
      expect(await rejection(s.write(relPath("d"), "no", w))).toBeInstanceOf(
        Error,
      );
      expect(
        await rejection(s.write(relPath("d", "x.txt", "y.txt"), "no", w)),
      ).toBeInstanceOf(Error);
      expect(await rejection(s.write(relPath(), "no", w))).toBeInstanceOf(
        Error,
      );
      const x = await readText(s, relPath("d", "x.txt"));
      expect(x.kind === "text" && x.text).toBe("x");
    });

    test("remove: absent is a no-op, a non-empty dir needs recursive", async () => {
      const s = await fresh();
      await s.remove(relPath("nope"), { ...w, recursive: false });
      await s.write(relPath("d", "e", "x.txt"), "x", w);
      expect(
        await rejection(s.remove(relPath("d"), { ...w, recursive: false })),
      ).toBeInstanceOf(Error);
      expect((await s.stat(relPath("d", "e", "x.txt"))).kind).toBe("found");
      await s.remove(relPath("d"), { ...w, recursive: true });
      expect(await s.stat(relPath("d"))).toEqual({ kind: "missing" });
      expect(
        await rejection(s.remove(relPath(), { ...w, recursive: true })),
      ).toBeInstanceOf(Error);
    });

    test("rename never replaces, and reports a missing source", async () => {
      const s = await fresh();
      await s.write(relPath("a.txt"), "a", w);
      await s.write(relPath("b.txt"), "b", w);
      expect(await s.rename(relPath("a.txt"), relPath("b.txt"), w)).toBe(
        "target-exists",
      );
      const b = await readText(s, relPath("b.txt"));
      expect(b.kind === "text" && b.text).toBe("b");
      expect((await s.stat(relPath("a.txt"))).kind).toBe("found");

      expect(
        await s.rename(relPath("a.txt"), relPath("sub", "a2.txt"), w),
      ).toBe("renamed");
      expect(await s.stat(relPath("a.txt"))).toEqual({ kind: "missing" });
      const moved = await readText(s, relPath("sub", "a2.txt"));
      expect(moved.kind === "text" && moved.text).toBe("a");
      expect(await s.rename(relPath("a.txt"), relPath("c.txt"), w)).toBe(
        "missing",
      );
    });

    test("rename moves a directory whole, never onto another", async () => {
      const s = await fresh();
      await s.write(relPath("src", "x.txt"), "x", w);
      await s.write(relPath("src", "deep", "y.txt"), "y", w);
      await s.write(relPath("taken", "z.txt"), "z", w);
      expect(await s.rename(relPath("src"), relPath("taken"), w)).toBe(
        "target-exists",
      );
      expect(await s.rename(relPath("src"), relPath("dest"), w)).toBe(
        "renamed",
      );
      const y = await readText(s, relPath("dest", "deep", "y.txt"));
      expect(y.kind === "text" && y.text).toBe("y");
      expect(await s.stat(relPath("src"))).toEqual({ kind: "missing" });
      expect(
        await rejection(s.rename(relPath("dest"), relPath("dest", "inner"), w)),
      ).toBeInstanceOf(Error);
    });

    test("stageThenRename and copyTree compose the operations", async () => {
      const s = await fresh();
      await s.write(relPath("tpl", "index.html"), "<p>t</p>", w);
      await s.write(relPath("tpl", "css", "s.css"), "p{}", w);
      const first = await stageThenRename(
        s,
        relPath("made"),
        (staging) => copyTree(s, relPath("tpl"), s, staging, writer),
        writer,
      );
      expect(first).toBe("renamed");
      const css = await readText(s, relPath("made", "css", "s.css"));
      expect(css.kind === "text" && css.text).toBe("p{}");
      const second = await stageThenRename(
        s,
        relPath("made"),
        (staging) => copyTree(s, relPath("tpl"), s, staging, writer),
        writer,
      );
      expect(second).toBe("target-exists");
      const root = await s.list(relPath());
      // No staging directory is left behind either way.
      expect(root.kind === "listed" && root.entries.map((e) => e.name)).toEqual(
        ["made", "tpl"],
      );
    });

    test("withLock: one holder per key, keys independent, released on throw", async () => {
      const s = await fresh();
      const order: string[] = [];
      const gate = deferred();
      const firstIn = deferred();
      const first = s.withLock(relPath("k"), async () => {
        order.push("first:start");
        firstIn.resolve();
        await gate.promise;
        order.push("first:end");
      });
      await firstIn.promise;
      const second = s.withLock(relPath("k"), async () => {
        order.push("second");
      });
      // A different key is not held up by the first.
      await s.withLock(relPath("other"), async () => {
        order.push("other");
      });
      gate.resolve();
      await Promise.all([first, second]);
      expect(order).toEqual(["first:start", "other", "first:end", "second"]);

      expect(
        (
          await rejection(
            s.withLock(relPath("k"), async () => {
              throw new Error("boom");
            }),
          )
        ).message,
      ).toContain("boom");
      expect(await s.withLock(relPath("k"), async () => "again")).toBe("again");
    });

    test("watch hears a write, filtered by the root's extensions", async () => {
      const s = await fresh();
      const changes = collectChanges(watchTimeoutMs);
      const sub = await s.watch(changes.handler);
      try {
        await s.write(relPath("ignored.bin"), "x", w);
        await s.write(relPath("d", "seen.txt"), "x", w);
        await changes.until((seen) =>
          changedPaths(seen).includes(relPath("d", "seen.txt")),
        );
        expect(changedPaths(changes.seen)).not.toContain(
          relPath("ignored.bin"),
        );
      } finally {
        await sub.dispose();
      }
    });

    test("watch on a root without a watch policy throws", async () => {
      await fresh();
      const unwatched = harness!.store.root(CONFORMANCE_UNWATCHED_ROOT);
      expect(
        (await rejection(unwatched.watch(() => undefined))).message,
      ).toContain("watch");
    });

    test("roots are separate trees", async () => {
      const s = await fresh();
      const other = harness!.store.root(CONFORMANCE_UNWATCHED_ROOT);
      await s.write(relPath("a.txt"), "a", w);
      expect(await other.stat(relPath("a.txt"))).toEqual({ kind: "missing" });
    });
  });
}
