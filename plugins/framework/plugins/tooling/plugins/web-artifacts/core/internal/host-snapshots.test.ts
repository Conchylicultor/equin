import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { repoSnapshotOver } from "@plugins/framework/plugins/tooling/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { CLUSTER_SCRIPT_FILES, hostSnapshotDirName } from "./host-snapshots";
import type { PlannedTarget } from "./plan";

// The snapshot's address covers everything that can change its bytes: every
// module the take can run (the script's graph, dynamic edges included — the
// server graph the generated listing loads), the data it reads off disk, the
// npm resolutions. A module the take cannot load does not move it.

const HOST = "apps/plugins/demo-host";
const MIGRATION = "plugins/database/plugins/migrations/data/0001_init.sql";
const CODEC =
  "plugins/framework/plugins/browser-server/plugins/host-storage/core/internal/snapshot.ts";
// A server module the seed boots, reached only through the generated
// listing's `import()` — the script never imports it.
// The module graph keys its file facts by the scan's own code: the tree needs it.
const SCAN =
  "plugins/plugin-meta/plugins/plugin-records/core/internal/scan-imports.ts";
const WARMUP = "plugins/ui/plugins/icons/server/warm-up.ts";

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

const LOCK = [
  "{",
  '  "lockfileVersion": 1,',
  '  "workspaces": {',
  '    "plugins/a": {',
  '      "name": "@equin/plugin-a",',
  "    },",
  "  },",
  '  "packages": {',
  '    "@equin/plugin-a": ["@equin/plugin-a@workspace:plugins/a"],',
  '    "@electric-sql/pglite": ["@electric-sql/pglite@0.5.11", "", {}, "sha512-x"],',
  "  }",
  "}",
].join("\n");

const BASE: Record<string, string> = {
  "bun.lock": LOCK,
  [`plugins/${HOST}/bin/browser-host.snapshot.ts`]: [
    `import { seed } from "./seed";`,
    `import { hostEntries } from "./browser-host.generated";`,
    `import { decode } from "@plugins/framework/plugins/browser-server/plugins/host-storage/core";`,
  ].join("\n"),
  [`plugins/${HOST}/bin/seed.ts`]: `export const seed = 1;`,
  [`plugins/${HOST}/bin/browser-host.generated.ts`]: `export const hostEntries = [{ loader: () => import("@plugins/ui/plugins/icons/server") }];`,
  [`plugins/${HOST}/bin/seed.test.ts`]: `test("seed", () => {});`,
  [`plugins/${HOST}/CLAUDE.md`]: `# demo host`,
  [`plugins/${HOST}/data/page.md.txt`]: `page`,
  [`plugins/${HOST}/web/index.ts`]: `export default {};`,
  [`plugins/${HOST}/plugins/child/core/index.ts`]: `export const child = 1;`,
  [MIGRATION]: `-- migration 1`,
  "plugins/ui/plugins/icons/server/index.ts": `import "./warm-up";\nexport default {};`,
  [WARMUP]: `export const drawn = 1;`,
  "plugins/tasks/server/index.ts": `export default {};`,
  "plugins/framework/plugins/browser-server/plugins/host-storage/core/index.ts": `export { decode } from "./internal/snapshot";`,
  [CODEC]: `export const decode = 1;`,
  [`plugins/${HOST}/data/notes/readme.md`]: `# a prototype's readme`,
  "patches/pkg@1.0.0.patch": `--- a\n+++ b\n`,
  [`plugins/${HOST}/data/proto/app.ts`]: `export const proto = 1;`,
  [SCAN]: readFileSync(join(REPO_ROOT, SCAN), "utf8"),
  // The code the address reads by fixed path, from the list it reads: a file
  // it starts covering joins the tree with it.
  ...Object.fromEntries(
    CLUSTER_SCRIPT_FILES.map((f) => [
      f,
      readFileSync(join(REPO_ROOT, f), "utf8"),
    ]),
  ),
};

/** A worker closure of one artifact that inlines the migration history. */
const closureOf = (root: string) =>
  [{ globFiles: [join(root, MIGRATION)] }] as unknown as PlannedTarget[];

const address = (files: Record<string, string>) => {
  const repo = tree(files);
  return hostSnapshotDirName({
    repo,
    pluginPath: HOST,
    closure: closureOf(repo.root),
  });
};

