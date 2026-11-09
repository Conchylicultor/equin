// The browser's file system over the memory provider — what a browser host
// (the in-browser demo) answers file-systems' `browser` reads with: the
// host's storage laid out like a home folder, each file root at its data dir
// under the hidden data folder the desktop keeps them in.

import { expect, test } from "bun:test";
import { declareMemoryHostStorage } from "@plugins/framework/plugins/browser-server/plugins/host-storage/core/testing";
import { withHostServices } from "@plugins/framework/plugins/server-core/core/testing";
import {
  DataFiles,
  defineFileRoot,
} from "@plugins/infra/plugins/paths/plugins/data-files/server";
import { relPath } from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { systemOrigin } from "@plugins/infra/plugins/request-origin/core";
import { createMemoryDataFiles } from "./memory-store";
import { DATA_FOLDER } from "./home-layout";
import {
  browserDirPeekServed,
  browserFileBytesServed,
  browserListingMeta,
  browserListingPage,
  browserFileStatServed,
  browserFileTextServed,
  handleBrowserFileRaw,
  moveBrowserFiles,
  writeBrowserHomeFiles,
} from "./browser-files";

const w = { writer: systemOrigin("browser files test") };

// The home's tree is the host's own store, kept in its declared storage.
declareMemoryHostStorage();

const watched = defineFileRoot({
  id: "test.browser-files",
  dir: "apps/browser-files-test",
  watch: { name: "browser-files-test.tree", description: "Test root." },
});

// No `watch`: still a folder of the browser's file system.
const cache = defineFileRoot({
  id: "test.browser-files-cache",
  dir: "cache/browser-files-test",
});

const DATA = `~/${DATA_FOLDER}`;
const AT = `${DATA}/apps/browser-files-test`;

function withStore<T>(fn: () => Promise<T>): Promise<T> {
  return withHostServices([DataFiles.provide(createMemoryDataFiles())], fn);
}

test("a root's file reads at its data dir under the hidden data folder, every miss refused by code", () =>
  withStore(async () => {
    await watched.write(relPath("a", "b.txt"), "hello", w);
    const text = await browserFileTextServed.load({ path: `${AT}/a/b.txt` });
    expect(text).toEqual({ content: "hello", size: 5 });
    const bytes = await browserFileBytesServed.load({ path: `${AT}/a/b.txt` });
    expect(new TextDecoder().decode(bytes)).toBe("hello");

    expect(
      browserFileTextServed.load({ path: `${AT}/a/nope` }),
    ).rejects.toMatchObject({ code: "missing" });
    expect(
      browserFileTextServed.load({ path: `${AT}/a` }),
    ).rejects.toMatchObject({ code: "not-a-file" });
    expect(
      browserFileTextServed.load({ path: `${AT}/../x` }),
    ).rejects.toMatchObject({ code: "invalid-path" });
    expect(
      browserFileTextServed.load({ path: `${DATA}/apps/no-such/x` }),
    ).rejects.toMatchObject({ code: "missing" });
  }));

test("a root declared without watch is a folder like any other", () =>
  withStore(async () => {
    await cache.write(relPath("x.txt"), "cached", w);
    const text = await browserFileTextServed.load({
      path: `${DATA}/cache/browser-files-test/x.txt`,
    });
    expect(text.content).toBe("cached");
  }));

test("the folders above the roots are implied by the roots there are", () =>
  withStore(async () => {
    for (const path of ["~", DATA, `${DATA}/apps`, AT]) {
      const stat = await browserFileStatServed.load({ path });
      expect(stat.entry.kind).toBe("dir");
    }
    expect(
      (await browserFileStatServed.load({ path: DATA })).entry.hidden,
    ).toBe(true);
    expect(
      browserFileStatServed.load({ path: `${DATA}/nothing-here` }),
    ).rejects.toMatchObject({ code: "missing" });
    // The home's own tree holds nothing until something is written there.
    expect(
      browserFileStatServed.load({ path: "~/Documents" }),
    ).rejects.toMatchObject({ code: "missing" });
    expect(await browserFileStatServed.load({ path: "~" })).toMatchObject({
      path: "~",
      parent: null,
    });
  }));

