// The browse surface's reads over the memory provider — what a browser host
// (the in-browser demo) answers the file explorer's App data place with.

import { expect, test } from "bun:test";
import { withHostServices } from "@plugins/framework/plugins/server-core/core/testing";
import {
  DataFiles,
  browsableFileRevision,
  defineFileRoot,
  readBrowsableFile,
  watchBrowsableFile,
} from "@plugins/infra/plugins/paths/plugins/data-files/server";
import { relPath } from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { systemOrigin } from "@plugins/infra/plugins/request-origin/core";
import { createMemoryDataFiles } from "./memory-store";

const w = { writer: systemOrigin("browse test") };

const browsed = defineFileRoot({
  id: "test.browse",
  dir: "apps/browse-test",
  watch: { name: "browse-test.tree", description: "Test root." },
  browse: { label: "Browse test" },
});

const hidden = defineFileRoot({
  id: "test.browse-hidden",
  dir: "apps/browse-hidden-test",
  watch: { name: "browse-hidden-test.tree", description: "Test root." },
});

function withStore<T>(fn: () => Promise<T>): Promise<T> {
  return withHostServices([DataFiles.provide(createMemoryDataFiles())], fn);
}

test("a browsable root's file reads by root id and path, every miss typed", () =>
  withStore(async () => {
    await browsed.write(relPath("a", "b.txt"), "hello", w);
    const read = await readBrowsableFile("test.browse", "a/b.txt", 1024);
    if (read.kind !== "file") throw new Error(`read ${read.kind}`);
    expect(new TextDecoder().decode(read.bytes)).toBe("hello");

    expect((await readBrowsableFile("test.browse", "a/nope", 1024)).kind).toBe(
      "missing",
    );
    expect((await readBrowsableFile("test.browse", "a", 1024)).kind).toBe(
      "not-a-file",
    );
    expect((await readBrowsableFile("test.browse", "", 1024)).kind).toBe(
      "not-a-file",
    );
    expect((await readBrowsableFile("test.browse", "../x", 1024)).kind).toBe(
      "invalid-path",
    );
    expect((await readBrowsableFile("test.browse", "a/b.txt", 2)).kind).toBe(
      "too-large",
    );
    expect((await readBrowsableFile("no.such", "a/b.txt", 1024)).kind).toBe(
      "unknown-root",
    );
  }));

test("a root not declared browse is not reachable through the surface", () =>
  withStore(async () => {
    await hidden.write(relPath("x.txt"), "secret", w);
    expect(
      (await readBrowsableFile("test.browse-hidden", "x.txt", 1024)).kind,
    ).toBe("unknown-root");
  }));

test("a write under, at or above a watched path notifies it; elsewhere does not", () =>
  withStore(async () => {
    const heard: string[] = [];
    const stopDir = await watchBrowsableFile("test.browse", "a", () =>
      heard.push("a"),
    );
    const stopOther = await watchBrowsableFile("test.browse", "z", () =>
      heard.push("z"),
    );
    await browsed.write(relPath("a", "c.txt"), "c", w);
    // The memory provider batches one microtask's mutations into one change.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(heard).toEqual(["a"]);
    stopDir();
    stopOther();
  }));

test("the revision moves with the file", () =>
  withStore(async () => {
    await browsed.write(relPath("r.txt"), "1", w);
    const before = await browsableFileRevision("test.browse", "r.txt");
    await browsed.write(relPath("r.txt"), "22", w);
    expect(await browsableFileRevision("test.browse", "r.txt")).not.toBe(
      before,
    );
    expect(await browsableFileRevision("test.browse", "gone.txt")).toBe(
      "missing",
    );
    expect(await browsableFileRevision("test.browse", "..")).toBe("invalid");
  }));

test("browse without watch is refused", () => {
  expect(() =>
    // @ts-expect-error — `browse` needs `watch` (BrowseNeedsWatch)
    defineFileRoot({
      id: "test.browse-unwatched",
      dir: "apps/x",
      browse: { label: "X" },
    }),
  ).toThrow(/without `watch`/);
});
