import { describe, expect, test } from "bun:test";
import {
  parseRelPath,
  relPath,
  type Mount,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { createMemoryDataFiles } from "@plugins/infra/plugins/paths/plugins/data-files/plugins/memory/server/testing";
import { systemOrigin } from "@plugins/infra/plugins/request-origin/core";
import { listPrototypeMetas } from "../../shared/list-metas";
import { PrototypeRecords } from "./records";

// The server's per-folder records: a list composes every meta from them and
// reads only the folders that moved since the last list, and answers exactly
// what a whole read of the tree does.

const A = "proto-1790000000-aaaa";
const B = "proto-1790000001-bbbb";
const C = "proto-1790000002-cccc";
const writer = systemOrigin("records test");

/** A memory tree, and the files read from it (by path) since the last `take`. */
function tree() {
  const root = createMemoryDataFiles().root({
    id: "prototypes.records-test",
    dir: "apps/records-test",
  });
  const reads: string[] = [];
  const mount: Mount = {
    ...root,
    list: (dir) => root.list(dir),
    stat: (path) => root.stat(path),
    read: (path) => {
      reads.push(path);
      return root.read(path);
    },
  };
  return {
    mount,
    write: (path: string, text: string) =>
      root.write(parseRelPath(path), text, { writer }),
    remove: (name: string) =>
      root.remove(relPath(name), { writer, recursive: true }),
    take: () => reads.splice(0).sort(),
  };
}

async function seeded() {
  const t = tree();
  await t.write(`${A}/index.html`, "<title>A</title>");
  await t.write(`${A}/app.js`, "const a = 1;");
  await t.write(`${B}/index.html`, `<title>B</title><a href="${C}/x">c</a>`);
  const records = new PrototypeRecords(t.mount);
  await records.refresh("all");
  return { ...t, records };
}

/** The records' list, checked against a whole read of the tree. */
async function list(t: Awaited<ReturnType<typeof seeded>>) {
  const metas = await t.records.list();
  const reads = t.take();
  expect(metas).toEqual(await listPrototypeMetas(t.mount));
  t.take();
  return { metas, reads };
}

describe("PrototypeRecords", () => {
  test("a list before the first refresh of the tree waits for it", async () => {
    const t = tree();
    await t.write(`${A}/index.html`, "<title>A</title>");
    const records = new PrototypeRecords(t.mount);
    const early = records.list();
    await records.refresh("all");
    expect((await early).map((m) => m.title)).toEqual(["A"]);
  });

  test("a list waiting on a first refresh that failed fails", async () => {
    const t = tree();
    const broken: Mount = {
      ...t.mount,
      list: () => Promise.reject(new Error("disk gone")),
    };
    const records = new PrototypeRecords(broken);
    const early = records.list();
    const refreshing = records.refresh("all");
    await Promise.allSettled([refreshing, early]);
    expect(refreshing).rejects.toThrow("disk gone");
    expect(early).rejects.toThrow(/first load failed/);
  });

  test("the baseline reads no bytes; the first list reads every folder once", async () => {
    const t = await seeded();
    expect(t.take()).toEqual([]);
    const { reads } = await list(t);
    expect(reads).toEqual([
      `${A}/app.js`,
      `${A}/index.html`,
      `${B}/index.html`,
    ]);
    expect((await list(t)).reads).toEqual([]);
  });

  test("an edit re-reads that folder alone", async () => {
    const t = await seeded();
    await list(t);
    await t.write(`${A}/index.html`, "<title>Renamed A</title>");
    expect(await t.records.refresh(new Set([A]))).toEqual({
      moved: [A],
      listChanged: true,
    });
    const { metas, reads } = await list(t);
    expect(reads).toEqual([`${A}/app.js`, `${A}/index.html`]);
    expect(metas.find((m) => m.name === A)?.title).toBe("Renamed A");
  });

  test("a folder whose listing did not move is not a change", async () => {
    const t = await seeded();
    expect(await t.records.refresh(new Set([A, "_template", "nope"]))).toEqual({
      moved: [],
      listChanged: false,
    });
  });

  test("a sibling appearing is judged from the tokens, re-reading no other folder", async () => {
    const t = await seeded();
    const before = await list(t);
    expect(before.metas.find((m) => m.name === B)?.problems).toEqual([]);
    await t.write(`${C}/index.html`, "<title>C</title>");
    expect(await t.records.refresh(new Set([C]))).toEqual({
      moved: [C],
      listChanged: true,
    });
    const { metas, reads } = await list(t);
    expect(reads).toEqual([`${C}/index.html`]);
    expect(metas.find((m) => m.name === B)?.problems).toEqual([
      {
        path: "index.html",
        detail: `references another prototype's folder, ${C}`,
      },
    ]);
  });

  test("a removed folder leaves the list", async () => {
    const t = await seeded();
    await list(t);
    await t.remove(A);
    expect(await t.records.refresh(new Set([A]))).toEqual({
      moved: [A],
      listChanged: true,
    });
    expect((await list(t)).metas.map((m) => m.name)).toEqual([B]);
  });

  test("a new subdir changes the list, though no file the rev hashes moved", async () => {
    const t = await seeded();
    await list(t);
    await t.write(`${A}/assets/x.svg`, "<svg/>");
    expect(await t.records.refresh(new Set([A]))).toEqual({
      moved: [],
      listChanged: true,
    });
    const { metas } = await list(t);
    expect(
      metas.find((m) => m.name === A)?.problems.map((p) => p.path),
    ).toEqual(["assets/"]);
  });

  test("a rescan names what moved since, and keeps the unmoved folders' reads", async () => {
    const t = await seeded();
    await list(t);
    await t.write(`${B}/index.html`, "<title>B two</title>");
    await t.write(`${C}/index.html`, "<title>C</title>");
    const refresh = await t.records.refresh("all");
    expect(refresh.moved.sort()).toEqual([B, C]);
    expect(refresh.listChanged).toBe(true);
    expect((await list(t)).reads).toEqual([
      `${B}/index.html`,
      `${C}/index.html`,
    ]);
  });
});
