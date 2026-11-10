import {
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
} from "@plugins/packages/plugins/timed-fs/core";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { isImportMapOnlySpecifier } from "@plugins/framework/plugins/import-map-names/core";

// Where an import resolves, answered without holding the thread: every disk
// question is an async `readdir` (one per directory a walk touches, shared by
// every import into it), an async `lstat` walking up to a `node_modules`
// entry, or an async `realpath` of a symlink. `Bun.resolveSync` answered the
// same question by stat-ing every candidate on the JS thread — measured on a
// backend's closure (5,418 files, 18,468 imports): 270 ms of thread time per
// walk, on every deploy's restart-skip judgement.
//
// It is Bun's resolution for what a closure of this repo imports, nothing
// more, and it FAILS CLOSED on everything else: an import it cannot answer
// exactly as the runtime would throws, and the digest refuses the closure
// (never a guess that could miss a file). `resolve.test.ts` holds it to
// `Bun.resolveSync` over a real backend closure, import by import.
//
// - A relative / absolute path, or a tsconfig alias (`tsconfig.base.json`'s
//   `paths`, the repo's single alias owner — `tsconfig-alias-single-owner`),
//   resolves as a file: the exact path, else the path plus the first extension
//   that exists in the runtime's order, else a `.js`-family extension swapped
//   for its TypeScript twin, else a directory's `index` plus the first
//   extension. The order was measured on Bun 1.4.4 (`.tsx .jsx .mts .ts .mjs
//   .js .cts .cjs .json`, the same for `index`; a file before a directory). Two
//   twins (`x.ts` and `x.tsx` for `./x.js`), or a twin beside an appended
//   extension, are settled by an order not measured: refused. So is a
//   directory whose `package.json` names an entry (`main`, `module`,
//   `exports`).
// - A path is canonical: the walk's entries are real paths, and a resolved
//   path that crosses a symlink below the importer's directory is made real
//   (`realpath`), so one file has one identity in a walk and across processes.
// - A bare specifier resolves as a PACKAGE: the first `node_modules/<name>`
//   entry walking up from the importer, and the directory it really is (the
//   walk never reads a package's files — its `name@version` counts). An entry
//   whose real directory is outside every `node_modules` (a workspace link) is
//   refused: it would be repo code the walk does not follow.
// - A bare specifier with no `node_modules` entry is refused — unless it is in
//   a namespace only a page's import map answers (`@browser-host/…`,
//   `framework/import-map-names`): no tsconfig path and no package
//   answers it, so the runtime loads nothing for it — its `import()` rejects
//   on the server, which never calls it (the page does). Its answer is
//   `import-map`, an edge the walk counts by name. Checked AFTER the
//   aliases and the `node_modules` lookup, as the runtime would: a package
//   that ever took the name resolves as that package.

/** An import the resolver cannot answer exactly as the runtime would. */
export class UnresolvedImportError extends Error {}

/** Where one import lands. */
export type Resolution =
  | { kind: "file"; path: string }
  | {
      kind: "package";
      /** The `node_modules/<name>` entry resolution went through (maybe a symlink). */
      entry: string;
      /** The package's real directory. */
      dir: string;
    }
  | {
      /** A specifier only a page's import map answers: nothing the runtime loads. */
      kind: "import-map";
      specifier: string;
    };

// The runtime's order (measured, Bun 1.4.4).
const EXTENSIONS = [
  ".tsx",
  ".jsx",
  ".mts",
  ".ts",
  ".mjs",
  ".js",
  ".cts",
  ".cjs",
  ".json",
] as const;

