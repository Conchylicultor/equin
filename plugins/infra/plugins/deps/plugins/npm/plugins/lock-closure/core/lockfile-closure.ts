// The part of the lockfile a set of npm packages can load: each named
// package's lock entry, every package its dependencies (and peers) resolve to,
// transitively, and the patch files `bun.lock` applies to any of them. What a
// cache keyed on SOME npm code hashes instead of the whole lockfile
// (`lockfileNpmResolutions`), so a package it never loads — added, bumped or
// patched — does not move it.
//
// Resolution follows node's walk over bun's lock keys: a key is the package's
// `node_modules` path with the `node_modules/` segments dropped (`eslint` is
// hoisted, `eslint/ignore` is the copy nested under it), so a dependency `d`
// of the package at `a/b` is the first of `a/b/d`, `a/d`, `d` the lock holds.
// A package a repo file imports by name is found at the root key and under
// every workspace's own key (a workspace's non-hoisted copy): which workspace
// imports it is not asked, so the answer may hold a copy that file never
// loads — an over-invalidation, never a stale key.

import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { z } from "zod";

const LockSchema = z.object({
  workspaces: z.record(
    z.string(),
    z.object({ name: z.string().optional() }).passthrough(),
  ),
  patchedDependencies: z.record(z.string(), z.string()).optional(),
  // `[ "<name>@<version>", registry, info, integrity ]` (a workspace link is
  // `[ "<name>@workspace:<path>" ]`).
  packages: z.record(z.string(), z.array(z.unknown()).min(1)),
});

const InfoSchema = z
  .object({
    dependencies: z.record(z.string(), z.string()).optional(),
    optionalDependencies: z.record(z.string(), z.string()).optional(),
    peerDependencies: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

/** What a set of npm packages loads, as the lockfile pins it. */
export interface NpmClosure {
  /**
   * Every lock entry reached, canonical — `<key>\0<entry as JSON>`, sorted —
   * to hash: a version, integrity or dependency change of any of them moves it.
   */
  entries: string[];
  /** The patch file (repo-relative, as `bun.lock` names it) of every patched package reached, sorted. */
  patches: string[];
  /** Root names the lockfile holds no entry for, sorted: the caller decides whether that is an error. */
  missing: string[];
}

/** A lock key's package-name segments: `a/@s/p/b` → [`a`, `@s/p`, `b`]. */
function keySegments(key: string): string[] {
  const parts = key.split("/");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.startsWith("@") && i + 1 < parts.length) {
      out.push(`${p}/${parts[i + 1]}`);
      i++;
    } else out.push(p);
  }
  return out;
}

/** `bun.lock` parsed once, to close any number of package sets over. */
export interface BunLock {
  packages: Record<string, unknown[]>;
  patched: Record<string, string>;
  workspaceNames: string[];
}

/**
 * `bun.lock`'s text parsed as bun writes it. Throws when it does not parse: a
 * key that silently covered nothing would keep a stale result.
 */
export function parseBunLock(text: string): BunLock {
  const errors: ParseError[] = [];
  const raw: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(
      `bun.lock does not parse: ${errors.map((e) => `${printParseErrorCode(e.error)} at ${e.offset}`).join(", ")}`,
    );
  }
  const lock = LockSchema.parse(raw);
  return {
    packages: lock.packages,
    patched: lock.patchedDependencies ?? {},
    workspaceNames: Object.values(lock.workspaces)
      .map((w) => w.name)
      .filter((n): n is string => n !== undefined),
  };
}

/**
 * The closure, in `bun.lock`'s text, of the npm packages named `roots` (bare
 * package names, `@scope/name` or `name`). Throws when the lockfile does not
 * parse as bun writes it.
 */
export function lockfileNpmClosure(
  text: string,
  roots: Iterable<string>,
): NpmClosure {
  return npmClosureOf(parseBunLock(text), roots);
}

/** The closure, in a parsed lockfile, of the npm packages named `roots`. */
export function npmClosureOf(
  parsed: BunLock,
  roots: Iterable<string>,
): NpmClosure {
  const lock = { packages: parsed.packages };
  const { workspaceNames, patched } = parsed;

  const reached = new Set<string>();
  const stack: string[] = [];
  const missing = new Set<string>();
  for (const name of roots) {
    const keys = [name, ...workspaceNames.map((w) => `${w}/${name}`)].filter(
      (k) => lock.packages[k] !== undefined,
    );
    if (keys.length === 0) missing.add(name);
    stack.push(...keys);
  }
  /** The key a dependency `dep` of the package at `from` resolves to, if installed. */
  const resolve = (from: string, dep: string): string | undefined => {
    const segs = keySegments(from);
    for (let n = segs.length; n >= 0; n--) {
      const k = [...segs.slice(0, n), dep].join("/");
      if (lock.packages[k] !== undefined) return k;
    }
    return undefined;
  };
  while (stack.length > 0) {
    const key = stack.pop()!;
    if (reached.has(key)) continue;
    reached.add(key);
    const entry = lock.packages[key]!;
    const ident = entry[0];
    if (typeof ident === "string" && ident.includes("@workspace:")) continue;
    // A registry entry is `[ident, registry, info, integrity]`. Any other
    // shape (a git, tarball or file dependency) is not read here: walking it
    // as dependency-free would leave its dependencies out of the key.
    const info = InfoSchema.safeParse(entry[2]);
    if (!info.success) {
      throw new Error(
        `bun.lock entry ${key} (${String(ident)}) is not a registry entry this closure can read`,
      );
    }
    const deps = [
      ...Object.keys(info.data.dependencies ?? {}),
      ...Object.keys(info.data.optionalDependencies ?? {}),
      ...Object.keys(info.data.peerDependencies ?? {}),
    ];
    // A dependency the lock does not hold is not installed (another
    // platform's optional build, an absent optional peer): nothing loads it.
    for (const dep of deps) {
      const to = resolve(key, dep);
      if (to !== undefined && !reached.has(to)) stack.push(to);
    }
  }

  const entries = [...reached]
    .sort()
    .map((k) => `${k}\0${JSON.stringify(lock.packages[k])}`);
  const patches = new Set<string>();
  for (const k of reached) {
    const ident = lock.packages[k]![0];
    if (typeof ident !== "string") continue;
    const patch = patched[ident];
    if (patch !== undefined) patches.add(patch);
  }
  return {
    entries,
    patches: [...patches].sort(),
    missing: [...missing].sort(),
  };
}
