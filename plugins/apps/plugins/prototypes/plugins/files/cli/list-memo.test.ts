import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskDirMount } from "@plugins/infra/plugins/paths/plugins/data-files/machine";
import { PrototypeMetaMemo, listPrototypeMetas } from "../shared/list-metas";

// The lister's per-folder memo: a listing re-reads only the folders whose
// files, subdirs or siblings moved, and answers exactly what a fresh read does.

const A = "proto-1790000000-aaaa";
const B = "proto-1790000001-bbbb";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "proto-memo-"));
  for (const name of [A, B]) {
    await mkdir(join(dir, name));
    await writeFile(join(dir, name, "index.html"), `<title>${name}</title>`);
  }
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function list(memo: PrototypeMetaMemo) {
  const mount = diskDirMount(dir);
  const memoized = await listPrototypeMetas(mount, memo);
  expect(memoized).toEqual(await listPrototypeMetas(mount));
  return memoized;
}

describe("listPrototypeMetas with a PrototypeMetaMemo", () => {
  test("an unmoved folder's meta is reused, an edited one re-read", async () => {
    const memo = new PrototypeMetaMemo();
    const [a1, b1] = await list(memo);
    await writeFile(join(dir, A, "index.html"), "<title>Renamed</title>");
    const [a2, b2] = await list(memo);
    expect(a2?.title).toBe("Renamed");
    expect(a2?.rev).not.toBe(a1?.rev);
    expect(b2).toBe(b1);
  });

  test("an edit that keeps the size still moves the mtime", async () => {
    const memo = new PrototypeMetaMemo();
    await list(memo);
    const file = join(dir, A, "index.html");
    await writeFile(file, `<title>${B}</title>`);
    await utimes(file, new Date(), new Date(Date.now() + 5_000));
    const [a] = await list(memo);
    expect(a?.title).toBe(B);
  });

  test("a new subdir is a problem, though the signature skips it", async () => {
    const memo = new PrototypeMetaMemo();
    await list(memo);
    await mkdir(join(dir, A, "assets"));
    const [a] = await list(memo);
    expect(a?.problems.map((p) => p.path)).toContain("assets/");
  });

  test("a new sibling re-validates every folder against it", async () => {
    const memo = new PrototypeMetaMemo();
    const C = "proto-1790000002-cccc";
    await writeFile(join(dir, A, "app.js"), `fetch("${C}/x.json")`);
    const [a1] = await list(memo);
    expect(a1?.problems).toEqual([]);
    await mkdir(join(dir, C));
    await writeFile(join(dir, C, "index.html"), "<title>C</title>");
    const [a2] = await list(memo);
    expect(a2?.problems.map((p) => p.detail)).toEqual([
      `references another prototype's folder (\`${C}/\`)`,
    ]);
  });

  test("a removed folder leaves the listing", async () => {
    const memo = new PrototypeMetaMemo();
    await list(memo);
    await rm(join(dir, B), { recursive: true });
    expect((await list(memo)).map((m) => m.name)).toEqual([A]);
  });
});
