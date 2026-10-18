// A content key for a tsc program, and the host-global record of which such
// programs have passed.
//
// Why a key at all: a miss on the outer (whole-check) cache rebuilds the
// program even when the edit cannot have changed what it contains — a docs
// commit that happens to sit in the same tree as a `.ts` the outer read-set
// recorded, a generated registry rewritten to identical bytes. The key below
// says "this exact program passed before", so a worker with nothing to compute
// does not run. (It was once a key PER TARGET, when there were seven
// overlapping programs and an edit under a plugin's `web/` still rebuilt
// `server-core`. There is one program now, and the key is what still makes an
// unchanged tree free.)
//
// THIS KEY DECIDES WHETHER A WORKER RUNS. A recorded match means tsc is not
// invoked at all, so the key IS the verdict — there is
// no compiler behind it to catch a key that was too loose. That is why the
// envelope below is spelled out in full, and why anything unclear (no
// buildinfo, a shape we do not recognise) yields NO key and a cold run rather
// than a guess. Design and measurements:
// research/2026-09-08-global-type-check-per-target-program-skip.md.
//
// Soundness, in one paragraph. A program is a function of (roots, file
// contents, compiler options). `L_t` — the `fileNames` tsc itself wrote into
// the program's `.tsbuildinfo` — is the exact set of files it loaded on
// some earlier tree. If every file in `L_t` has identical content now and the
// roots are identical, module resolution runs the same and yields the same
// program, hence the same verdict. Roots are covered by `R_t`; options by the
// tsconfig contents; `node_modules` contents are hashed directly rather than
// trusted through `bun.lock`, which closes the hand-patched-dependency hole;
// the worker's own behaviour is code, covered by `selfSourceHash`. The one way
// resolution can change with no content in `L_t` changing is a NEWLY ADDED file
// shadowing a resolution (`foo.ts` appearing beside `foo/index.ts`), which
// `allTsNames` closes by over-invalidating on any added or removed TypeScript
// file anywhere.
//
// The one edge outside the envelope, stated so nobody has to rediscover it: a
// file ADDED inside `node_modules` with no lockfile change. Modified dependency
// files are caught (their contents are hashed directly), removed ones too (the
// hash becomes `"-"`), and any real `bun install` rewrites `bun.lock`, which is
// in the key. Only a file hand-copied into `node_modules` can shadow a
// resolution invisibly — and enumerating a hundred thousand dependency paths on
// every run to close that is not a trade worth making.

import { createHash } from "crypto";
import { existsSync, readdirSync } from "fs";
import { join, relative, sep } from "path";
import { fileURLToPath } from "url";
import {
  hashFileBytes,
  hashFileCached,
  readProgramFileList,
  type ContentHashMemo,
} from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { listNamedCompositionRegistries } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { programPassDir } from "../data-dirs";
import { findFiles, type TreeListing } from "./fingerprint";
import { openPassSet, type PassSetBounds } from "../shared/pass-set";

// Entries are per (program name, program key) — one or two per run, against
// the lint result store's thousands — so the count bound is a formality and the
// 14-day age bound does the evicting. Same shape as the lint result store so
// the stores are read the same way.
const BOUNDS: PassSetBounds = {
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
  maxEntries: 20000,
  trimTo: 16000,
  pruneIntervalMs: 60 * 60 * 1000,
};

/**
 * The files whose content the key folds in ON TOP of the program's own loaded
 * set: every `tsconfig*.json` (compiler options, path aliases, the `extends`
 * chain), every `package.json` outside `node_modules`, the lockfile, and every
 * ambient `.d.ts`.
 *
 * Deliberately NARROWER than the outer read-set's global trigger set: the
 * lint-only globals (`eslint.config.ts`, `plugins/**\/lint/**`,
 * `*.lint.generated.ts`) are excluded, so changing a lint rule no longer flips
 * every program's TSC key.
 *
 * Dropping them is safe WITHOUT a second mechanism, and the reason is worth
 * stating: a lint-rule edit flips its rule group's fingerprint
 * (`./lint-groups`), so every file's stored result for that group is stale —
 * every run's `lintFiles` list is non-empty and the skip clause refuses to skip
 * anyway. An exemption edit changes no fingerprint at all: the verdict is
 * re-assembled from the stored results in `finalize`, skipped program or not.
 * The narrowing only removes a redundancy; it cannot let a lint-rule change go
 * unchecked.
 */
function isTscTrigger(rel: string): boolean {
  const base = rel.split("/").pop()!;
  if (base.startsWith("tsconfig") && base.endsWith(".json")) return true;
  if (base === "package.json") return true;
  if (rel === "bun.lock" || rel === "bun.lockb") return true;
  if (rel.endsWith(".d.ts")) return true;
  return false;
}

/**
 * Every `.ts` / `.tsx` in the repo, INCLUDING the `*.generated.ts` the lint
 * universe ignores: a generated registry is a tsc root, and an added one can
 * shadow a resolution just as any other file can.
 */
