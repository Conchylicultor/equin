import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { buildStructureTreeOnce } from "@plugins/plugin-meta/plugins/plugin-tree/plugins/structure-records/core";
import { standardPluginDirsIn } from "@plugins/framework/plugins/tooling/plugins/collected-dir/plugins/discovery/core";
import {
  packageNameFor,
  RUNTIME_FOLDERS,
  TESTING_FOLDER,
} from "@plugins/framework/plugins/plugin-id/core";
import {
  currentScanView,
  defineFoldCheck,
  type RepoPaths,
} from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { detectCycle } from "./cycle";
import {
  pluginBoundariesFold,
  REGEN_HINT,
  type PluginBoundariesContext,
} from "./plugin-boundaries.scan";
import { collectForeignReexports } from "./reexport-provenance";
import { recordBoundaryReadSet } from "./read-set";
import { selectSourceFiles } from "./source-files";
import { repoTree } from "./repo-tree";
import { collectUnknownDirViolations, type Violation } from "./unknown-dirs";
import { findTestOnlyExports } from "./test-only-exports";

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

/** The runtime folders whose barrel R3 requires (central and machine are optional, shared/ has none). */
const BARREL_RUNTIMES = [
  "web",
  "server",
  "machine",
  "central",
  "core",
] as const;
const OPTIONAL_BARREL_RUNTIMES: ReadonlySet<string> = new Set([
  "central",
  "machine",
]);

/**
 * Every file the per-file rules read: the `.ts`/`.tsx` sources under
 * `plugins/` (./source-files) and every `package.json` there (R1).
 */
function foldedFiles(repo: RepoPaths): string[] {
  const all = repo.all();
  return [
    ...selectSourceFiles(all),
    ...all.filter(
      (p) => p.startsWith("plugins/") && p.endsWith("/package.json"),
    ),
  ].sort();
}

