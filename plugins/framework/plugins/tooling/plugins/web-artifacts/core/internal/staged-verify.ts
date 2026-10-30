// Ground-truth verification of the staged dist: re-scan the ACTUAL `.js`/`.mjs`
// files the browser will fetch (through the store symlinks) and verify both
// halves of every import — that its specifier RESOLVES (bare through the import
// map, relative to a real staged file), and that the resolved target actually
// EXPORTS every name the importer binds. Deliberately INDEPENDENT of the
// builders' recorded `meta.json`: the metadata-based coverage check shares its
// scanner with the map assembly, so a scanner blind spot makes the map and the
// check wrong identically (the unscanned-`.mjs`-chunks outage). This pass shares
// no inputs with the planner — it reads the staged bytes.
//
// The link half restores a guarantee the artifact build traded away: because
// cross-plugin imports stay external and an importer's hash excludes its
// target's contents, renaming an export in B leaves A reused-unrebuilt from the
// store, and nothing ever re-reads A against the new B. `type-check` compensates
// only partially (it is skipped by `--skip-checks`, and casts/stale `.d.ts`
// typecheck green while the emitted bytes disagree). This is the whole composed
// fleet's bytes, checked on every build.

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  init as esLexerInit,
  parse as esLexerParse,
} from "es-module-lexer/minimal";
import {
  isBrowserUnreachableDynamic,
  WORKER_LINKED_SUFFIX,
  WORKER_TREE_PREFIX,
} from "../constants";
import { type ImportClause, parseImportClause } from "./import-clause";

export interface StagedModuleIssue {
  specifier: string;
  /** Dist-relative file the import appears in (`artifacts/<link>/<file>`). */
  file: string;
}

export interface StagedLinkFailure extends StagedModuleIssue {
  /** The bound name the resolved target does not export (`default` included). */
  name: string;
}

export interface StagedScanResult {
  /** Bare STATIC imports with no map entry, and relative imports that resolve
   *  to no staged file — both break module evaluation, so the caller
   *  hard-fails. Registry dynamics are included: its loaders ARE the app. */
  failures: StagedModuleIssue[];
  /** Bare DYNAMIC imports with no map entry (browser-unreachable kinds
   *  excluded) — a latent failure if ever invoked, so the caller warns. */
  warnings: StagedModuleIssue[];
  /** STATIC imports whose specifier resolves but whose bound name the target
   *  does not export — a browser `SyntaxError: … does not provide an export
   *  named 'X'` at module evaluation, so the caller hard-fails. */
  linkFailures: StagedLinkFailure[];
  /** Dist-relative staged files carrying an emitted `export *`: their export
   *  set is incomplete, so links INTO them are not verified. The fleet emits
   *  zero of these today — a non-empty list means a builder/vendor change made
   *  part of the fleet unverifiable, so the caller warns loudly. */
  opaqueTargets: string[];
}

/** One staged module's link-relevant surface. */
interface StagedFile {
  exports: Set<string>;
  /** Carries an emitted `export *`: the export set above is a lower bound. */
  opaque: boolean;
}

/** A STATIC import edge whose specifier resolved, joined against its target in
 *  pass 2 (targets are recorded only once every file has been read). */
interface StagedLink {
  specifier: string;
  /** Dist-relative importer. */
  file: string;
  /** Dist-relative target. */
  target: string;
  clause: ImportClause;
}

/**
 * Scan every staged module file under `<stagingDir>/artifacts/` and verify its
 * emitted imports against the composed import map (specifiers) and against the
 * targets' own emitted exports (names). Computed dynamic imports (non-literal
 * specifiers) are unverifiable statically and skipped, matching the builders'
 * scanner.
 */
