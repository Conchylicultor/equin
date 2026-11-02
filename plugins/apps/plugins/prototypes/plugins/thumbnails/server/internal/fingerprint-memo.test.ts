import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  parseRelPath,
  relPath,
  type FileData,
  type Mount,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { createMemoryDataFiles } from "@plugins/infra/plugins/paths/plugins/data-files/plugins/memory/server/testing";
import { systemOrigin } from "@plugins/infra/plugins/request-origin/core";
import { persistedFingerprintMemo } from "./fingerprint-memo";
import { fingerprintFolder, noFingerprintMemo } from "./hash-dir";

const writer = systemOrigin("fingerprint memo test");

function freshRoots(): { tree: Mount; cache: Mount } {
  const files = createMemoryDataFiles();
  return {
    tree: files.root({ id: "thumbnails.memo-tree", dir: "apps/memo-tree" }),
    cache: files.root({ id: "thumbnails.memo-cache", dir: "cache/memo-cache" }),
  };
}

async function write(mount: Mount, path: string, data: FileData) {
  await mount.write(parseRelPath(path), data, { writer });
}

// Every file older than the memo's settle window, as on a boot.
function settle(): void {
  setSystemTime(new Date(Date.now() + 10_000));
}

afterEach(() => setSystemTime());

/** Counts the reads a fingerprint makes, to tell a memo hit from a hash. */
function counting(mount: Mount): { mount: Mount; reads: () => number } {
  let reads = 0;
  return {
    mount: {
      ...mount,
      list: (dir) => mount.list(dir),
      stat: (path) => mount.stat(path),
      read: (path) => {
        reads++;
        return mount.read(path);
      },
    },
    reads: () => reads,
  };
}

async function keyOf(
  mount: Mount,
  memo: Awaited<
    ReturnType<ReturnType<typeof persistedFingerprintMemo>["load"]>
  >,
): Promise<string> {
  const fp = await fingerprintFolder(mount, relPath("p"), memo);
  if (fp.kind !== "hashed") throw new Error("p is missing");
  return fp.key;
}

describe("fingerprint memo", () => {
  test("an unchanged folder is answered from the memo, on another process too", async () => {
    const { tree, cache } = freshRoots();
    await write(tree, "p/index.html", "<h1>hi</h1>");
    await write(tree, "p/app.js", "x");
    settle();

    const first = persistedFingerprintMemo(cache);
    const t1 = counting(tree);
    const key = await keyOf(t1.mount, await first.load());
    expect(t1.reads()).toBe(2);
    await first.save();

    // A second backend's boot: a fresh process memo over the same cache.
    const second = persistedFingerprintMemo(cache);
    const t2 = counting(tree);
    expect(await keyOf(t2.mount, await second.load())).toBe(key);
    expect(t2.reads()).toBe(0);
    // The memo's answer is the content hash itself.
    expect(
      await fingerprintFolder(tree, relPath("p"), noFingerprintMemo),
    ).toEqual({ kind: "hashed", key });
  });

  test("an edit moves the listing and is hashed again", async () => {
    const { tree, cache } = freshRoots();
    await write(tree, "p/index.html", "<h1>hi</h1>");
    settle();
    const memo = persistedFingerprintMemo(cache);
    const before = await keyOf(tree, await memo.load());

    await write(tree, "p/index.html", "<h1>hi!</h1>");
    const t = counting(tree);
    const after = await keyOf(t.mount, await memo.load());
    expect(t.reads()).toBe(1);
    expect(after).not.toBe(before);
  });

  test("a file written within the settle window is hashed, never remembered", async () => {
    const { tree, cache } = freshRoots();
    await write(tree, "p/index.html", "<h1>hi</h1>");
    const memo = persistedFingerprintMemo(cache);
    await keyOf(tree, await memo.load());
    await memo.save();

    // Nothing learned, so nothing written.
    expect(
      (await cache.read(parseRelPath("fingerprints/memo.json"))).kind,
    ).toBe("missing");
    const t = counting(tree);
    await keyOf(t.mount, await memo.load());
    expect(t.reads()).toBe(1);
  });

  test("a boot that learned nothing writes nothing", async () => {
    const { tree, cache } = freshRoots();
    await write(tree, "p/index.html", "<h1>hi</h1>");
    settle();
    const first = persistedFingerprintMemo(cache);
    await keyOf(tree, await first.load());
    await first.save();
    const saved = await cache.stat(parseRelPath("fingerprints/memo.json"));
    settle();

    const second = persistedFingerprintMemo(cache);
    await keyOf(tree, await second.load());
    await second.retainOnly(["p"]);
    await second.save();
    expect(await cache.stat(parseRelPath("fingerprints/memo.json"))).toEqual(
      saved,
    );
  });

  test("two backends' saves merge; retainOnly drops a removed folder", async () => {
    const { tree, cache } = freshRoots();
    await write(tree, "p/index.html", "a");
    await write(tree, "q/index.html", "b");
    settle();
    const a = persistedFingerprintMemo(cache);
    const b = persistedFingerprintMemo(cache);
    const memoA = await a.load();
    const memoB = await b.load();
    await fingerprintFolder(tree, relPath("p"), memoA);
    await fingerprintFolder(tree, relPath("q"), memoB);
    await a.save();
    await b.save();

    const c = persistedFingerprintMemo(cache);
    const t = counting(tree);
    await fingerprintFolder(t.mount, relPath("p"), await c.load());
    await fingerprintFolder(t.mount, relPath("q"), await c.load());
    expect(t.reads()).toBe(0);

    await c.retainOnly(["q"]);
    await c.save();
    const d = persistedFingerprintMemo(cache);
    const t2 = counting(tree);
    await fingerprintFolder(t2.mount, relPath("p"), await d.load());
    expect(t2.reads()).toBe(1);
  });

  test("a memo of another version is a cold memo, not an error", async () => {
    const { tree, cache } = freshRoots();
    await write(tree, "p/index.html", "a");
    settle();
    await write(
      cache,
      "fingerprints/memo.json",
      JSON.stringify({ version: 0, anything: true }),
    );
    const t = counting(tree);
    await keyOf(t.mount, await persistedFingerprintMemo(cache).load());
    expect(t.reads()).toBe(1);
  });

  test("a file rewritten between the listing and its read is not remembered", async () => {
    const { tree, cache } = freshRoots();
    await write(tree, "p/index.html", "old");
    settle();
    const memo = persistedFingerprintMemo(cache);
    // The edit lands after the listing, before the read.
    const racing: Mount = {
      ...tree,
      read: async (path) => {
        await write(tree, "p/index.html", "new");
        return tree.read(path);
      },
    };
    await fingerprintFolder(racing, relPath("p"), await memo.load());
    await memo.save();
    expect(
      (await cache.read(parseRelPath("fingerprints/memo.json"))).kind,
    ).toBe("missing");
  });

  test("a failed load is loud, and not kept for the next sync", async () => {
    const { tree, cache } = freshRoots();
    await write(tree, "p/index.html", "a");
    await write(cache, "fingerprints/memo.json", "{not json");
    const memo = persistedFingerprintMemo(cache);
    const failed = await memo.load().then(
      () => null,
      (err: unknown) => err,
    );
    expect(failed).toBeInstanceOf(SyntaxError);
    await write(
      cache,
      "fingerprints/memo.json",
      JSON.stringify({ version: 1, folders: {} }),
    );
    settle();
    expect(await keyOf(tree, await memo.load())).toBeString();
  });
});