const edited = (rel: string, text: string) => ({ ...BASE, [rel]: text });

describe("a host snapshot's address", () => {
  test("is stable for the same data", async () => {
    expect(await address(BASE)).toBe(await address(BASE));
  });

  test("moves with the bundled data (a migration)", async () => {
    expect(await address(edited(MIGRATION, `-- migration 1, edited`))).not.toBe(
      await address(BASE),
    );
  });

  test("moves with the seed's own files", async () => {
    const before = await address(BASE);
    expect(
      await address(
        edited(`plugins/${HOST}/bin/seed.ts`, `export const seed = 2;`),
      ),
    ).not.toBe(before);
    expect(
      await address(edited(`plugins/${HOST}/data/page.md.txt`, `other page`)),
    ).not.toBe(before);
    expect(
      await address(
        edited(`plugins/${HOST}/data/notes/readme.md`, `# another readme`),
      ),
    ).not.toBe(before);
  });

  test("moves with the snapshot file's codec", async () => {
    expect(await address(edited(CODEC, `export const decode = 2;`))).not.toBe(
      await address(BASE),
    );
  });

  test("moves with a server module the seed boots but the script does not import", async () => {
    // The icon warm-up case (task-1793979789-wtzxz9): reached only through
    // the generated listing's dynamic `import()`.
    expect(await address(edited(WARMUP, `export const drawn = 2;`))).not.toBe(
      await address(BASE),
    );
  });

  test("moves with any file of data/, a module-looking one included", async () => {
    expect(
      await address(
        edited(`plugins/${HOST}/data/proto/app.ts`, `export const proto = 2;`),
      ),
    ).not.toBe(await address(BASE));
  });

  test("moves with the code the PGlite cluster is written by", async () => {
    const before = await address(BASE);
    for (const file of CLUSTER_SCRIPT_FILES)
      expect(await address(edited(file, `${BASE[file]}\n// edited`))).not.toBe(
        before,
      );
  });

  test("moves with a patch bun applies to an npm package", async () => {
    expect(
      await address(edited("patches/pkg@1.0.0.patch", `--- a\n+++ c\n`)),
    ).not.toBe(await address(BASE));
  });

  test("refuses a take whose graph imports a module that does not exist", async () => {
    expect(
      address(edited(WARMUP, `import "./gone";\nexport const drawn = 1;`)),
    ).rejects.toThrow(/resolves to no file of the tree/);
  });

  test("moves with the generated listing (the graph that boots)", async () => {
    expect(
      await address(
        edited(
          `plugins/${HOST}/bin/browser-host.generated.ts`,
          `export const hostEntries = [{ loader: () => import("@plugins/ui/plugins/icons/server") }, { loader: () => import("@plugins/tasks/server") }];`,
        ),
      ),
    ).not.toBe(await address(BASE));
  });

  test("moves with an npm resolution, not with a workspace entry", async () => {
    const before = await address(BASE);
    expect(
      await address(edited("bun.lock", LOCK.replace("0.5.11", "0.5.12"))),
    ).not.toBe(before);
    expect(
      await address(
        edited(
          "bun.lock",
          LOCK.replace(
            '    "@electric-sql',
            '    "@equin/plugin-b": ["@equin/plugin-b@workspace:plugins/b"],\n    "@electric-sql',
          ),
        ),
      ),
    ).toBe(before);
  });

  test("ignores code the take cannot load, tests, docs and nested plugins", async () => {
    const before = await address(BASE);
    for (const [rel, text] of [
      ["plugins/tasks/server/index.ts", `export default { changed: true };`],
      [`plugins/${HOST}/web/index.ts`, `export default { changed: true };`],
      [`plugins/${HOST}/bin/seed.test.ts`, `test("other", () => {});`],
      [`plugins/${HOST}/CLAUDE.md`, `# edited`],
      [
        `plugins/${HOST}/plugins/child/core/index.ts`,
        `export const child = 2;`,
      ],
    ] as const)
      expect(await address(edited(rel, text))).toBe(before);
  });

  test("refuses a bundled file outside the tree", async () => {
    const repo = tree(BASE);
    expect(
      hostSnapshotDirName({
        repo,
        pluginPath: HOST,
        closure: [
          { globFiles: ["/elsewhere/x.sql"] },
        ] as unknown as PlannedTarget[],
      }),
    ).rejects.toThrow(/is not a file of the tree/);
  });
});
