import { existsSync } from "fs";
import { dirname, join, relative, resolve, sep } from "path";
import { buildStructureTreeOnce } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { standardPluginDirsIn } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { runtimeNames } from "@plugins/framework/plugins/tooling/plugins/boundaries/core";
import {
  packageNameFor,
  RUNTIME_FOLDERS,
  TESTING_FOLDER,
} from "@plugins/framework/plugins/plugin-id/core";
import {
  findImports,
  maskSource,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import { currentScanView } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { createTimeSlicer } from "@plugins/packages/plugins/macrotask-yield/core";
import type {
  Check,
  CheckContext,
  CheckResult,
  RepoFiles,
} from "@plugins/framework/plugins/tooling/core";
import { splitTopLevelStatements } from "./parse";
import { collectForeignReexports } from "./reexport-provenance";
import { recordBoundaryReadSet } from "./read-set";
import { selectSourceFiles } from "./source-files";
import { repoTree } from "./repo-tree";
import { collectUnknownDirViolations } from "./unknown-dirs";
import { findTestSupportInBarrel } from "./test-exports";
import {
  barrelExportNames,
  collectBarrelUses,
  findTestOnlyExports,
  type BarrelUse,
} from "./test-only-exports";

// Files that may bypass the cross-plugin import rules (grammar R4, default-import
// R5, inline-import R9, shared R10) are declared in their own plugin's
// `exempt/index.ts` (rule `plugin-boundaries`) — App.tsx and its test import the
// generated web plugin registry directly (re-exporting from the web-sdk barrel
// would pollute TSC's module graph in server/central tsconfigs via transitive
// import chains). Generated files (*.generated.ts) are exempt from R9 by name:
// they use dynamic import() by design.

const PUSH_BACK_HINT =
  "Do NOT work around these violations by editing `plugin-boundaries.ts`, expanding the skip list, " +
  "or adding ad-hoc exceptions. Plugin module boundaries are load-bearing infrastructure. " +
  "If you believe a rule is too strict or blocking a legitimate case, STOP and report it — " +
  "we'll iterate on the design together. Don't take initiative here.";

// ============================================================================
// Entry point
// ============================================================================

interface PluginDir {
  /** Relative path from `plugins/` root, e.g. "conversations/plugins/conversation-view". */
  relPath: string;
  /** Last path segment, e.g. "conversation-view". */
  name: string;
  /** Self-declared composition root (package.json `singularity.compositionRoot`). */
  compositionRoot: boolean;
}

interface Violation {
  rule: string;
  file: string;
  message: string;
  fix?: string;
}

const check: Check = {
  id: "plugin-boundaries",
  description:
    "Plugin module boundaries: barrel purity, cross-plugin import grammar, DAG, package naming, directory structure",
  // INPUT-KEYED via validate-by-replay (Stage 3). run() records EVERY input its
  // verdict depends on — membership of the whole plugins/ file set (H3/H9: a NEW
  // source file or plugin dir) + the content of every .ts/.tsx source and every
  // package.json — into the recording FileSystemView. On the next run those facts
  // replay against the fresh snapshot, so a change touching NONE of them (an
  // unrelated docs/asset edit, most push-rebases) is a HIT that skips the whole
  // tree walk. See ./read-set for the completeness argument and the sourceHash
  // widening that pins buildPluginTree's own logic.
  inputKeyed: true,
  exemptable: {
    "plugin-boundaries":
      "bypasses the cross-plugin import rules (grammar, default-import, inline-import, shared) — a framework file that wires plugin registries",
  },
  async run(ctx: CheckContext): Promise<CheckResult> {
    // Record the read-set (no-op on the legacy whole-tree path, where the view is
    // null). Pure snapshot projection — spawns nothing, reads no bytes — so it is
    // cheap even though it runs on the MISS path before the walk.
    const view = currentScanView();
    if (view) recordBoundaryReadSet(view);

    const root = await getWorktreeRoot();
    const pluginsRoot = join(root, "plugins");
    if (!existsSync(pluginsRoot)) return { ok: true };

    // ONE shared file-set read per run, from the run itself — never a private
    // `listRepoFiles` call. `repoFiles` is the RepoFiles handle (has/under/all/
    // read); `repo` is the local directory-shaped view over the same file list
    // (subdirs/containsTsFiles — see ./repo-tree).
    const repoFiles = await ctx.repo();
    const allFiles = repoFiles.all();
    const repo = repoTree(allFiles);

    const tree = await buildStructureTreeOnce(pluginsRoot);
    const plugins: PluginDir[] = Array.from(tree.byDir.values()).map(
      (node) => ({
        relPath: node.path,
        name: node.name,
        compositionRoot: node.compositionRoot,
      }),
    );
    const pluginSet = new Set(plugins.map((p) => p.relPath));
    const exempt = await ctx.exempt("plugin-boundaries");
    const violations: Violation[] = [];

    // The check thread is shared by every other check in the pass. Yield to the
    // event loop every ~10ms of CPU (never a microtask — a macrotask boundary is
    // what actually admits queued timers/IO) so a whole-tree pass here cannot
    // stall the run the way the old readdirSync/readFileSync/existsSync calls did.
    const maybeYield = createTimeSlicer();

    // The set of standard plugin folder names is derived generically (collected-dir
    // registry + fixed structural conventions), not hardcoded here. R11 uses it.
    const known = await standardPluginDirsIn(repoFiles);

    // Composition roots (the SPA bootstrap / CLI entry) self-declare via the
    // package.json `singularity.compositionRoot` marker. They are exempt from
    // structural conformance (R1 package naming, R3 required barrel, R11 unknown
    // dirs) but still subject to the per-file import grammar (R4–R10).

    // R1: package.json naming
    for (const p of plugins) {
      if (p.compositionRoot) continue;
      await checkPackageNaming(p, violations, repoFiles);
      await maybeYield();
    }

    // R11: reject unrecognized top-level directories inside plugin folders
    const allPluginRelPaths = plugins.map((p) => p.relPath);
    for (const p of plugins) {
      if (p.compositionRoot) continue;
      violations.push(
        ...collectUnknownDirViolations({
          pluginRelPath: p.relPath,
          allPluginRelPaths,
          known,
          repo,
        }),
      );
    }

    // R3: barrel purity + existence for every runtime folder
    // web/server/core must have index.ts when the directory contains TS files.
    // central and machine are optional (not all plugins target those runtimes).
    // shared/ is excluded — it uses relative imports, not barrels.
    for (const p of plugins) {
      if (p.compositionRoot) continue;
      const pluginRel = `plugins/${p.relPath}`;
      for (const runtime of [
        "web",
        "server",
        "machine",
        "central",
        "core",
      ] as const) {
        // A runtime dir "exists" iff the run's git-derived file set holds at
        // least one file under it — never `existsSync`, which also sees a
        // gitignored directory the read-set recorded above cannot cover. See
        // ./repo-tree and the plugin's own CLAUDE.md.
        if (!repo.subdirs(pluginRel).has(runtime)) continue;
        const barrelRel = `${pluginRel}/${runtime}/index.ts`;
        if (!repoFiles.has(barrelRel)) {
          if (
            runtime !== "central" &&
            runtime !== "machine" &&
            repo.containsTsFiles(`${pluginRel}/${runtime}`)
          ) {
            violations.push({
              rule: "barrel-required",
              file: `${pluginRel}/${runtime}/`,
              message: `missing \`index.ts\` barrel in \`${runtime}/\``,
              fix: `create \`${pluginRel}/${runtime}/index.ts\` — the barrel is the only legal cross-plugin entry point for this runtime`,
            });
          }
          continue;
        }
        await checkBarrelPurity(barrelRel, violations, repoFiles);
        // R12: test helpers go in `<runtime>/testing/`, never the public barrel.
        violations.push(
          ...findTestSupportInBarrel(
            barrelRel,
            (await repoFiles.read(barrelRel)) ?? "",
          ),
        );

        // Name-level cross-plugin re-export detection (direct + indirect chains
        // + import-then-reexport). Single source of truth for the
        // `cross-plugin-reexport` rule; the old inline branch is removed.
        for (const v of await collectForeignReexports({
          barrelRel,
          ownPlugin: p.relPath,
          pluginSet,
          readFile: (relPath) => repoFiles.read(relPath),
        })) {
          violations.push(v);
        }
        await maybeYield();
      }

      // R3 for testing barrels: `<runtime>/testing/index.ts` is how a plugin
      // publishes test helpers (`@plugins/<p>/<runtime>/testing`), so it is a
      // barrel like `<runtime>/index.ts` — required once the folder holds
      // TypeScript, pure, and never proxying another plugin's symbols.
      // `shared/testing` is plugin-private (reached relatively), and `e2e/`
      // hosts no `testing/` (boundary-rules reports one).
      for (const runtime of RUNTIME_FOLDERS) {
        if (runtime === "e2e" || runtime === "shared") continue;
        const runtimeRel = `${pluginRel}/${runtime}`;
        if (!repo.subdirs(runtimeRel).has(TESTING_FOLDER)) continue;
        const testingRel = `${runtimeRel}/${TESTING_FOLDER}`;
        const barrelRel = `${testingRel}/index.ts`;
        if (!repoFiles.has(barrelRel)) {
          if (repo.containsTsFiles(testingRel)) {
            violations.push({
              rule: "barrel-required",
              file: `${testingRel}/`,
              message: `missing \`index.ts\` barrel in \`${runtime}/${TESTING_FOLDER}/\``,
              fix: `create \`${barrelRel}\` — the barrel is the only legal cross-plugin entry point for this runtime's test helpers`,
            });
          }
          continue;
        }
        await checkBarrelPurity(barrelRel, violations, repoFiles);
        for (const v of await collectForeignReexports({
          barrelRel,
          ownPlugin: p.relPath,
          pluginSet,
          readFile: (relPath) => repoFiles.read(relPath),
        })) {
          violations.push(v);
        }
        await maybeYield();
      }
    }

    // R13 inputs: every public runtime barrel (`<runtime>/index.ts`, never
    // `testing/`) with the names it publishes. Uses are collected in the
    // per-file loop below.
    const publicBarrels = new Map<string, string[]>();
    for (const p of plugins) {
      for (const runtime of RUNTIME_FOLDERS) {
        if (runtime === "shared") continue;
        const barrelRel = `plugins/${p.relPath}/${runtime}/index.ts`;
        if (!repoFiles.has(barrelRel)) continue;
        publicBarrels.set(
          barrelRel,
          barrelExportNames((await repoFiles.read(barrelRel)) ?? ""),
        );
      }
    }
    const barrelSet = new Set(publicBarrels.keys());
    const barrelUses: BarrelUse[] = [];

    // R4 + R5 + R6 + R7: read every source file, extract cross-plugin imports.
    // The file set comes from git (see ./source-files) — the check is
    // inputKeyed, so the set it scans must be the set its cache key represents.
    const sourceFiles = selectSourceFiles(allFiles);
    const edges = new Set<string>();

    for (const relFile of sourceFiles) {
      const absFile = join(root, relFile);
      const sourcePlugin = pluginForPath(relFile, pluginSet);

      const src = await repoFiles.read(relFile);
      if (!src) continue;

      // R13: which public-barrel names this file takes.
      barrelUses.push(...collectBarrelUses(relFile, src, barrelSet));

      // R7: forbid direct workspace-name imports (`@singularity/plugin-*`).
      // Cross-plugin imports must go through `@plugins/...` so R4/R5/R6 can
      // see them; workspace-name imports resolve via node_modules symlinks
      // and silently bypass the boundary system.
      for (const wsPath of extractWorkspaceImports(src)) {
        violations.push({
          rule: "workspace-import",
          file: relFile,
          message: `direct workspace import \`${wsPath}\` bypasses the boundary system`,
          fix: `replace with the path-alias form \`@plugins/<path-to-plugin>/<runtime>\` (R4/R5/R6 only see those)`,
        });
      }

      // R8: forbid relative imports that escape the source plugin into a
      // different plugin's tree. Same motivation as R7 — relative paths
      // resolve outside the `@plugins/...` alias system, so R4/R5/R6 can't
      // see them, and a sub-plugin reaching `../../../../web/components/foo`
      // into its parent's internals silently bypasses every barrier.
      if (sourcePlugin) {
        for (const relImp of extractRelativeImports(src)) {
          const resolvedAbs = resolve(dirname(absFile), relImp);
          const resolvedRel = relative(root, resolvedAbs).split(sep).join("/");
          const targetPlugin = pluginForPath(resolvedRel, pluginSet);
          if (!targetPlugin || targetPlugin === sourcePlugin) continue;
          violations.push({
            rule: "relative-cross-plugin",
            file: relFile,
            message: `relative import \`${relImp}\` reaches into a different plugin (\`${targetPlugin}\`)`,
            fix: `cross-plugin imports must go through the barrel — replace with \`@plugins/${targetPlugin}/<runtime>\` and re-export the symbol from that plugin's \`index.ts\` if it isn't already public`,
          });
        }
      }

      // R9: forbid inline import-type expressions targeting plugin barrels. They
      // bypass the static import scanner and make cross-plugin deps invisible to
      // the boundary system. Use a top-level `import type { X } from "…"` instead.
      // Framework files (plugin registries) are exempt — their dynamic imports
      // are the resilient-loading mechanism, not accidental boundary bypasses.
      if (!relFile.endsWith(".generated.ts")) {
        for (const inlinePath of extractInlineImports(src)) {
          const resolved = resolveImport(inlinePath, pluginSet);
          if (!resolved) continue;
          if (sourcePlugin && sourcePlugin === resolved.pluginPath) continue;
          if (exempt.skips(relFile)) continue;
          violations.push({
            rule: "inline-import",
            file: relFile,
            message: `inline \`import("${inlinePath}")\` type expression bypasses the boundary system`,
            fix: `replace with a top-level import type statement: \`import type { … } from "${inlinePath}"\``,
          });
        }
      }

      const imports = extractPluginImports(src);

      for (const imp of imports) {
        const resolved = resolveImport(imp.path, pluginSet);
        if (!resolved) continue;

        // Intra-plugin imports (source is the same plugin) are unrestricted
        // here, EXCEPT: shared/ must use relative paths, not the @plugins
        // alias. Which own folder a runtime may reach is `boundary-rules`'
        // job — it applies the runtime table inside a plugin too.
        if (sourcePlugin === resolved.pluginPath) {
          if (resolved.suffixHead === "shared") {
            violations.push({
              rule: "shared-use-relative",
              file: relFile,
              message: `use a relative import instead of \`${imp.path}\``,
              fix: `shared/ is plugin-private — import via relative path (e.g. \`../shared${resolved.tail ? "/" + resolved.tail : ""}\`) instead of the @plugins alias`,
            });
          }
          continue;
        }

        // R10: cross-plugin shared/ imports are forbidden — shared/ is plugin-private.
        if (resolved.suffixHead === "shared" && !exempt.skips(relFile)) {
          violations.push({
            rule: "cross-plugin-internal",
            file: relFile,
            message: `cross-plugin import from \`${imp.path}\` — shared/ is plugin-private`,
            fix: `if \`${resolved.pluginPath}\` needs a public API, create a \`core/\` barrel`,
          });
        }

        // Cross-plugin asset imports (e.g. a global `.css` stylesheet) are
        // side-effect references to a non-JS file. They cannot be routed through
        // a JS barrel — a stylesheet is not an exported symbol — so the
        // barrel-grammar rule (R4) doesn't apply. The DAG edge is still tracked
        // below (R6), so a cyclic asset dependency is still caught.
        const isAssetImport =
          imp.kind === "side-effect" && isAssetSpecifier(imp.path);

        // R4: grammar — the import must end at `<runtime>` or at
        // `<runtime>/testing` (the runtime's test-helper barrel), nothing
        // deeper. WHO may import a testing barrel is boundary-rules' job.
        if (
          !isAssetImport &&
          (!runtimeNames.has(resolved.suffixHead) ||
            (resolved.tail !== "" && resolved.tail !== TESTING_FOLDER)) &&
          !exempt.skips(relFile)
        ) {
          violations.push({
            rule: "grammar",
            file: relFile,
            message: `cross-plugin import into non-barrel path: \`${imp.path}\``,
            fix: `import from the plugin's barrel (\`@plugins/${resolved.pluginPath}/${resolved.suffixHead || "<runtime>"}\`, or its \`/${TESTING_FOLDER}\` barrel from test code) and re-export the needed symbol from the target plugin's \`index.ts\` if it isn't already public`,
          });
        }

        // R5: only framework files may pull a plugin's default export across boundaries.
        if (imp.kind === "default" && !exempt.skips(relFile)) {
          violations.push({
            rule: "default-import",
            file: relFile,
            message: `default import from \`${imp.path}\` is not allowed outside the plugin registries`,
            fix: `other plugins may only use named imports. The default export (PluginDefinition) is consumed exclusively by the generated registry files (e.g. \`web.generated.ts\`, \`server.generated.ts\`).`,
          });
        }

        // R6: track DAG edge (deduped), tagged with source file's runtime.
        // Files in tooling folders (lint/, check/) return null runtime — those
        // imports are skipped entirely rather than collapsed to "shared".
        if (sourcePlugin && sourcePlugin !== resolved.pluginPath) {
          const runtime = runtimeForPath(relFile, pluginSet);
          if (runtime !== null) {
            edges.add(`${sourcePlugin}\0${resolved.pluginPath}\0${runtime}`);
          }
        }
      }

      await maybeYield();
    }

    // R6: detect cycles — run separately per runtime so web/server/central graphs
    // are never conflated (a cross-runtime path is not a real cycle).
    const edgeList = Array.from(edges).map((e) => {
      const parts = e.split("\0");
      return {
        from: parts[0]!,
        to: parts[1]!,
        runtime: parts[2] as
          "web" | "server" | "machine" | "central" | "shared",
      };
    });
    // Core/shared code is reachable from every runtime.
    const crossRuntime = (e: { runtime: string }) =>
      e.runtime === "core" || e.runtime === "shared";
    const webEdges = edgeList.filter(
      (e) => e.runtime === "web" || crossRuntime(e),
    );
    // A desktop backend boots `server` and `machine` as ONE plugin graph, so
    // their edges are one cycle graph: server → machine is a boundary error,
    // but machine → server is legal and closes a cycle with server → server.
    const serverEdges = edgeList.filter(
      (e) =>
        e.runtime === "server" || e.runtime === "machine" || crossRuntime(e),
    );
    const centralEdges = edgeList.filter(
      (e) => e.runtime === "central" || crossRuntime(e),
    );
    const cycle =
      detectCycle(webEdges) ??
      detectCycle(serverEdges) ??
      detectCycle(centralEdges);
    if (cycle) {
      violations.push({
        rule: "cycle",
        file: "(cross-plugin graph)",
        message: `cross-plugin import cycle: ${cycle.join(" → ")}`,
        fix: "cycles signal misdrawn boundaries. Extract the shared concept into a separate library plugin (contributions: []) that both plugins import.",
      });
    }

    // R13: a public export only tests import belongs in `<runtime>/testing/`
    // (or nowhere) — see ./test-only-exports.
    violations.push(...findTestOnlyExports(publicBarrels, barrelUses));

    if (violations.length === 0) return { ok: true };

    return {
      ok: false,
      message: formatViolations(violations),
      hint: PUSH_BACK_HINT,
    };
  },
};

function runtimeForPath(
  relFile: string,
  pluginSet: Set<string>,
): string | null {
  const norm = relFile.split(sep).join("/");
  const pluginPath = pluginForPath(relFile, pluginSet);
  if (!pluginPath) return null;
  const afterPlugin = norm.slice(`plugins/${pluginPath}/`.length);
  const segment = afterPlugin.split("/")[0];
  return segment && runtimeNames.has(segment) ? segment : null;
}

/** Return the relative plugin path that owns `relFile`, or null if the file lives outside `plugins/`. */
function pluginForPath(relFile: string, pluginSet: Set<string>): string | null {
  const norm = relFile.split(sep).join("/");
  if (!norm.startsWith("plugins/")) return null;
  const rest = norm.slice("plugins/".length);
  const parts = rest.split("/");
  let best: string | null = null;
  for (let i = 1; i <= parts.length; i++) {
    const candidate = parts.slice(0, i).join("/");
    if (pluginSet.has(candidate)) best = candidate;
  }
  return best;
}

// ============================================================================
// R1: package.json naming
// ============================================================================

// The name is DERIVED (`packageNameFor`) and written by the repo-tree codegen
// (`syncPluginPackageNames`, run by `./singularity build` and
// `./singularity regen-generated`). R1 is its in-sync guard, the same role
// `plugins-registry-in-sync` plays for the registries.

const REGEN_HINT =
  "run `./singularity build` (or `./singularity regen-generated`), which writes the derived name";

async function checkPackageNaming(
  p: PluginDir,
  violations: Violation[],
  repoFiles: RepoFiles,
): Promise<void> {
  const relPkg = `plugins/${p.relPath}/package.json`;
  const expected = packageNameFor(p.relPath);
  const raw = await repoFiles.read(relPkg);
  if (raw === null) {
    violations.push({
      rule: "package",
      file: relPkg,
      message: "plugin is missing package.json",
      fix: `create \`${relPkg}\` with \`"name": "${expected}"\` (bun needs the field; any later drift is fixed by the build)`,
    });
    return;
  }
  let data: { name?: unknown };
  try {
    data = JSON.parse(raw);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    violations.push({
      rule: "package",
      file: relPkg,
      message: "package.json is not valid JSON",
    });
    return;
  }
  if (data.name !== expected) {
    violations.push({
      rule: "package",
      file: relPkg,
      message: `package name is \`${String(data.name)}\`; expected \`${expected}\``,
      fix: REGEN_HINT,
    });
  }
}

// ============================================================================
// R3: barrel purity
// ============================================================================

/**
 * An `index.ts` may only contain:
 *   - import statements
 *   - named re-exports: `export { ... }`, `export { ... } from "..."`, `export type { ... }`
 *   - type/interface aliases: `type X = ...`, `interface X { ... }` (bare or exported)
 *   - exactly one `export default <expression>`
 *
 * `export * from "..."` / `export * as X from "..."` are disallowed because
 * docgen can't follow them to enumerate the public surface — every public
 * name must be written in the barrel. Wrap with a named re-export instead:
 * `import * as X from "./shared"; export { X };`.
 *
 * Any runtime declaration at the top level (`const`, `let`, `var`, `function`, `class`,
 * top-level `await`, control flow) is a violation — it should live in a sibling file
 * (conventionally `shared/`).
 */
async function checkBarrelPurity(
  relPath: string,
  violations: Violation[],
  repoFiles: RepoFiles,
): Promise<void> {
  const raw = await repoFiles.read(relPath);
  if (!raw) return;
  const stmts = splitTopLevelStatements(raw);
  for (const { text, line } of stmts) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (isAllowedBarrelStatement(trimmed)) {
      // Cross-plugin re-export detection (direct, indirect, and
      // import-then-reexport) lives in the name-level provenance resolver
      // (`collectForeignReexports`), invoked separately in the R3 barrel loop.
      continue;
    }
    const head = trimmed.split(/\s+/).slice(0, 3).join(" ");
    if (isWildcardReexport(trimmed)) {
      violations.push({
        rule: "barrel-purity",
        file: `${relPath}:${line}`,
        message: `wildcard re-export in barrel: \`${head}${trimmed.length > head.length ? "…" : ""}\``,
        fix: 'docgen can\'t follow `export *` to enumerate the public surface — every exported name must be written in the barrel. Replace with named re-exports (`export { A, B, type C } from "./shared/foo"`) or namespace: `import * as Foo from "./shared/foo"; export { Foo };`.',
      });
      continue;
    }
    violations.push({
      rule: "barrel-purity",
      file: `${relPath}:${line}`,
      message: `disallowed top-level statement in barrel: \`${head}${trimmed.length > head.length ? "…" : ""}\``,
      fix: "move this code into a sibling file (conventionally `shared/`). Barrels may only contain imports, re-exports, type aliases, and a single `export default`.",
    });
  }
}

