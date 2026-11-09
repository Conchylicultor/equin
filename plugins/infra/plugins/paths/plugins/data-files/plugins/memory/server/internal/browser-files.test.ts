// The browser's file system over the memory provider — what a browser host
// (the in-browser demo) answers file-systems' `browser` reads with: the
// host's storage laid out like a home folder, each file root at its data dir
// under the hidden data folder the desktop keeps them in.

import { expect, test } from "bun:test";
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
  browserFileBytesServed,
  browserFileStatServed,
  browserFileTextServed,
  handleBrowserFileRaw,
} from "./browser-files";

const w = { writer: systemOrigin("browser files test") };

const watched = defineFileRoot({
  id: "test.browser-files",
  dir: "apps/browser-files-test",
  watch: { name: "browser-files-test.tree", description: "Test root." },
});

// No `watch`, no `browse`: still a folder of the browser's file system.
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

test("a root declared without watch or browse is a folder like any other", () =>
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
    expect(
      browserFileStatServed.load({ path: "~/Documents" }),
    ).rejects.toMatchObject({ code: "missing" });
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
