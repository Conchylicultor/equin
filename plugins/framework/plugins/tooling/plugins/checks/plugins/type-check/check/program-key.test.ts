/**
 * The program key is what lets the tsc worker be SKIPPED, so the whole
 * value of these tests is the direction of the failures: a key that changes
 * when it should not costs a needless run, but a key that stays the same when
 * the program's meaning changed skips a check that would have failed.
 *
 * Each case below is one way the program could differ:
 *   1. nothing changed → the same key (otherwise nothing is ever skipped);
 *   2. a listed file's CONTENT changed — repo file or `node_modules` file alike;
 *   3. the ROOT set changed (the tsconfig now includes something else);
 *   4. a tsconfig's own contents changed (different compiler options);
 *   5. a NEW `.ts` appeared that no listed file mentions — the resolution
 *      shadowing hazard, which no content hash of an existing file can see;
 *   6. no program manifest, or one whose shape we do not recognise → NO key at all,
 *      never a key over an empty program.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { readTreeListing } from "./fingerprint";
import { openProgramKeyContext, programKey } from "./program-key";
import { readProgramManifest } from "../shared/program-manifest";

let root = "";

function write(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** A program manifest listing `rels`, written where the check keeps them. */
function writeManifest(rels: string[]): string {
  const rel = ".cache/type-check/repo.program.json";
  // Manifest paths are relative to the repo root.
  write(rel, JSON.stringify({ files: rels }));
  return join(root, rel);
}

const PROGRAM = {
  get tsconfigPath() {
    return join(root, "tsconfig.json");
  },
  get manifestPath() {
    return join(root, ".cache/type-check/repo.program.json");
  },
};

/**
 * A key computed the way a fresh run computes one: a brand-new context.
 * `null` stands for "no key" so the assertions below read as comparisons.
 *
 * Async because the listing it reads comes out of git, which is also why the
 * fixture below is a real repository.
 */
async function keyNow(
  roots: string[] = [join(root, "a.ts")],
): Promise<string | null> {
  const result = programKey(
    openProgramKeyContext(await readTreeListing(root)),
    PROGRAM,
    roots,
  );
  return result.kind === "key" ? result.key : null;
}

/** Run one git command in the fixture, failing loudly if it does not. */
async function git(...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${code}): ${await new Response(proc.stderr).text()}`,
    );
  }
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "type-check-program-key-"));
  write("a.ts", "export const a = 1;\n");
  write("b.ts", "export const b = 2;\n");
  write("node_modules/dep/index.d.ts", "export declare const d: number;\n");
  write("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true } }));
  write("package.json", JSON.stringify({ name: "fixture" }));
  writeManifest(["a.ts", "b.ts", "node_modules/dep/index.d.ts"]);
  // A real repository, because the key's file listing is read out of git — the
  // one enumeration the check cache key also hashes. `core.excludesFile` is
  // pointed at nothing so the host user's own global ignores cannot decide what
  // this fixture contains.
  await git("init", "-q");
  await git("config", "core.excludesFile", "/dev/null");
  await git("config", "user.email", "t@t.t");
  await git("config", "user.name", "t");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("an unchanged tree yields the same key", async () => {
  expect(await keyNow()).toBe(await keyNow());
});

test("a listed repo file's content changes the key", async () => {
  const before = await keyNow();
  write("b.ts", "export const b = 3;\n");
  expect(await keyNow()).not.toBe(before);
});

test("a listed node_modules file's content changes the key", async () => {
  // Hashed DIRECTLY rather than trusted through the lockfile, so a
  // hand-patched dependency cannot pass as unchanged.
  const before = await keyNow();
  write("node_modules/dep/index.d.ts", "export declare const d: string;\n");
  expect(await keyNow()).not.toBe(before);
});

test("a different root set changes the key", async () => {
  const before = await keyNow();
  expect(await keyNow([join(root, "a.ts"), join(root, "b.ts")])).not.toBe(
    before,
  );
});

test("root order does not change the key", async () => {
  const forward = await keyNow([join(root, "a.ts"), join(root, "b.ts")]);
  expect(await keyNow([join(root, "b.ts"), join(root, "a.ts")])).toBe(forward);
});

test("a tsconfig edit changes the key", async () => {
  const before = await keyNow();
  write(
    "tsconfig.json",
    JSON.stringify({ compilerOptions: { strict: false } }),
  );
  expect(await keyNow()).not.toBe(before);
});

test("a package.json edit changes the key", async () => {
  const before = await keyNow();
  write("package.json", JSON.stringify({ name: "fixture", type: "module" }));
  expect(await keyNow()).not.toBe(before);
});

test("a NEW .ts file that nothing lists changes the key", async () => {
  // The shadowing hazard: `c.ts` appearing beside a `c/index.ts` re-resolves an
  // import whose own bytes never moved. Nothing in the file list can show that,
  // so the key over-invalidates on any add or remove instead.
  const before = await keyNow();
  write("c.ts", "export const c = 3;\n");
  expect(await keyNow()).not.toBe(before);
});

test("an unrelated non-TypeScript file does NOT change the key", async () => {
  const before = await keyNow();
  write("README.md", "# docs\n");
  expect(await keyNow()).toBe(before);
});

test("a .ts in a GITIGNORED directory does not change the key", async () => {
  // The reported bug. `.cache/` is gitignored build output this very check
  // writes into, and the walk that used to enumerate the tree pruned by a
  // hand-written list of directory names that `.cache/` was not on — so a
  // scratch `.ts` there counted as source. The ignore rule is written by THIS
  // test rather than the shared fixture, so what keeps the file out is visibly
  // `.gitignore`, not a directory name spelled somewhere in code.
  write(".gitignore", ".cache/\n");
  const before = await keyNow();
  write(".cache/scratch.ts", "export const scratch = 1;\n");
  expect(await keyNow()).toBe(before);
  expect((await readTreeListing(root)).files).not.toContain(
    ".cache/scratch.ts",
  );
});

test("no manifest means no key — a cold run, never a skip", async () => {
  rmSync(join(root, ".cache"), { recursive: true, force: true });
  expect(await keyNow()).toBeNull();
});

test("a manifest with no files array means no key", async () => {
  write(
    ".cache/type-check/repo.program.json",
    JSON.stringify({ version: "5" }),
  );
  expect(await keyNow()).toBeNull();
});

test("a torn manifest means no key", async () => {
  write(".cache/type-check/repo.program.json", '{"files": ["a.ts"');
  expect(await keyNow()).toBeNull();
});

test("readProgramManifest resolves paths against the repo root", () => {
  const path = writeManifest(["a.ts", "node_modules/dep/index.d.ts"]);
  expect(readProgramManifest(path, root)).toEqual({
    kind: "files",
    files: [join(root, "a.ts"), join(root, "node_modules/dep/index.d.ts")],
  });
});

test("readProgramManifest tells an ABSENT manifest from an unreadable one", () => {
  // The two are different facts: absent is the ordinary cold case, unreadable
  // is worth naming in the log. Collapsing them to one nullish value is exactly
  // what the discriminated result exists to prevent.
  rmSync(join(root, ".cache"), { recursive: true, force: true });
  expect(readProgramManifest(PROGRAM.manifestPath, root).kind).toBe("absent");
  write(".cache/type-check/repo.program.json", "{not json");
  expect(readProgramManifest(PROGRAM.manifestPath, root).kind).toBe(
    "unreadable",
  );
  write(".cache/type-check/repo.program.json", JSON.stringify({ files: 3 }));
  expect(readProgramManifest(PROGRAM.manifestPath, root).kind).toBe(
    "unreadable",
  );
});