// A `.js`-family specifier the runtime also finds under a TypeScript twin.
const TS_TWINS: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx", ".mts", ".cts"],
  ".jsx": [".tsx", ".ts"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

const NODE_MODULES = `${sep}node_modules${sep}`;
const TSCONFIG_BASE = "tsconfig.base.json";

type EntryKind = "file" | "dir" | "missing";

/** A directory entry: what it is (a symlink classified by what it points at), and whether it is a link. */
interface Entry {
  kind: "file" | "dir";
  link: boolean;
}

interface Aliases {
  /** `@plugins/` → `<root>/plugins/` (a `*` key, its target's `*` stripped). */
  prefixes: readonly (readonly [string, string])[];
  exact: ReadonlyMap<string, string>;
}

/** One walk's resolver: answers memoized for that walk only, so a later walk sees a tree that moved. */
export interface ImportResolver {
  /** Synchronous once the walk has answered the same target (most imports: a barrel many files import). */
  resolve(
    specifier: string,
    importer: string,
  ): Resolution | Promise<Resolution>;
}

/** `map`'s value for `key`, made by `make` the first time it is asked. */
function memo<V>(map: Map<string, V>, key: string, make: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = make();
    map.set(key, value);
  }
  return value;
}

/** A file path, or why the runtime's answer could not be copied. */
type PathAnswer = { ok: true; path: string } | { ok: false; why: string };

