import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyIndex,
  publishRefreshedIndex,
  publishRefreshedIndexSync,
  writeIndexCopySync,
  type IndexPublish,
  type SeenIndex,
} from "./private-index";
import {
  type AppPath,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

// Plain files stand in for a checkout's index: the protocol never parses it.
let dir: AppPath;
let realIndex: AppPath;

beforeEach(() => {
  dir = asAppPath(mkdtempSync(join(tmpdir(), "private-index-")));
  realIndex = joinAppPath(dir, "index");
  writeFileSync(realIndex, "real\n");
  // A whole-second mtime well in the past: what a copy stamped "now" is not.
  utimesSync(realIndex, 1_700_000_000, 1_700_000_000);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seenOf(path: AppPath): SeenIndex {
  return statSync(path, { bigint: true });
}

const copies: Record<
  string,
  (src: AppPath, seen: SeenIndex, dst: AppPath) => Promise<void>
> = {
  sync: async (src, seen, dst) =>
    writeIndexCopySync(readFileSync(src), seen, dst),
  async: copyIndex,
};

const publishes: Record<
  string,
  (real: AppPath, refreshed: AppPath, seen: SeenIndex) => Promise<IndexPublish>
> = {
  sync: async (...args) => publishRefreshedIndexSync(...args),
  async: publishRefreshedIndex,
};

for (const [form, copy] of Object.entries(copies)) {
  describe(`copy (${form})`, () => {
    test("keeps the source's mtime, not now's", async () => {
      const seen = seenOf(realIndex);
      const dst = joinAppPath(dir, "index.copy");
      await copy(realIndex, seen, dst);
      expect(readFileSync(dst, "utf8")).toBe("real\n");
      expect(statSync(dst).mtimeMs).toBe(1_700_000_000_000);
    });

    test("never overwrites an existing file", async () => {
      const dst = joinAppPath(dir, "index.copy");
      writeFileSync(dst, "other\n");
      expect(copy(realIndex, seenOf(realIndex), dst)).rejects.toThrow();
    });
  });
}

for (const [form, publish] of Object.entries(publishes)) {
  describe(`publish (${form})`, () => {
    let refreshed: AppPath;
    let seen: SeenIndex;

    beforeEach(() => {
      seen = seenOf(realIndex);
      refreshed = joinAppPath(dir, "index.refreshed");
      writeFileSync(refreshed, "refreshed\n");
    });

    test("swaps the refreshed copy in and releases the lock", async () => {
      expect(await publish(realIndex, refreshed, seen)).toBe("published");
      expect(readFileSync(realIndex, "utf8")).toBe("refreshed\n");
      expect(existsSync(`${realIndex}.lock`)).toBe(false);
    });

    test("a git writer holding index.lock keeps the real index untouched", async () => {
      writeFileSync(`${realIndex}.lock`, "");
      expect(await publish(realIndex, refreshed, seen)).toBe("index-busy");
      expect(readFileSync(realIndex, "utf8")).toBe("real\n");
      // The writer's lock is its own: never removed.
      expect(existsSync(`${realIndex}.lock`)).toBe(true);
    });

    test("an index written since the copy is not replaced", async () => {
      writeFileSync(realIndex, "written by git\n");
      expect(await publish(realIndex, refreshed, seen)).toBe("index-changed");
      expect(readFileSync(realIndex, "utf8")).toBe("written by git\n");
      expect(existsSync(`${realIndex}.lock`)).toBe(false);
    });
  });
}
