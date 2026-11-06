import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { repoSnapshotOver } from "@plugins/framework/plugins/tooling/core";
import { hostSnapshotDirName } from "./host-snapshots";

// The snapshot's address moves with everything its script loads — a module
// only the Bun-side script reaches included, which no worker artifact carries.

const HOST = "apps/plugins/demo-host";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A tree of `files` on disk, as the build's snapshot reads it. */
function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "host-snapshot-"));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return repoSnapshotOver(asAppPath(root), Object.keys(files).sort(), (p) =>
    createHash("sha1")
      .update(readFileSync(join(root, p)))
      .digest("hex"),
  );
}

const BASE: Record<string, string> = {
  "bun.lock": "lock",
  [`plugins/${HOST}/bin/browser-host.snapshot.ts`]: [
    `import { seed } from "./seed";`,
    `import { helper } from "@plugins/packages/plugins/string-hash/core";`,
    `import "zod";`,
    `const later = () => import("@plugins/packages/plugins/semaphore/server");`,
  ].join("\n"),
  [`plugins/${HOST}/bin/seed.ts`]: `export const seed = 1;`,
  "plugins/packages/plugins/string-hash/core/index.ts": `export { helper } from "./internal/helper";`,
  "plugins/packages/plugins/string-hash/core/internal/helper.ts": `export const helper = 1;`,
  "plugins/packages/plugins/semaphore/server/index.ts": `export default {};`,
};

const address = (files: Record<string, string>) =>
  hostSnapshotDirName({
    repo: tree(files),
    pluginPath: HOST,
    closure: [],
    identityHash: "identity",
  });

describe("a host snapshot's address", () => {
  test("moves when a module only the script reaches changes", async () => {
    const before = await address(BASE);
    expect(await address(BASE)).toBe(before);
    expect(
      await address({
        ...BASE,
        "plugins/packages/plugins/string-hash/core/internal/helper.ts": `export const helper = 2;`,
      }),
    ).not.toBe(before);
  });

  test("does not follow a dynamic import (the worker's artifacts carry it)", async () => {
    const before = await address(BASE);
    expect(
      await address({
        ...BASE,
        "plugins/packages/plugins/semaphore/server/index.ts": `export default { changed: true };`,
      }),
    ).toBe(before);
  });

  test("refuses a repo import that resolves to no file", async () => {
    const files = { ...BASE };
    delete files["plugins/packages/plugins/string-hash/core/index.ts"];
    expect(address(files)).rejects.toThrow(
      /imports "@plugins\/packages\/plugins\/string-hash\/core", which resolves to no file/,
    );
  });
});