export function createImportResolver(): ImportResolver {
  // Every answer below is memoized for the walk: an import into a directory
  // many files import (a barrel) is resolved once, a directory listed once.
  const listings = new Map<string, Promise<ReadonlyMap<string, Entry>>>();
  const linkFree = new Map<string, Promise<boolean>>();
  const answers = new Map<string, Promise<PathAnswer>>();
  // Directory → the alias owner governing it (the nearest tsconfig.base.json).
  const aliasOwners = new Map<string, Promise<Aliases | null>>();
  // (directory, package name) → the node_modules entry above it, or null.
  const moduleEntries = new Map<string, Promise<string | null>>();
  const realpaths = new Map<string, Promise<string>>();
  const entryFields = new Map<string, Promise<boolean>>();
  // Settled answers, read without a promise hop: a walk asks ~3 imports per
  // file, mostly of targets it has already resolved.
  const settledPaths = new Map<string, PathAnswer>();
  const settledAliases = new Map<string, Aliases | null>();

  const listing = (dir: string): Promise<ReadonlyMap<string, Entry>> =>
    memo(listings, dir, async () => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return new Map();
        throw err;
      }
      const kinds = new Map<string, Entry>();
      const links: string[] = [];
      for (const e of entries) {
        if (e.isFile()) kinds.set(e.name, { kind: "file", link: false });
        else if (e.isDirectory())
          kinds.set(e.name, { kind: "dir", link: false });
        else if (e.isSymbolicLink()) links.push(e.name);
      }
      // A link is classified by what it points at (rare in a repo).
      await Promise.all(
        links.map(async (name) => {
          try {
            const s = await stat(join(dir, name));
            kinds.set(name, {
              kind: s.isDirectory() ? "dir" : "file",
              link: true,
            });
          } catch (err) {
            // A dangling link resolves to nothing, as for the runtime.
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          }
        }),
      );
      return kinds;
    });

  const entryAt = async (path: string): Promise<Entry | undefined> =>
    (await listing(dirname(path))).get(basename(path));

  const kindOf = async (path: string): Promise<EntryKind> =>
    (await entryAt(path))?.kind ?? "missing";

  const realpathOf = (path: string): Promise<string> =>
    memo(realpaths, path, () => realpath(path));

  // Whether no component of `dir` is a symlink.
  const isLinkFree = (dir: string): Promise<boolean> =>
    memo(linkFree, dir, async () => {
      const parent = dirname(dir);
      if (parent === dir) return true;
      return (await isLinkFree(parent)) && !(await entryAt(dir))?.link;
    });

  // `path`'s canonical spelling (its directory entry in hand): itself, unless
  // it goes through a symlink — a repo path through one is rare, and then
  // asked once.
  const canonical = async (path: string, entry: Entry): Promise<string> =>
    !entry.link && (await isLinkFree(dirname(path))) ? path : realpathOf(path);

  const aliasesFor = (dir: string): Promise<Aliases | null> =>
    memo(aliasOwners, dir, async () => {
      if ((await kindOf(join(dir, TSCONFIG_BASE))) === "file") {
        return readAliases(dir);
      }
      const parent = dirname(dir);
      return parent === dir ? null : aliasesFor(parent);
    });

  // Whether a directory's package.json names an entry the runtime would load
  // instead of its index.
  const namesEntry = (dir: string): Promise<boolean> =>
    memo(entryFields, dir, async () => {
      const pkg = join(dir, "package.json");
      const json = parseJson(pkg, await readFile(pkg, "utf8")) as Record<
        string,
        unknown
      >;
      return ["main", "module", "exports"].some((k) => k in json);
    });

  // The file `base` (an absolute path, extension maybe omitted) resolves to.
  // Every candidate of one step shares a directory, so each step is one
  // listing and a synchronous look-up per candidate.
  const resolvePath = (base: string): Promise<PathAnswer> =>
    memo(answers, base, async (): Promise<PathAnswer> => {
      const dir = dirname(base);
      const name = basename(base);
      const siblings = await listing(dir);
      const isFile = (n: string) => siblings.get(n)?.kind === "file";
      const self = siblings.get(name);
      if (self?.kind === "file") {
        return { ok: true, path: await canonical(base, self) };
      }
      const ext = EXTENSIONS.find((e) => isFile(name + e));
      const twins = twinsOf(name).filter(isFile);
      if (twins.length > (ext === undefined ? 1 : 0)) {
        const all = [...(ext === undefined ? [] : [name + ext]), ...twins];
        return {
          ok: false,
          why: `${all.map((n) => join(dir, n)).join(" and ")} both match, picked by an order this resolver does not copy`,
        };
      }
      const file = ext === undefined ? twins[0] : name + ext;
      if (file !== undefined) {
        return {
          ok: true,
          path: await canonical(join(dir, file), siblings.get(file)!),
        };
      }
      if (self?.kind === "dir") {
        const inside = await listing(base);
        if (
          inside.get("package.json")?.kind === "file" &&
          (await namesEntry(base))
        ) {
          return {
            ok: false,
            why: "it is a directory whose package.json names an entry, which this resolver does not follow",
          };
        }
        const index = EXTENSIONS.find(
          (e) => inside.get(`index${e}`)?.kind === "file",
        );
        if (index !== undefined) {
          const file = `index${index}`;
          return {
            ok: true,
            path: await canonical(join(base, file), inside.get(file)!),
          };
        }
      }
      return { ok: false, why: "no file matches" };
    });

  const fileOf = (
    answer: PathAnswer,
    specifier: string,
    importer: string,
  ): Resolution => {
    if (!answer.ok) {
      throw new UnresolvedImportError(
        `cannot resolve "${specifier}" imported by ${importer}: ${answer.why}`,
      );
    }
    return { kind: "file", path: answer.path };
  };

  const fileAt = (
    base: string,
    specifier: string,
    importer: string,
  ): Resolution | Promise<Resolution> => {
    const settled = settledPaths.get(base);
    if (settled !== undefined) return fileOf(settled, specifier, importer);
    return resolvePath(base).then((answer) => {
      settledPaths.set(base, answer);
      return fileOf(answer, specifier, importer);
    });
  };

  const bare = async (
    specifier: string,
    importer: string,
  ): Promise<Resolution> => {
    if (specifier.startsWith("#")) {
      throw new UnresolvedImportError(
        `"${specifier}" imported by ${importer} is a package-imports specifier: this resolver does not follow one`,
      );
    }
    const entry = await moduleEntry(
      dirname(importer),
      packageNameOf(specifier),
    );
    if (entry === null) {
      if (isImportMapOnlySpecifier(specifier)) {
        return { kind: "import-map", specifier };
      }
      throw new UnresolvedImportError(
        `no node_modules entry for "${specifier}" above ${importer}`,
      );
    }
    const dir = await realpathOf(entry);
    if (!`${dir}${sep}`.includes(NODE_MODULES)) {
      throw new UnresolvedImportError(
        `"${specifier}" imported by ${importer} links to ${dir}, outside every node_modules: repo code this resolver does not follow by package name`,
      );
    }
    return { kind: "package", entry, dir };
  };

  const viaAliases = (
    aliases: Aliases | null,
    specifier: string,
    importer: string,
  ): Resolution | Promise<Resolution> => {
    const aliased = aliases === null ? null : applyAlias(aliases, specifier);
    return aliased !== null
      ? fileAt(aliased, specifier, importer)
      : bare(specifier, importer);
  };

  const moduleEntry = (dir: string, name: string): Promise<string | null> =>
    memo(moduleEntries, `${dir}\0${name}`, async () => {
      const candidate = join(dir, "node_modules", ...name.split("/"));
      try {
        await lstat(candidate);
        return candidate;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      const parent = dirname(dir);
      return parent === dir ? null : moduleEntry(parent, name);
    });

  return {
    resolve(specifier, importer) {
      const from = dirname(importer);
      if (specifier.endsWith("/")) {
        throw new UnresolvedImportError(
          `"${specifier}" imported by ${importer} names a directory by a trailing slash: this resolver does not follow one`,
        );
      }
      if (
        specifier.startsWith("./") ||
        specifier.startsWith("../") ||
        specifier === "." ||
        specifier === ".."
      ) {
        return fileAt(join(from, specifier), specifier, importer);
      }
      if (isAbsolute(specifier)) return fileAt(specifier, specifier, importer);
      if (settledAliases.has(from)) {
        return viaAliases(settledAliases.get(from)!, specifier, importer);
      }
      return aliasesFor(from).then((aliases) => {
        settledAliases.set(from, aliases);
        return viaAliases(aliases, specifier, importer);
      });
    },
  };
}

