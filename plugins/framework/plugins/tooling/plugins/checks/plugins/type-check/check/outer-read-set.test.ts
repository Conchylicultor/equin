/**
 * Soundness round-trip for type-check's OUTER input-keyed read-set (Stage 2),
 * exercised the way the runner drives it: record the read-set by running
 * `recordOuterReadSet` under a recording `FileSystemView` over a real throwaway
 * git repo, then `validate` it against a FRESH snapshot of a mutated tree.
 *
 * The four cases that make the outer cache trustworthy:
 *   1. a non-`.ts` change (docs) is a HIT — the whole point (docs-only ⇒ zero workers);
 *   2. any `.ts` CONTENT change is a MISS (the type graph changed);
 *   3. a BRAND-NEW `.ts` file is a MISS via the MEMBERSHIP glob (hazard H3 — the
 *      coverage gate: a content-only read-set would stale-PASS this);
 *   4. a global-trigger change (tsconfig / package.json) is a MISS via its content
 *      fact — the compiler/config-version invalidation path.
 *
 * Plus the enumeration regression (2026-09-09): the listing behind the lintable
 * set comes out of git, so a `.ts` under a gitignored directory is invisible to
 * it.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  createReadSetRepo,
  type ReadSetRepo,
} from "@plugins/framework/plugins/tooling/plugins/checks/core/testing";
import { lintableFiles } from "./import-graph";
import { recordOuterReadSet } from "./outer-read-set";

let repo: ReadSetRepo;

const write = (rel: string, content: string): void => repo.write(rel, content);

beforeAll(async () => {
  // a.ts / b.ts: lintable sources. README.md: an unrelated non-.ts file.
  // tsconfig.json + package.json: global-trigger files.
  repo = await createReadSetRepo("type-check-outer-read-set-", {
    "a.ts": "export const a = 1;\n",
    "b.ts": "export const b = 2;\n",
    "README.md": "# hello\n",
    "tsconfig.json":
      JSON.stringify({ compilerOptions: { strict: true } }) + "\n",
    "package.json":
      JSON.stringify({
        name: "fixture",
        dependencies: { typescript: "5.0.0" },
      }) + "\n",
  });
});

afterAll(() => {
  repo?.dispose();
});

/** Record type-check's outer read-set the same way run() does. */
const record = () =>
  repo.record(async (view) =>
    recordOuterReadSet(view, (await repo.snapshot()).paths()),
  );

test("records membership globs + a content fact per lintable & global-trigger file", async () => {
  const rs = await record();
  // (a) membership: the three namespace globs.
  expect(rs.globs.map((g) => g.glob).sort()).toEqual([
    "*.ts",
    "*.tsx",
    "*tsconfig*.json",
  ]);
  const tsGlob = rs.globs.find((g) => g.glob === "*.ts")!;
  expect(tsGlob.matches).toEqual(["a.ts", "b.ts"]);
  // (b)+(c) contents: both lintable sources and both global triggers.
  const paths = rs.files.map((f) => f.path).sort();
  expect(paths).toContain("a.ts");
  expect(paths).toContain("b.ts");
  expect(paths).toContain("tsconfig.json");
  expect(paths).toContain("package.json");
});

test("every file the check lints has a recorded content fact", async () => {
  // The read-set is recorded from the snapshot's paths on the runner's
  // thread; the preparation thread lints from its own load of the same tree.
  // Both filter with `lintableFiles`, so a linted file can never be missing
  // from the read-set.
  const rs = await record();
  const recorded = new Set(rs.files.map((f) => f.path));
  const files = lintableFiles((await repo.snapshot()).paths());
  expect(files.length).toBeGreaterThan(0);
  expect(files.filter((f) => !recorded.has(f))).toEqual([]);
});

test("case 1: a non-.ts (docs) change is a HIT — docs-only ⇒ zero workers", async () => {
  const rs = await record();
  write("README.md", "# hello world — edited, unrelated\n");
  try {
    const v = await repo.revalidate(rs);
    expect(v.hit).toBe(true);
  } finally {
    write("README.md", "# hello\n");
  }
});

test("case 2: any .ts content change is a MISS", async () => {
  const rs = await record();
  write("a.ts", "export const a = 42;\n");
  try {
    const v = await repo.revalidate(rs);
    expect(v.hit).toBe(false);
    if (!v.hit) expect(v.reason).toContain("a.ts");
  } finally {
    write("a.ts", "export const a = 1;\n");
  }
});

test("case 3 (H3 coverage gate): a brand-new .ts file is a MISS via the membership glob", async () => {
  const rs = await record();
  // c.ts is a NEW file — not in any recorded content fact. Only the `*.ts`
  // membership glob catches it: the match set gains c.ts. A content-only
  // read-set would HIT here and stale-PASS the coverage gate.
  write("c.ts", "export const c = 3;\n");
  try {
    const v = await repo.revalidate(rs);
    expect(v.hit).toBe(false);
    if (!v.hit) expect(v.reason).toContain("glob match set changed");
  } finally {
    repo.remove("c.ts");
  }
});

test("case 4: a global-trigger (tsconfig) change is a MISS", async () => {
  const rs = await record();
  write(
    "tsconfig.json",
    JSON.stringify({ compilerOptions: { strict: false } }) + "\n",
  );
  try {
    const v = await repo.revalidate(rs);
    expect(v.hit).toBe(false);
    if (!v.hit) expect(v.reason).toContain("tsconfig.json");
  } finally {
    write(
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { strict: true } }) + "\n",
    );
  }
});

test("case 4b: a package.json (compiler-version) change is a MISS", async () => {
  const rs = await record();
  write(
    "package.json",
    JSON.stringify({ name: "fixture", dependencies: { typescript: "5.9.9" } }) +
      "\n",
  );
  try {
    const v = await repo.revalidate(rs);
    expect(v.hit).toBe(false);
    if (!v.hit) expect(v.reason).toContain("package.json");
  } finally {
    write(
      "package.json",
      JSON.stringify({
        name: "fixture",
        dependencies: { typescript: "5.0.0" },
      }) + "\n",
    );
  }
});

test("a .ts under a gitignored directory is not in the lintable set", async () => {
  // The 2026-09-09 failure: type-check walked the filesystem, so a stray `.ts`
  // an agent had left under gitignored `.cache/scratch/` counted as lintable,
  // matched no tsconfig program, and failed the coverage gate — over content
  // the check cache key never covers. Reading the tree out of git removes the
  // spelling entirely; the only way to regress is to walk again.
  write(".gitignore", "ignored/\n");
  write("ignored/stray.ts", "export const stray = 1;\n");
  try {
    const files = lintableFiles((await repo.snapshot()).paths());
    expect(files).toContain("a.ts");
    expect(files).not.toContain("ignored/stray.ts");
  } finally {
    repo.remove("ignored");
    repo.remove(".gitignore");
  }
});