export async function scanStagedModules(opts: {
  stagingDir: string;
  /** The composed map's `imports` record (specifier → URL). */
  imports: Record<string, string>;
}): Promise<StagedScanResult> {
  await esLexerInit();
  const failures: StagedModuleIssue[] = [];
  const warnings: StagedModuleIssue[] = [];
  const linkFailures: StagedLinkFailure[] = [];
  const files = new Map<string, StagedFile>();
  const links: StagedLink[] = [];
  /** The registry artifact's own module — the importer of every web barrel. */
  let registryFile: string | null = null;
  const artifactsDir = join(opts.stagingDir, "artifacts");
  const realOf = (url: string): string | null => {
    const abs = join(opts.stagingDir, url.slice(1));
    return existsSync(abs) ? realpathSync(abs) : null;
  };

  // Pass 1 — read each staged module once: its exports, and its import edges.
  // A worker tree is a dir of links to artifacts (`worker-link.ts`); each is
  // scanned THROUGH the tree, so its relative imports resolve, and are joined
  // against their targets' exports, exactly as the worker resolves them.
  const roots: Array<{ linkName: string; linkDir: string }> = [];
  for (const linkName of readdirSync(artifactsDir).sort()) {
    const linkDir = join(artifactsDir, linkName);
    // A linked copy is also linked at the top level (so pruners keep it); its
    // relative imports resolve only inside the tree, where it is scanned.
    if (linkName.endsWith(WORKER_LINKED_SUFFIX)) continue;
    if (!linkName.startsWith(WORKER_TREE_PREFIX)) {
      roots.push({ linkName, linkDir });
      continue;
    }
    for (const child of readdirSync(linkDir).sort()) {
      if (child === "meta.json") continue;
      roots.push({
        linkName: join(linkName, child),
        linkDir: join(linkDir, child),
      });
    }
  }
  // Files are keyed by their REAL path, and a real dir is scanned once: a worker
  // tree's `_vendor` is the page's vendor set, and its edges must join the very
  // export sets the page's do — lexing the set twice bought nothing but time.
  const scannedDirs = new Set<string>();
  /** A scanned file's dist-relative name, for reports. */
  const distRelOf = new Map<string, string>();
  for (const { linkName, linkDir } of roots) {
    const realDir = realpathSync(linkDir);
    if (scannedDirs.has(realDir)) continue;
    scannedDirs.add(realDir);
    // The registry's dynamic imports are the app's plugin loaders — as
    // load-bearing as static edges, so a miss is a failure, not a warning.
    const isRegistry = linkName.startsWith("composition-web-registry.");
    for (const dirent of readdirSync(linkDir, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!dirent.isFile()) continue;
      if (!dirent.name.endsWith(".js") && !dirent.name.endsWith(".mjs")) continue;
      const abs = join(dirent.parentPath, dirent.name);
      const distRel = join("artifacts", linkName, abs.slice(linkDir.length + 1));
      const src = readFileSync(abs, "utf8");
      const [imports, exports] = esLexerParse(src, distRel);
      if (isRegistry && dirent.name === "index.js") registryFile ??= distRel;
      const self: StagedFile = { exports: new Set(exports.map((e) => e.n)), opaque: false };
      const real = realpathSync(abs);
      files.set(real, self);
      distRelOf.set(real, distRel);
      for (const imp of imports) {
        const spec = imp.n;
        if (spec === undefined) continue;
        const isDynamic = imp.d >= 0;
        let target: string | null = null;
        // A module the worker link spells to throw when loaded: nothing to resolve.
        if (spec.startsWith("data:")) continue;
        if (spec.startsWith("./") || spec.startsWith("../")) {
          const targetAbs = resolve(dirname(abs), spec);
          if (existsSync(targetAbs) && statSync(targetAbs).isFile()) {
            target = realpathSync(targetAbs);
          } else {
            failures.push({ specifier: spec, file: distRel });
          }
        } else if (spec in opts.imports) {
          // Every map URL is an exact file URL under `/artifacts/`.
          target = realOf(opts.imports[spec]!);
        } else if (!isDynamic || isRegistry) {
          failures.push({ specifier: spec, file: distRel });
        } else if (!isBrowserUnreachableDynamic(spec)) {
          warnings.push({ specifier: spec, file: distRel });
        }
        if (isDynamic) continue; // names aren't statically knowable
        const clause = parseImportClause(src.slice(imp.ss, imp.s));
        if (clause.star) self.opaque = true;
        // An unresolvable specifier is already a failure above: never
        // double-report it as a link failure too.
        if (target !== null && !clause.namespace) links.push({ specifier: spec, file: distRel, target, clause });
      }
    }
  }

  // Pass 2 — join each static edge against its target's emitted export set.
  const opaque = new Set<string>();
  const checkNames = (target: string, importer: string, specifier: string, names: string[]): void => {
    const staged = files.get(target);
    // Not a scanned module (a non-JS or unstaged target): nothing to join
    // against, and the specifier check above already owns real misses.
    if (staged === undefined) return;
    if (staged.opaque) {
      // `export *` makes the target's export set a lower bound, so a "missing"
      // name here would be a false failure. Skip — and say so loudly, rather
      // than building a transitive star union the fleet never exercises.
      opaque.add(distRelOf.get(target) ?? target);
      return;
    }
    for (const name of names) {
      if (!staged.exports.has(name)) linkFailures.push({ specifier, name, file: importer });
    }
  };

  for (const link of links) {
    const names = link.clause.hasDefault ? [...link.clause.names, "default"] : link.clause.names;
    if (names.length > 0) checkNames(link.target, link.file, link.specifier, names);
  }

  // The registry's web-barrel loaders are DYNAMIC (skipped above) and typed
  // `Promise<{ default: unknown }>`, so a barrel that loses its default export
  // is `undefined` at runtime with nothing to catch it. The map alone names
  // every web barrel — assert the default from there.
  for (const [spec, url] of Object.entries(opts.imports)) {
    if (!spec.startsWith("@plugins/") || !spec.endsWith("/web")) continue;
    const target = realOf(url);
    if (target === null) continue; // an unresolvable URL is compose's failure
    checkNames(target, registryFile ?? url, spec, ["default"]);
  }

  return { failures, warnings, linkFailures, opaqueTargets: [...opaque].sort() };
}
