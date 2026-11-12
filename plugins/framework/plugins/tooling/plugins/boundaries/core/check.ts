import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { existsSync } from "@plugins/packages/plugins/timed-fs/core";
import { buildStructureTreeOnce } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { foldRepoFiles } from "@plugins/plugin-meta/plugins/plugin-records/core";
import type {
  Check,
  CheckContext,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import boundaryConfig from "./boundary-config";
import { detectCycle } from "./evaluate";
import {
  boundaryRulesFold,
  type BoundaryContext,
  type Violation,
} from "./boundary-rules.scan";

const PUSH_BACK_HINT =
  "Do NOT work around boundary violations by editing the boundary check or config " +
  "without understanding the architectural intent. If a rule blocks a legitimate case, " +
  "STOP and report it — we'll iterate on the design together.";

// The plugin-tree zone's directory: the only files a plugin zone can claim.
const PLUGIN_ZONE_PREFIX = (() => {
  const zone = boundaryConfig.zones.find((z) => z.discover === "plugin-tree");
  return zone ? `${zone.match}/` : null;
})();

const MAX_REPORTED = 15;

function formatViolations(vs: Violation[]): string {
  const lines: string[] = [];
  lines.push(`${vs.length} boundary-rules violation(s):`);
  const shown = vs.slice(0, MAX_REPORTED);
  for (const v of shown) {
    lines.push(`  ${v.file}: ${v.message}`);
    if (v.fix) lines.push(`    → ${v.fix}`);
  }
  if (vs.length > shown.length) {
    lines.push(`  … and ${vs.length - shown.length} more`);
  }
  return lines.join("\n");
}

export const boundaryRulesCheck: Check = {
  id: "boundary-rules",
  description:
    "Zone-DAG boundary rules: runtime isolation + zone-level default-deny import restrictions",
  async run(ctx: CheckContext): Promise<CheckResult> {
    const root = await getWorktreeRoot();
    const pluginsRoot = joinAppPath(root, "plugins");
    const repo = await ctx.repo();

    const pluginTree = existsSync(pluginsRoot)
      ? await buildStructureTreeOnce(pluginsRoot, repo)
      : null;
    const context: BoundaryContext = {
      plugins: pluginTree
        ? [...pluginTree.byDir.values()]
            .map((n) => [n.path, n.id] as const)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        : [],
    };

    // The candidate set is the run's shared file set (never a private
    // listing) — every `.ts`/`.tsx` git lists, tracked + untracked-not-
    // ignored. Only a file under the plugin zone can be judged (the zone map
    // answers `outside` for every other), so the rest is never read.
    const exclude = new Set(boundaryConfig.exclude ?? []);
    const files =
      PLUGIN_ZONE_PREFIX === null
        ? []
        : repo
            .all()
            .filter(
              (p) =>
                (p.endsWith(".ts") || p.endsWith(".tsx")) &&
                p.startsWith(PLUGIN_ZONE_PREFIX) &&
                !exclude.has(p),
            );

    // Judged per file, folded along the directory tree: after an edit only
    // the edited files are read and judged, every other directory's verdict
    // and edges are one record each.
    const { violations, edges } = await foldRepoFiles(
      repo,
      files,
      boundaryRulesFold,
      context,
    );

    const cycle = detectCycle(
      edges.map((e) => {
        const [from, to] = e.split("\0");
        return { from: from!, to: to! };
      }),
    );
    const all = [...violations];
    if (cycle) {
      all.push({
        file: "(cross-zone graph)",
        message: `import cycle: ${cycle.join(" → ")}`,
        fix: "cycles signal misdrawn boundaries. Extract the shared concept into a separate plugin that both zones import.",
      });
    }

    if (all.length === 0) return { ok: true };
    return {
      ok: false,
      message: formatViolations(all),
      hint: PUSH_BACK_HINT,
    };
  },
};