/** A JSON file the resolver reads, a malformed one being a refusal like any other. */
function parseJson(path: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new UnresolvedImportError(`${path} is not JSON: ${err.message}`, {
      cause: err,
    });
  }
}

/** `x.js` → its TypeScript twins; none for any other extension. */
function twinsOf(base: string): string[] {
  for (const [ext, twins] of Object.entries(TS_TWINS)) {
    if (base.endsWith(ext)) {
      const stem = base.slice(0, -ext.length);
      return twins.map((t) => stem + t);
    }
  }
  return [];
}

/** The package name a bare specifier imports (`@scope/name/sub` → `@scope/name`). */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

async function readAliases(root: string): Promise<Aliases> {
  const raw = await readFile(join(root, TSCONFIG_BASE), "utf8");
  const paths = (
    parseJson(join(root, TSCONFIG_BASE), raw) as {
      compilerOptions?: { paths?: Record<string, readonly string[]> };
    }
  ).compilerOptions?.paths;
  const prefixes: [string, string][] = [];
  const exact = new Map<string, string>();
  for (const [key, targets] of Object.entries(paths ?? {})) {
    if (targets.length !== 1) {
      throw new UnresolvedImportError(
        `${join(root, TSCONFIG_BASE)} maps "${key}" to ${targets.length} targets: this resolver follows exactly one`,
      );
    }
    const target = join(root, targets[0]!);
    if (key.endsWith("*")) {
      if (!targets[0]!.endsWith("*")) {
        throw new UnresolvedImportError(
          `${join(root, TSCONFIG_BASE)} maps "${key}" to a target without "*"`,
        );
      }
      prefixes.push([key.slice(0, -1), target.slice(0, -1)]);
    } else exact.set(key, target);
  }
  // Longest prefix first, as TypeScript and Bun pick among overlapping ones.
  prefixes.sort((a, b) => b[0].length - a[0].length);
  return { prefixes, exact };
}

function applyAlias(aliases: Aliases, specifier: string): string | null {
  const exact = aliases.exact.get(specifier);
  if (exact !== undefined) return exact;
  for (const [prefix, target] of aliases.prefixes) {
    if (specifier.startsWith(prefix)) {
      return target + specifier.slice(prefix.length);
    }
  }
  return null;
}
