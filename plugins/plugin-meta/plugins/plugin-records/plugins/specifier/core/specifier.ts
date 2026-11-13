/**
 * The one reading of an import specifier as a repo path — what the
 * plugin-records module graph resolves every edge with, and what a reader
 * holding a specifier the graph has no edge for (an `import type`, a CSS
 * `@import`, a declared barrel name, a lint rule's one file) resolves it with,
 * so no two readers guess extensions, index files, queries or the `@plugins/`
 * alias differently.
 *
 * Repo-relative posix paths, in plain string operations: it resolves against
 * a file set, never the disk, so it needs no `node:path` (and `core/` may not
 * import it). A leaf with no imports, so a lint rule can load it.
 */

/** The repo's one path alias: `@plugins/<path>` is `plugins/<path>`. */
const PLUGINS_ALIAS = "@plugins/";

/**
 * What an extensionless specifier may name, in the order Bun tries — its
 * runtime and its bundler alike (measured: `.tsx` wins over a sibling `.ts`,
 * `.jsx` too). plugin-records' `module-graph.bun.test.ts` pins it against a
 * real `Bun.build`: a record keyed on the graph's edges is only as sound as
 * this order.
 */
export const RESOLVED_EXTENSIONS = [
  ".tsx",
  ".jsx",
  ".ts",
  ".mjs",
  ".js",
  ".cjs",
  ".json",
] as const;

/** The directory of a repo-relative path ("" for a top-level file). */
export function relDirname(rel: string): string {
  const cut = rel.lastIndexOf("/");
  return cut < 0 ? "" : rel.slice(0, cut);
}

/**
 * `spec` joined onto the directory `dir`, normalized — or null when it climbs
 * out of the repo. An absolute `dir` (a reader holding absolute paths: an
 * ESLint filename, a doc generator walking the disk) stays absolute.
 */
export function relJoin(dir: string, spec: string): string | null {
  const absolute = dir.startsWith("/");
  const out = dir.split("/").filter((seg) => seg !== "");
  for (const seg of spec.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  if (out.length === 0) return null;
  return `${absolute ? "/" : ""}${out.join("/")}`;
}

/**
 * Whether `spec` names a repo module (`.`, `..`, `./…`, `../…`, `@plugins/…`)
 * rather than a package.
 */
export function isRepoSpecifier(spec: string): boolean {
  return (
    spec === "." ||
    spec === ".." ||
    spec.startsWith("./") ||
    spec.startsWith("../") ||
    spec.startsWith(PLUGINS_ALIAS)
  );
}

/**
 * The repo path `spec`, written in `fromRel`, names before any extension or
 * index file is tried: `@plugins/<p>` → `plugins/<p>`, a relative one joined
 * onto the importer's directory. A bundler query (`?raw`, `?url`) is dropped:
 * the module is the file it names. Null for a package (a bare specifier,
 * a builtin) or a path climbing out of the repo.
 */
export function specifierPath(fromRel: string, spec: string): string | null {
  if (!isRepoSpecifier(spec)) return null;
  const query = spec.indexOf("?");
  const path = query === -1 ? spec : spec.slice(0, query);
  return path.startsWith(PLUGINS_ALIAS)
    ? relJoin("plugins", path.slice(PLUGINS_ALIAS.length))
    : relJoin(relDirname(fromRel), path);
}

/**
 * Every file `spec` (from `fromRel`) may resolve to, in the order the runtime
 * tries them: the path itself, with each extension, then its index file with
 * each. Null for a package.
 */
export function specifierCandidates(
  fromRel: string,
  spec: string,
): string[] | null {
  const base = specifierPath(fromRel, spec);
  if (base === null) return null;
  return [
    base,
    ...RESOLVED_EXTENSIONS.map((e) => `${base}${e}`),
    ...RESOLVED_EXTENSIONS.map((e) => `${base}/index${e}`),
  ];
}

/**
 * The file of `has` that `spec` (written in `fromRel`) resolves to — the
 * module graph's resolution over a file set — or null: a package, or no file
 * of the set. `has` may be any file set, a subset included (the public
 * barrels, one module's files): the answer is then the first candidate IN it.
 */
export function resolveSpecifier(
  fromRel: string,
  spec: string,
  has: (rel: string) => boolean,
): string | null {
  const candidates = specifierCandidates(fromRel, spec);
  if (candidates === null) return null;
  for (const c of candidates) if (has(c)) return c;
  return null;
}