// The check is a fold (`defineFoldCheck`): every rule that reads one file —
// R1, R3's purity, R4–R10, R12, and what R6 / R13 / the re-export chase take
// from each file — is judged per file in ./plugin-boundaries.scan.ts and kept
// along the directory tree, so a pass after an edit judges only the edited
// files. The rules across files (R3's barrel-required and re-export
// provenance, R6's cycle, R11, R13) are decided below from the folded answer
// and the file paths alone: the verdict is handed no `read`.
const check = defineFoldCheck({
  id: "plugin-boundaries",
  description:
    "Plugin module boundaries: barrel purity, cross-plugin import grammar, DAG, package naming, directory structure",
  // INPUT-KEYED via validate-by-replay. Its verdict depends on the membership of
  // the whole plugins/ file set (H3/H9: a NEW source file or plugin dir) and on
  // the content of every .ts/.tsx source and every package.json there; both are
  // recorded (the fold keys every folded file by its blob, through the
  // recording file set, and ./read-set records the same facts explicitly). On
  // the next run they replay against the fresh snapshot, so a change touching
  // none of them (an unrelated docs/asset edit, most push-rebases) is a HIT.
  inputKeyed: true,
  exemptable: {
    "plugin-boundaries":
      "bypasses the cross-plugin import rules (grammar, default-import, inline-import, shared) — a framework file that wires plugin registries",
  },
  files: foldedFiles,
  async context(ctx): Promise<PluginBoundariesContext> {
    // Record the read-set (no-op when not input-keyed). Pure snapshot
    // projection — spawns nothing, reads no bytes.
    const view = currentScanView();
    if (view) recordBoundaryReadSet(view);
    const repo = await ctx.repo();
    if (repo.under("plugins").length === 0) return { plugins: [] };
    const tree = await buildStructureTreeOnce(
      joinAppPath(repo.root, "plugins"),
      repo,
    );
    return {
      plugins: [...tree.byDir.values()]
        .map((n) => [n.path, n.compositionRoot] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    };
  },
  // The standard plugin folder names (R11), derived generically (collected-dir
  // registry + fixed structural conventions), not hardcoded here.
  facts: async (ctx) => standardPluginDirsIn(await ctx.repo()),
  fold: pluginBoundariesFold,
  async verdict(folded, { context, facts: known }, ctx) {
    const repoFiles = await ctx.repo();
    const repo = repoTree(repoFiles.all());
    const pluginSet = new Set(context.plugins.map(([path]) => path));
    const exempt = await ctx.exempt("plugin-boundaries");
    const violations: Violation[] = [];

    // Composition roots (the SPA bootstrap / CLI entry) self-declare via the
    // package.json `equin.compositionRoot` marker. They are exempt from
    // structural conformance (R1 package naming, R3 required barrel, R11 unknown
    // dirs) but still subject to the per-file import grammar (R4–R10).
    const structural = context.plugins
      .filter(([, root]) => !root)
      .map(([path]) => path);

    // R1: a plugin with no package.json (one that has one is judged per file).
    for (const p of structural) {
      const relPkg = `plugins/${p}/package.json`;
      if (repoFiles.has(relPkg)) continue;
      violations.push({
        rule: "package",
        file: relPkg,
        message: "plugin is missing package.json",
        fix: `${REGEN_HINT} — it creates the file with the derived name (\`"${packageNameFor(p)}"\`)`,
      });
    }

    // R11: reject unrecognized top-level directories inside plugin folders
    const allPluginRelPaths = context.plugins.map(([path]) => path);
    for (const p of structural)
      violations.push(
        ...collectUnknownDirViolations({
          pluginRelPath: p,
          allPluginRelPaths,
          known,
          repo,
        }),
      );

    // R3: every runtime folder holding TypeScript has its barrel, and no
    // barrel surfaces another plugin's name (followed through the folded
    // re-exports). Purity is judged per file. A runtime dir "exists" iff the
    // run's git-derived file set holds a file under it (./repo-tree).
    const reexports = (barrelRel: string, ownPlugin: string) =>
      collectForeignReexports({
        barrelRel,
        ownPlugin,
        pluginSet,
        exportsOf: (rel) =>
          Object.hasOwn(folded.exports, rel) ? folded.exports[rel] : undefined,
        exists: (rel) => repoFiles.has(rel),
      });
    for (const p of structural) {
      const pluginRel = `plugins/${p}`;
      for (const runtime of BARREL_RUNTIMES) {
        if (!repo.subdirs(pluginRel).has(runtime)) continue;
        const barrelRel = `${pluginRel}/${runtime}/index.ts`;
        if (repoFiles.has(barrelRel)) {
          violations.push(...reexports(barrelRel, p));
          continue;
        }
        if (
          !OPTIONAL_BARREL_RUNTIMES.has(runtime) &&
          repo.containsTsFiles(`${pluginRel}/${runtime}`)
        )
          violations.push({
            rule: "barrel-required",
            file: `${pluginRel}/${runtime}/`,
            message: `missing \`index.ts\` barrel in \`${runtime}/\``,
            fix: `create \`${pluginRel}/${runtime}/index.ts\` — the barrel is the only legal cross-plugin entry point for this runtime`,
          });
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
        if (repoFiles.has(barrelRel)) {
          violations.push(...reexports(barrelRel, p));
          continue;
        }
        if (repo.containsTsFiles(testingRel))
          violations.push({
            rule: "barrel-required",
            file: `${testingRel}/`,
            message: `missing \`index.ts\` barrel in \`${runtime}/${TESTING_FOLDER}/\``,
            fix: `create \`${barrelRel}\` — the barrel is the only legal cross-plugin entry point for this runtime's test helpers`,
          });
      }
    }

    // The per-file rules (R1, R3 purity, R4–R10, R12); an exemptable one is
    // dropped for a file the plugin's exemptions cover.
    for (const { exemptable, ...v } of folded.violations)
      if (!exemptable || !exempt.skips(v.file)) violations.push(v);

    // R6: detect cycles — run separately per runtime so web/server/central graphs
    // are never conflated (a cross-runtime path is not a real cycle).
    const edgeList = Object.entries(folded.edges).flatMap(
      ([source, targets]) => {
        const [from, runtime] = source.split("\0");
        return targets.map((to) => ({ from: from!, to, runtime: runtime! }));
      },
    );
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
    violations.push(
      ...findTestOnlyExports(
        new Map(Object.entries(folded.barrels)),
        folded.uses,
      ),
    );

    if (violations.length === 0) return { ok: true };
    return {
      ok: false,
      message: formatViolations(violations),
      hint: PUSH_BACK_HINT,
    };
  },
});

// ============================================================================
// Output formatting
// ============================================================================

const MAX_REPORTED = 15;

/** The order rules are reported in: the rule table's (this plugin's CLAUDE.md). */
const RULE_ORDER = [
  "package",
  "unknown-dir",
  "barrel-required",
  "barrel-purity",
  "cross-plugin-reexport",
  "test-support-in-public-barrel",
  "grammar",
  "default-import",
  "cycle",
  "workspace-import",
  "relative-cross-plugin",
  "inline-import",
  "cross-plugin-internal",
  "shared-use-relative",
  "test-only-public-export",
];

function formatViolations(vs: Violation[]): string {
  const grouped = new Map<string, Violation[]>();
  for (const v of vs) {
    if (!grouped.has(v.rule)) grouped.set(v.rule, []);
    grouped.get(v.rule)!.push(v);
  }
  const rank = (rule: string) => {
    const i = RULE_ORDER.indexOf(rule);
    return i < 0 ? RULE_ORDER.length : i;
  };
  const lines: string[] = [];
  lines.push(`${vs.length} plugin-boundary violation(s):`);
  for (const [rule, list] of [...grouped].sort(
    ([a], [b]) => rank(a) - rank(b),
  )) {
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