function isWildcardReexport(s: string): boolean {
  if (!s.startsWith("export ")) return false;
  const rest = s.slice("export ".length).trimStart();
  if (rest.startsWith("*")) return true;
  if (rest.startsWith("type ")) {
    const afterType = rest.slice("type ".length).trimStart();
    if (afterType.startsWith("*")) return true;
  }
  return false;
}

function isAllowedBarrelStatement(s: string): boolean {
  if (s.startsWith("import ") || s.startsWith("import{")) return true;
  if (s.startsWith("export default")) return true;
  if (s.startsWith("type ") || s.startsWith("interface ")) return true;
  if (s.startsWith("export type ") || s.startsWith("export interface "))
    return true;
  if (s.startsWith("export ")) {
    // Allowed: `export { ... }` (possibly with `from "..."`).
    // Disallowed: `export * from "..."` (docgen can't enumerate wildcard
    //             re-exports), `export const/let/var/function/class/async`.
    const rest = s.slice("export ".length).trimStart();
    if (rest.startsWith("{")) return true;
    return false;
  }
  return false;
}

// ============================================================================
// Import extraction (R4, R5, R6) — UNCHANGED below this point
// ============================================================================

type ImportKind = "default" | "named" | "namespace" | "side-effect";

interface Imp {
  path: string;
  kind: ImportKind;
}

