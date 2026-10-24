import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRASH_DIR_NAME, adoptLegacyTrash } from "./legacy-trash";
import { openStatusStore } from "./status";

// The old trash's adoption against a throwaway prototypes tree.

const ID = "proto-1789000000-abcd";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "prototype-legacy-trash-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function trashed(name: string): Promise<string> {
  const dir = join(root, TRASH_DIR_NAME, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.html"), "<title>X</title>");
  return dir;
}

describe("adoptLegacyTrash", () => {
  test("no _trash/ is nothing to do", async () => {
    await adoptLegacyTrash(root);
    expect(existsSync(join(root, TRASH_DIR_NAME))).toBe(false);
  });

  test("a trashed folder comes back, recorded deleted at its ctime", async () => {
    const dir = await trashed(ID);
    const { ctime } = await stat(dir);
    await adoptLegacyTrash(root);
    expect(existsSync(join(root, ID, "index.html"))).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect((await openStatusStore(root).read(ID)).deletedAt).toBe(
      ctime.toISOString(),
    );
  });

  test("a hand-made folder name stays in the old trash", async () => {
    const dir = await trashed("my-mock");
    await adoptLegacyTrash(root);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(root, "my-mock"))).toBe(false);
  });

  test("a live folder under the same id throws and moves nothing", async () => {
    const dir = await trashed(ID);
    await mkdir(join(root, ID));
    let message = "";
    try {
      await adoptLegacyTrash(root);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("both in the old trash");
    expect(existsSync(dir)).toBe(true);
  });
});