function isTsName(rel: string): boolean {
  return rel.endsWith(".ts") || rel.endsWith(".tsx");
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

let cachedSelfSourceHash: string | null = null;

/**
 * A hash of THIS check's own source — every `.ts` under the plugin's `check/`
 * and `shared/`, plus the program declaration it depends on.
 *
 * Without it, editing the worker (say, adding a diagnostic category) would leave
 * every recorded PASS looking valid, and the new behaviour would be skipped over
 * on exactly the trees that most needed re-running.
 *
 * Files are named by their path RELATIVE to the plugin, never absolutely: the
 * pass set is host-global, and an absolute path carries the worktree's name, so
 * an absolute spelling would make every worktree's key unique and the whole
 * store useless while still looking like it worked.
 */
export function selfSourceHash(): string {
  if (cachedSelfSourceHash !== null) return cachedSelfSourceHash;
  const pluginDir = fileURLToPath(new URL("..", import.meta.url));
  const parts: string[] = [];
  for (const sub of ["check", "shared"]) {
    const dir = join(pluginDir, sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith(".ts")) {
        parts.push(`${sub}/${name}\0${hashFileBytes(join(dir, name))}`);
      }
    }
  }
  const discover = fileURLToPath(
    new URL("../../../core/discover.ts", import.meta.url),
  );
  parts.push(`checks/core/discover.ts\0${hashFileBytes(discover)}`);
  return (cachedSelfSourceHash = sha256(parts.join("\n")));
}

/**
 * Everything a program key needs that is not the program's own file list,
 * computed once per run: the tsc-relevant trigger contents, the name-only
 * census of the repo's TypeScript (the shadowing guard), and this check's own
 * source hash.
 */
export interface ProgramKeyContext {
  root: string;
  /**
   * Memoised `abs -> content hash`, shared with whoever opened the context.
   *
   * The warm-base selection hashes most of these same files moments earlier to
   * score the pool, so the run passes ONE memo through both steps: the reads
   * are paid once, and both steps necessarily answered from the same reading
   * of the tree.
   */
  contentHash: ContentHashMemo;
  sharedPrefix: string;
}

export function openProgramKeyContext(
  listing: TreeListing,
  contentHash: ContentHashMemo = new Map(),
): ProgramKeyContext {
  const triggers = findFiles(listing, isTscTrigger).map(
    (rel) => `${rel}\0${hashFileCached(contentHash, join(listing.root, rel))}`,
  );
  // Names only: an ADDED or REMOVED `.ts` anywhere can change how an unchanged
  // import specifier resolves, and no content hash of an existing file would
  // show it. Over-invalidating on every add/remove is the cheap safe side.
  //
  // `listing` is what git knows about, which is the right universe everywhere
  // else — but NOT here, and this is the one place the difference bites. The
  // per-composition registries (`web.composition.sonata.generated.ts` and its
  // siblings) are gitignored, yet they sit inside a tsconfig `include` and tsc
  // compiles them. Two of them exist on `main` right now. Left out, this census
  // would stop noticing when one appears or vanishes — and this key is what
  // decides whether tsc runs at all, so there would be no compiler
  // behind it to catch the miss.
  //
  // The list comes from the WRITER's own function, not from a glob retyped
  // here: `listNamedCompositionRegistries` is what the codegen stage uses to
  // sweep these same files, so the reader and the writer cannot drift about
  // where they live or how they are spelled.
  const allTsNames = [
    ...findFiles(listing, isTsName),
    ...listNamedCompositionRegistries(listing.root).map((r) =>
      relative(listing.root, r.file).split(sep).join("/"),
    ),
  ].sort();
  return {
    root: listing.root,
    contentHash,
    sharedPrefix: [
      "v1",
      selfSourceHash(),
      sha256(triggers.join("\n")),
      sha256(allTsNames.join("\n")),
    ].join("\n"),
  };
}

/**
 * The program key, or the reason there is none.
 *
 * "No key" is not a failure — a cold checkout simply has no earlier program to
 * compare against — but it is not a key either, and the caller must not be able
 * to confuse the two. The `why` is what the check prints so an operator can see
 * that the program could not be keyed, and whether that is expected.
 */
export type ProgramKeyResult =
  { kind: "key"; key: string } | { kind: "none"; why: string };

/**
 * The content key of a program.
 *
 * `roots` is the tsconfig's own include-expansion (`R_t`), which pins WHICH
 * program this is; the buildinfo's file list is what that program actually
 * loaded (`L_t`), which pins what it saw.
 */
export function programKey(
  ctx: ProgramKeyContext,
  program: { tsconfigPath: string; buildInfoPath: string },
  roots: string[],
): ProgramKeyResult {
  const listed = readProgramFileList(program.buildInfoPath);
  if (listed.kind === "absent") {
    return { kind: "none", why: "no buildinfo yet" };
  }
  if (listed.kind === "unreadable") return { kind: "none", why: listed.why };
  const rel = (abs: string): string =>
    relative(ctx.root, abs).split(sep).join("/");
  const body = [...listed.files]
    .sort()
    .map((abs) => `${rel(abs)}\0${hashFileCached(ctx.contentHash, abs)}`)
    .join("\n");
  return {
    kind: "key",
    key: sha256(
      [
        ctx.sharedPrefix,
        rel(program.tsconfigPath),
        sha256([...roots].sort().map(rel).join("\n")),
        body,
      ].join("\n"),
    ),
  };
}

export interface ProgramPasses {
  /** True iff this exact program key was recorded green before, by any worktree. */
  has(programName: string, key: string): boolean;
  record(programName: string, key: string): void;
}

/** Open the host-global record of program PASSes, keyed by program name. */
export function openProgramPasses(): ProgramPasses {
  const set = openPassSet(programPassDir, BOUNDS);
  return {
    has: (programName, key) => set.has(`${programName}:${key}`),
    record: (programName, key) =>
      set.record(`${programName}:${key}`, { program: programName, key }),
  };
}