function extractWorkspaceImports(rawSrc: string): string[] {
  return findImports(rawSrc)
    .map((i) => i.specifier)
    .filter((s) => s.startsWith("@singularity/plugin-"));
}

function extractRelativeImports(rawSrc: string): string[] {
  return findImports(rawSrc)
    .map((i) => i.specifier)
    .filter((s) => s.startsWith("./") || s.startsWith("../"));
}

function extractInlineImports(rawSrc: string): string[] {
  const masked = maskSource(rawSrc);
  const results: string[] = [];
  const re = /\bimport\s*\(\s*(["'`])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const openQuoteIdx = m.index + m[0].length - 1;
    const quote = masked[openQuoteIdx]!;
    const closeIdx = masked.indexOf(quote, openQuoteIdx + 1);
    if (closeIdx < 0) continue;
    const spec = rawSrc.slice(openQuoteIdx + 1, closeIdx);
    if (spec.startsWith("@plugins/")) results.push(spec);
  }
  return results;
}

function extractPluginImports(rawSrc: string): Imp[] {
  const results: Imp[] = [];
  for (const imp of findImports(rawSrc)) {
    if (!imp.specifier.startsWith("@plugins/")) continue;
    if (imp.sideEffect) {
      results.push({ path: imp.specifier, kind: "side-effect" });
      continue;
    }
    const body = imp.clause.trim();
    if (!looksLikeImportOrReexport(imp.keyword, body)) continue;
    results.push({
      path: imp.specifier,
      kind: classifyKind(imp.keyword, body),
    });
  }
  return results;
}

const ASSET_EXTENSIONS = [
  ".css",
  ".scss",
  ".sass",
  ".png",
  ".jpg",
  ".jpeg",
  ".svg",
  ".woff",
  ".woff2",
];
function isAssetSpecifier(specifier: string): boolean {
  return ASSET_EXTENSIONS.some((ext) => specifier.endsWith(ext));
}

function looksLikeImportOrReexport(keyword: string, body: string): boolean {
  if (keyword === "import") {
    if (body === "") return true;
    if (/^\*\s+as\s+\w+$/.test(body)) return true;
    if (/^type\s+/.test(body)) {
      const rest = body.replace(/^type\s+/, "");
      return (
        /^\w+$/.test(rest) ||
        /^\{[^}]*\}$/.test(rest) ||
        /^\*\s+as\s+\w+$/.test(rest)
      );
    }
    if (/^\w+$/.test(body)) return true;
    if (/^\{[\s\S]*\}$/.test(body)) return true;
    if (/^\w+\s*,\s*\{[\s\S]*\}$/.test(body)) return true;
    return false;
  }
  if (keyword === "export") {
    if (/^\{[\s\S]*\}$/.test(body)) return true;
    if (/^\*(\s+as\s+\w+)?$/.test(body)) return true;
    if (/^type\s+/.test(body)) {
      const rest = body.replace(/^type\s+/, "");
      return /^\{[\s\S]*\}$/.test(rest) || /^\*(\s+as\s+\w+)?$/.test(rest);
    }
    return false;
  }
  return false;
}

function classifyKind(keyword: string, body: string): ImportKind {
  if (keyword === "export") return "named";
  if (body === "") return "side-effect";
  if (/^\*\s+as\s+\w+$/.test(body)) return "namespace";
  if (/^type\s+\*\s+as\s+\w+$/.test(body)) return "namespace";
  const stripped = body.replace(/^type\s+/, "").trim();
  if (/^\w+(\s*,\s*\{[\s\S]*\})?$/.test(stripped)) return "default";
  return "named";
}

interface ResolvedImport {
  pluginPath: string;
  suffixHead: string;
  tail: string;
}

function resolveImport(
  importPath: string,
  pluginSet: Set<string>,
): ResolvedImport | null {
  if (!importPath.startsWith("@plugins/")) return null;
  const rest = importPath.slice("@plugins/".length);
  const parts = rest.split("/");
  let best = "";
  for (let i = 1; i <= parts.length; i++) {
    const candidate = parts.slice(0, i).join("/");
    if (pluginSet.has(candidate)) best = candidate;
  }
  if (!best) return null;
  const remainder = rest.slice(best.length).replace(/^\//, "");
  if (!remainder) {
    return { pluginPath: best, suffixHead: "", tail: "" };
  }
  const remParts = remainder.split("/");
  return {
    pluginPath: best,
    suffixHead: remParts[0]!,
    tail: remParts.slice(1).join("/"),
  };
}

// ============================================================================
// R6: cycle detection — UNCHANGED
// ============================================================================

function detectCycle(edges: { from: string; to: string }[]): string[] | null {
  const adj = new Map<string, Set<string>>();
  for (const { from, to } of edges) {
    if (!adj.has(from)) adj.set(from, new Set());
    adj.get(from)!.add(to);
  }
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string>();
  const nodes = new Set<string>();
  for (const { from, to } of edges) {
    nodes.add(from);
    nodes.add(to);
  }

  for (const node of nodes) {
    if (color.get(node) !== undefined) continue;
    const stack: Array<{ node: string; iter: Iterator<string> }> = [
      { node, iter: (adj.get(node) ?? new Set<string>()).values() },
    ];
    color.set(node, GRAY);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const step = top.iter.next();
      if (step.done) {
        color.set(top.node, BLACK);
        stack.pop();
        continue;
      }
      const nxt = step.value;
      const col = color.get(nxt) ?? WHITE;
      if (col === GRAY) {
        const path: string[] = [top.node];
        let cur = top.node;
        while (cur !== nxt) {
          const par = parent.get(cur);
          if (par === undefined) break;
          path.push(par);
          cur = par;
        }
        path.push(nxt);
        path.reverse();
        return path;
      }
      if (col === WHITE) {
        color.set(nxt, GRAY);
        parent.set(nxt, top.node);
        stack.push({
          node: nxt,
          iter: (adj.get(nxt) ?? new Set<string>()).values(),
        });
      }
    }
  }
  return null;
}

// ============================================================================
// Output formatting — UNCHANGED
// ============================================================================

const MAX_REPORTED = 15;

function formatViolations(vs: Violation[]): string {
  const grouped = new Map<string, Violation[]>();
  for (const v of vs) {
    if (!grouped.has(v.rule)) grouped.set(v.rule, []);
    grouped.get(v.rule)!.push(v);
  }
  const lines: string[] = [];
  lines.push(`${vs.length} plugin-boundary violation(s):`);
  for (const [rule, list] of grouped) {
    lines.push("");
    lines.push(`  [${rule}] ${list.length} violation(s)`);
    const shown = list.slice(0, MAX_REPORTED);
    for (const v of shown) {
      lines.push(`    ${v.file}: ${v.message}`);
      if (v.fix) lines.push(`      → ${v.fix}`);
    }
    if (list.length > shown.length) {
      lines.push(`    … and ${list.length - shown.length} more`);
    }
  }
  return lines.join("\n");
}

export default check;
