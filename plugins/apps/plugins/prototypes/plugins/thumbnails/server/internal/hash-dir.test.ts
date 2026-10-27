import { describe, expect, test } from "bun:test";
import {
  parseRelPath,
  relPath,
  type FileData,
  type Mount,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { createMemoryDataFiles } from "@plugins/infra/plugins/paths/plugins/data-files/plugins/memory/server/testing";
import { systemOrigin } from "@plugins/infra/plugins/request-origin/core";
import { fingerprintFolder } from "./hash-dir";

const writer = systemOrigin("fingerprint test");

// A fresh memory root per call — the same Mount a browser host reads, and the
// same operations the desktop's disk root answers.
function freshMount(): Mount {
  return createMemoryDataFiles().root({
    id: "thumbnails.fingerprint-test",
    dir: "cache/fingerprint-test",
  });
}

async function makeDir(
  mount: Mount,
  name: string,
  files: Record<string, FileData>,
): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    await mount.write(parseRelPath(`${name}/${file}`), content, { writer });
  }
}

async function keyOf(mount: Mount, name: string): Promise<string> {
  const fingerprint = await fingerprintFolder(mount, relPath(name));
  if (fingerprint.kind !== "hashed") throw new Error(`${name} is missing`);
  return fingerprint.key;
}

describe("fingerprintFolder", () => {
  test("the digest is the one every cached PNG is named by", async () => {
    // Pinned: `createHash("sha256")` (node:crypto) over name, NUL, bytes, NUL
    // per file in sorted order — the stream the cache keys were made from
    // before the fingerprint ran on every host. A change here re-renders (and
    // orphans) every cached thumbnail.
    const mount = freshMount();
    await makeDir(mount, "p", {
      "index.html": "<h1>hi</h1>",
      "logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]),
      "app.js": "x",
    });

    expect(await keyOf(mount, "p")).toBe(
      "d2dc2895b1f13754514339d1971dcb3e8c3b139e58449288b60ed5dbab092e1c",
    );
  });

  test("identical content hashes identically across folders", async () => {
    const mount = freshMount();
    await makeDir(mount, "a", { "index.html": "<h1>hi</h1>", "app.js": "x" });
    await makeDir(mount, "b", { "app.js": "x", "index.html": "<h1>hi</h1>" });

    expect(await keyOf(mount, "a")).toBe(await keyOf(mount, "b"));
  });

  test("a byte change changes the hash", async () => {
    const mount = freshMount();
    await makeDir(mount, "p", { "index.html": "<h1>hi</h1>" });
    const before = await keyOf(mount, "p");

    await makeDir(mount, "p", { "index.html": "<h1>hi!</h1>" });

    expect(await keyOf(mount, "p")).not.toBe(before);
  });

  test("a rewrite that changes no bytes does not change the hash", async () => {
    const mount = freshMount();
    await makeDir(mount, "p", { "index.html": "<h1>hi</h1>" });
    const before = await keyOf(mount, "p");

    // A newer mtime, the same bytes — what a `git checkout` does.
    await makeDir(mount, "p", { "index.html": "<h1>hi</h1>" });

    expect(await keyOf(mount, "p")).toBe(before);
  });

  test("moving content between files changes the hash", async () => {
    const mount = freshMount();
    await makeDir(mount, "a", { "one.js": "alpha", "two.js": "beta" });
    await makeDir(mount, "b", { "one.js": "beta", "two.js": "alpha" });

    expect(await keyOf(mount, "a")).not.toBe(await keyOf(mount, "b"));
  });

  test("subdirectories are skipped, not hashed as empty names", async () => {
    const mount = freshMount();
    await makeDir(mount, "p", { "index.html": "<h1>hi</h1>" });
    const before = await keyOf(mount, "p");

    await makeDir(mount, "p", { "nested/deep.txt": "x" });

    expect(await keyOf(mount, "p")).toBe(before);
  });

  test("a folder that is not there is missing, not an empty hash", async () => {
    expect(await fingerprintFolder(freshMount(), relPath("gone"))).toEqual({
      kind: "missing",
    });
  });
});