test("the home's own tree sits beside the hidden data folder", () =>
  withStore(async () => {
    await writeBrowserHomeFiles(
      { "~/Documents/notes.md": "# Notes", "~/todo.txt": "milk" },
      w.writer,
    );
    const range = { after: null, until: null, limit: 500 } as const;
    const names = async (path: string) =>
      (await browserListingPage({ path }, range)).map((e) => e.name);
    expect(await names("~")).toEqual([DATA_FOLDER, "Documents", "todo.txt"]);
    expect(await names("~/Documents")).toEqual(["notes.md"]);
    expect(await browserListingMeta({ path: "~/Documents" })).toEqual({
      path: "~/Documents",
      parent: "~",
      total: 1,
    });
    const stat = await browserFileStatServed.load({
      path: "~/Documents/notes.md",
    });
    expect(stat).toMatchObject({
      path: "~/Documents/notes.md",
      parent: "~/Documents",
      entry: { kind: "file", size: 7 },
    });
    expect((await browserDirPeekServed.load({ path: "~" })).kind).toBe("ok");
    expect(
      browserListingPage({ path: "~/todo.txt" }, range),
    ).rejects.toMatchObject({ code: "not-a-dir" });
    expect(
      writeBrowserHomeFiles({ [`${AT}/x`]: "no" }, w.writer),
    ).rejects.toThrow(/home's own tree/);
  }));

test("a move inside the home is the Finder's; the apps' folders are kept", () =>
  withStore(async () => {
    const range = { after: null, until: null, limit: 500 } as const;
    await writeBrowserHomeFiles(
      {
        "~/a.txt": "a",
        "~/Archive/a.txt": "old",
        "~/Archive/sub/b.txt": "b",
      },
      w.writer,
    );
    const taken = await moveBrowserFiles(
      ["~/a.txt"],
      "~/Archive",
      {},
      w.writer,
    );
    expect(taken).toEqual({
      kind: "ok",
      destDir: "~/Archive",
      results: [{ kind: "exists", from: "~/a.txt", to: "~/Archive/a.txt" }],
    });
    const both = await moveBrowserFiles(
      ["~/a.txt"],
      "~/Archive",
      { "~/a.txt": "keep-both" },
      w.writer,
    );
    expect(both.kind === "ok" && both.results[0]).toEqual({
      kind: "moved",
      from: "~/a.txt",
      to: "~/Archive/a 2.txt",
    });
    const self = await moveBrowserFiles(
      ["~/Archive"],
      "~/Archive/sub",
      {},
      w.writer,
    );
    expect(self.kind === "ok" && self.results[0]?.kind).toBe("into-self");
    // Replace sets the taken entry aside until the source is in place.
    await writeBrowserHomeFiles({ "~/b.txt": "new" }, w.writer);
    const replaced = await moveBrowserFiles(
      ["~/../x", "~/b.txt"],
      "~/Archive/sub",
      { "~/b.txt": "replace" },
      w.writer,
    );
    expect(
      replaced.kind === "ok" && replaced.results.map((r) => r.kind),
    ).toEqual(["missing", "moved"]);
    await writeBrowserHomeFiles({ "~/b.txt": "newer" }, w.writer);
    const again = await moveBrowserFiles(
      ["~/b.txt"],
      "~/Archive/sub",
      { "~/b.txt": "replace" },
      w.writer,
    );
    expect(again.kind === "ok" && again.results[0]?.kind).toBe("moved");
    const text = await browserFileTextServed.load({
      path: "~/Archive/sub/b.txt",
    });
    expect(text.content).toBe("newer");
    expect(
      (await browserListingPage({ path: "~/Archive/sub" }, range)).map(
        (e) => e.name,
      ),
    ).toEqual(["b.txt"]);
    expect(
      await moveBrowserFiles(["~/Archive/a.txt"], AT, {}, w.writer),
    ).toEqual({ kind: "archive", path: AT });
    await watched.write(relPath("kept.txt"), "app", w);
    const app = await moveBrowserFiles(
      [`${AT}/kept.txt`],
      "~/Archive",
      {},
      w.writer,
    );
    expect(app.kind === "ok" && app.results[0]?.kind).toBe("archive");
  }));

test("a binary file has no text", () =>
  withStore(async () => {
    await watched.write(relPath("bin"), new Uint8Array([1, 0, 2]), w);
    expect(
      browserFileTextServed.load({ path: `${AT}/bin` }),
    ).rejects.toMatchObject({ code: "binary" });
  }));

test("the raw route serves a file inert, typed by its extension", () =>
  withStore(async () => {
    await watched.write(relPath("doc.pdf"), "%PDF-1.4", w);
    const pdf = await handleBrowserFileRaw(
      new Request(
        `http://x/api/files/browser/raw?path=${encodeURIComponent(`${AT}/doc.pdf`)}`,
      ),
    );
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    // A PDF's viewer refuses a sandboxed document; every other file is sandboxed.
    expect(pdf.headers.get("content-security-policy")).toBeNull();
    expect(await pdf.text()).toBe("%PDF-1.4");

    await watched.write(relPath("tune.wav"), "RIFF", w);
    const wav = await handleBrowserFileRaw(
      new Request(
        `http://x/api/files/browser/raw?path=${encodeURIComponent(`${AT}/tune.wav`)}`,
      ),
    );
    expect(wav.headers.get("content-type")).toBe("audio/wav");
    expect(wav.headers.get("content-security-policy")).toBe("sandbox");

    const gone = await handleBrowserFileRaw(
      new Request(
        `http://x/api/files/browser/raw?path=${encodeURIComponent(`${AT}/gone`)}`,
      ),
    );
    expect(gone.status).toBe(404);
  }));

test("a root's location is its data dir under the browser's hidden data folder", () => {
  expect(createMemoryDataFiles().location(watched.spec)).toEqual({
    fs: "browser",
    path: AT,
  });
});
