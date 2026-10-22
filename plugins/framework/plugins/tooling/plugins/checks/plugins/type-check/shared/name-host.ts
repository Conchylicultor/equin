// The CompilerHost of one of the two-program type check's programs
// (`./name-run.ts`): a given set of repo source files is SOURCE, and every
// other repo source file is seen through its stored `.d.ts` — its CONTRACT.
//
// What a program holds:
//
//   - its sources, parsed fresh;
//   - the environment — lib, `@types`, `node_modules` declarations, the repo's
//     `.d.ts` and JSON — parsed once per process and shared through
//     `SourceFileCache`;
//   - every repo file and directory as the check's VIEW has it
//     (`./repo-view.ts`: the run's git tree plus its overlay) — never the
//     disk's, so the program reads exactly what the keys hash;
//   - for every module that resolves to a repo source NOT in the set, that
//     file's contract (its raw emitted `.d.ts`), served as a virtual `x.d.ts`
//     BESIDE `x.ts`: the contract's own imports then resolve exactly as the
//     source's do — `./types` to the next contract, a bare specifier to the
//     plugin-local `node_modules`, which a mirror tree cannot reach. A module
//     that resolves to a source in the set is the source, for every importer,
//     a served contract included.

import { createHash } from "crypto";
import { relative } from "path";
import ts from "typescript";
import { isRepoPath, needsContract } from "./keys";
import { viewCompilerHost, type RepoView } from "./repo-view";

const rel = (root: string, abs: string): string =>
  relative(root, abs).split("\\").join("/");

const sha256 = (s: string): string =>
  createHash("sha256").update(s).digest("hex");

/** A contract's name in the store: the hash of its raw `.d.ts` text. */
export const contractHash = (text: string): string => sha256(text).slice(0, 32);

/** The parsed environment, shared by every program in a process. */
export interface SourceFileCache {
  get(key: string, create: () => ts.SourceFile): ts.SourceFile;
}

export function createSourceFileCache(): SourceFileCache {
  const entries = new Map<string, ts.SourceFile>();
  return {
    get(key, create) {
      let sf = entries.get(key);
      if (sf === undefined) entries.set(key, (sf = create()));
      return sf;
    },
  };
}

export interface NameHostInput {
  /** The repo as the check sees it; its root is the program's. */
  view: RepoView;
  options: ts.CompilerOptions;
  /** The repo source files the program checks. */
  sources: ReadonlySet<string>;
  /** The contract (raw `.d.ts`) of a repo source file not in `sources`; throws when unknown. */
  contractOf(path: string): string;
  cache: SourceFileCache;
}

export interface NameHost {
  host: ts.CompilerHost;
  /** Each repo file served as a contract → the hash of the text served. */
  served: Map<string, string>;
  /** The repo path a program file stands for: a contract's source, or itself. */
  repoPathOf(abs: string): string;
  /** The virtual file serving `path`'s contract, to name as a program root. */
  contractRoot(path: string): string;
}

/** `x.ts` / `x.tsx` → `x.d.ts`, beside it. */
export function contractFileName(abs: string): string {
  return abs.replace(/\.(m|c)?tsx?$/, (_, m: string | undefined) =>
    m ? `.d.${m}ts` : ".d.ts",
  );
}

export function createNameHost(input: NameHostInput): NameHost {
  const { view, options, sources, contractOf, cache } = input;
  const root = view.root;
  const base = viewCompilerHost(view, options);
  const canonical = base.getCanonicalFileName;
  const resolutionCache = ts.createModuleResolutionCache(
    root,
    canonical,
    options,
  );
  // Virtual contract file (canonical absolute) → [repo source path, text].
  const virtual = new Map<string, { source: string; text: string }>();
  const served = new Map<string, string>();

  const repoPathOf = (abs: string): string => {
    const v = virtual.get(canonical(abs));
    return v !== undefined ? v.source : rel(root, abs);
  };

  const serve = (target: string): string => {
    const abs = contractFileName(`${root}/${target}`);
    const key = canonical(abs);
    if (virtual.has(key)) return abs;
    const text = contractOf(target);
    virtual.set(key, { source: target, text });
    // The same hash the store names a contract by (`./name-run.ts`).
    served.set(target, contractHash(text));
    return abs;
  };

  const host: ts.CompilerHost = {
    ...base,
    fileExists: (f) => virtual.has(canonical(f)) || base.fileExists(f),
    readFile: (f) => virtual.get(canonical(f))?.text ?? base.readFile(f),
    getSourceFile(fileName, languageVersionOrOptions, onError) {
      const v = virtual.get(canonical(fileName));
      const format =
        typeof languageVersionOrOptions === "object"
          ? `${languageVersionOrOptions.languageVersion}/${languageVersionOrOptions.impliedNodeFormat}`
          : `${languageVersionOrOptions}`;
      if (v !== undefined) {
        return cache.get(
          `contract\0${fileName}\0${format}\0${sha256(v.text)}`,
          () => ts.createSourceFile(fileName, v.text, languageVersionOrOptions),
        );
      }
      const path = rel(root, fileName);
      if (isRepoPath(path) && needsContract(path)) {
        // A source of this program: checked once, never shared.
        return base.getSourceFile(fileName, languageVersionOrOptions, onError);
      }
      // The environment. A dependency is pinned by the lockfile (in the
      // engine); a repo declaration file can change between programs, so it
      // is keyed by its version.
      const text = base.readFile(fileName);
      if (text === undefined) return undefined;
      const version = isRepoPath(path) ? `\0${view.version(path)!}` : "";
      return cache.get(`env\0${fileName}\0${format}${version}`, () =>
        ts.createSourceFile(fileName, text, languageVersionOrOptions),
      );
    },
    writeFile: () => {},
    resolveModuleNameLiterals(literals, containingFile, redirected, opts, sf) {
      return literals.map((lit) => {
        const mode = ts.getModeForUsageLocation(sf, lit, opts);
        const r = ts.resolveModuleName(
          lit.text,
          containingFile,
          opts,
          base,
          resolutionCache,
          redirected,
          mode,
        );
        const resolved = r.resolvedModule;
        if (resolved === undefined) return r;
        const to = rel(root, resolved.resolvedFileName);
        if (!isRepoPath(to) || !needsContract(to) || sources.has(to)) return r;
        return {
          resolvedModule: {
            resolvedFileName: serve(to),
            extension: ts.Extension.Dts,
            isExternalLibraryImport: false,
            resolvedUsingTsExtension: false,
          },
        };
      });
    },
  };
  return { host, served, repoPathOf, contractRoot: serve };
}
