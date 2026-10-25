/**
 * Soundness round-trip for plugin-boundaries' input-keyed read-set (Stage 3),
 * exercised the way the runner drives it: record the read-set by running
 * `recordBoundaryReadSet` under a recording `FileSystemView` over a real
 * throwaway git repo, then `validate` it against a FRESH snapshot of a mutated
 * tree.
 *
 * The cases that make the cache trustworthy:
 *   1. an unrelated non-source change (docs) is a HIT — the whole point;
 *   2. a source file's import edit (blobSha change) is a MISS (content fact);
 *   3. a BRAND-NEW source file is a MISS via the MEMBERSHIP glob (hazard H3/H9 —
 *      a content-only read-set would stale-PASS the newly-added violating file);
 *   4. a new plugin dir holding ONLY a non-.ts file is a MISS via membership too
 *      (buildPluginTree's content gate makes it a plugin → a new R1 violation);
 *   5. a package.json content change is a MISS (R1 naming + compositionRoot).
 *
 * NOTE: fixture paths are built through `pj(rel)` rather than written as bare
 * `plugins/<seg>/…` string literals — the latter would trip the repo's own
 * `plugin-refs-resolve` check, which validates that every `plugins/<seg>` path
 * literal in source resolves to a real plugin (our fixture plugins are synthetic).
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  createReadSetRepo,
  type ReadSetRepo,
} from "@plugins/framework/plugins/tooling/plugins/checks/core/testing";
import { recordBoundaryReadSet } from "./read-set";

let repo: ReadSetRepo;

/** Build a repo-relative path under the synthetic plugins/ tree. */
const pj = (rel: string): string => `plugins/${rel}`;

const write = (rel: string, content: string): void => repo.write(rel, content);

const FOO_INDEX = pj("foo/web/index.ts");
const FOO_PKG = pj("foo/package.json");
const FOO_README = pj("foo/README.md");

beforeAll(async () => {
  // A minimal plugins/ tree. foo/web/index.ts is a parsed source; package.json
  // feeds R1 naming + the compositionRoot marker; README.md is an unrelated
  // non-source file whose CONTENT never affects the verdict.
  repo = await createReadSetRepo("plugin-boundaries-read-set-", {
    [FOO_INDEX]: "export default {} as unknown;\n",
    [FOO_PKG]: JSON.stringify({ name: "@equin/plugin-foo" }) + "\n",
    [FOO_README]: "# foo\n",
    // A file OUTSIDE plugins/ — must never enter the read-set.
    "package.json": JSON.stringify({ name: "root" }) + "\n",
  });
});

afterAll(() => {
  repo?.dispose();
});

/** Record plugin-boundaries' read-set the same way run() does. */
const record = () => repo.record((view) => recordBoundaryReadSet(view));

test("records the plugins-wide membership glob + a content fact per .ts/.tsx & package.json under plugins/", async () => {
  const rs = await record();
  // (a) membership: exactly the one broad glob under plugins/.
  expect(rs.globs.map((g) => g.glob)).toEqual([pj("**")]);
  const g = rs.globs[0]!;
  expect(g.matches).toContain(FOO_INDEX);
  expect(g.matches).toContain(FOO_PKG);
  expect(g.matches).toContain(FOO_README);
  // (b) content: the source + the package.json, but NOT the README (non-source)
  // and NOT the root package.json (outside plugins/).
  const paths = rs.files.map((f) => f.path).sort();
  expect(paths).toContain(FOO_INDEX);
  expect(paths).toContain(FOO_PKG);
  expect(paths).not.toContain(FOO_README);
  expect(paths).not.toContain("package.json");
});

test("case 1: an unrelated non-source change (docs) is a HIT", async () => {
  const rs = await record();
  write(FOO_README, "# foo — edited, unrelated to the verdict\n");
  try {
    const v = await repo.revalidate(rs);
    expect(v.hit).toBe(true);
  } finally {
    write(FOO_README, "# foo\n");
  }
});

test("case 2: a source file's import edit (blobSha change) is a MISS", async () => {
  const rs = await record();
  write(
    FOO_INDEX,
    'import { x } from "@plugins/bar/web";\nexport default { x } as unknown;\n',
  );
  try {
    const v = await repo.revalidate(rs);
    expect(v.hit).toBe(false);
    if (!v.hit) expect(v.reason).toContain(FOO_INDEX);
  } finally {
    write(FOO_INDEX, "export default {} as unknown;\n");
  }
});

test("case 3 (H3/H9): a brand-new source file is a MISS via the membership glob", async () => {
  const rs = await record();
  // A NEW file — not in any recorded content fact. Only the plugins-wide
  // membership glob catches it: the match set gains the path. A content-only
  // read-set would HIT here and stale-PASS a newly-added file carrying a
  // violating import.
  const naughty = pj("foo/web/naughty.ts");
  write(naughty, 'import x from "@plugins/bar/server/deep/internal";\n');
  try {
    const v = await repo.revalidate(rs);
    expect(v.hit).toBe(false);
    if (!v.hit) expect(v.reason).toContain("glob match set changed");
  } finally {
    repo.remove(naughty);
  }
});

test("case 4 (H3): a new plugin dir holding only a non-.ts file is a MISS via membership", async () => {
  const rs = await record();
  // buildPluginTree's content gate makes ANY dir with a regular file a plugin, so
  // this adds `bar` to the plugin set → a new R1 "missing package.json" violation.
  // No .ts is added, so a .ts-only membership fact would miss it — the broad
  // plugins-wide glob is what closes this hole.
  const barDir = pj("bar");
  write(pj("bar/notes.md"), "not a source file\n");
  try {
    const v = await repo.revalidate(rs);
    expect(v.hit).toBe(false);
    if (!v.hit) expect(v.reason).toContain("glob match set changed");
  } finally {
    repo.remove(barDir);
  }
});

test("case 5: a package.json content change (R1 naming) is a MISS", async () => {
  const rs = await record();
  write(FOO_PKG, JSON.stringify({ name: "@equin/plugin-WRONG" }) + "\n");
  try {
    const v = await repo.revalidate(rs);
    expect(v.hit).toBe(false);
    if (!v.hit) expect(v.reason).toContain(FOO_PKG);
  } finally {
    write(FOO_PKG, JSON.stringify({ name: "@equin/plugin-foo" }) + "\n");
  }
});
