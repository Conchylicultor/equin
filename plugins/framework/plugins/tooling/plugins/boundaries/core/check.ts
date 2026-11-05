import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { existsSync } from "@plugins/packages/plugins/timed-fs/core";
import { buildStructureTreeOnce } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { findImports } from "@plugins/plugin-meta/plugins/parse-utils/core";
import { yieldMacrotask } from "@plugins/packages/plugins/macrotask-yield/core";
import type {
  Check,
  CheckContext,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import {
  PLUGIN_FOLDERS,
  VERIFYING_FOLDERS,
} from "@plugins/framework/plugins/plugin-id/core";
import { parseRuntimeException } from "@plugins/framework/plugins/tooling/plugins/boundaries/plugins/runtime-exception/core";
import type { BoundaryConfig } from "./types";
import { buildZoneMap, type UnfolderedReason } from "./resolve";
import { detectCycle, evaluateEdges, judgeImport } from "./evaluate";

const PUSH_BACK_HINT =
  "Do NOT work around boundary violations by editing the boundary check or config " +
  "without understanding the architectural intent. If a rule blocks a legitimate case, " +
  "STOP and report it — we'll iterate on the design together.";

interface Violation {
  file: string;
  message: string;
  fix?: string;
}

// Specifiers the zone map can resolve: the `@plugins/…` alias, and a relative
// path (`./x`, `../server/y`) inside the repo. Every other specifier (bare npm)
// resolves to null downstream, so filtering here is just an early cut.
const ZONE_SPECIFIER_RE = /^(?:@plugins(?:\/|$)|\.\.?\/)/;

function extractImports(rawSrc: string): string[] {
  // `findImports` masks comments/regex AND string interiors, then reads each
  // specifier back by offset — so a `from "@plugins/…"` written inside a string
  // or template literal (test fixture, docs snippet) is never mistaken for a
  // real import, while genuine imports (including in test files) are still caught.
  // It covers `export … from` and `import()` too, and `import type` is read the
  // same as a value import: a type that crosses a runtime is still a dependency.
  return findImports(rawSrc)
    .map((i) => i.specifier)
    .filter((s) => ZONE_SPECIFIER_RE.test(s));
}

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

const LEGAL_FOLDERS = `${PLUGIN_FOLDERS.join(", ")}, or a child plugin under plugins/`;

const UNFOLDERED_WHY: Record<UnfolderedReason, (name: string) => string> = {
  "loose-file": (name) =>
    name ? `loose file "${name}" at the plugin root` : "the plugin root itself",
  "unknown-folder": (name) => `folder "${name}/" is not a plugin folder`,
  "not-in-child-plugin": () => "under plugins/ but inside no child plugin",
  "misplaced-testing": (name) =>
    `"${name}/" — a testing/ folder sits directly under a runtime folder (not e2e/), e.g. core/testing/`,
};

export function createBoundaryCheck(config: BoundaryConfig): Check {
  return {
    id: "boundary-rules",
    description:
      "Zone-DAG boundary rules: runtime isolation + zone-level default-deny import restrictions",
    async run(ctx: CheckContext): Promise<CheckResult> {
      const root = await getWorktreeRoot();
      const pluginsRoot = joinAppPath(root, "plugins");

      const pluginTree = existsSync(pluginsRoot)
        ? await buildStructureTreeOnce(pluginsRoot, await ctx.repo())
        : null;
      const zoneMap = buildZoneMap(root, config.zones, pluginTree);

      const rtExceptions = new Set<string>();
      for (const expr of config.runtimeExceptions ?? []) {
        const { source, target } = parseRuntimeException(expr);
        rtExceptions.add(`${source}\0${target}`);
      }

      const excludeSet = new Set(config.exclude ?? []);
      const violations: Violation[] = [];
      const realizedEdges = new Set<string>();

      // The candidate set is the run's shared file set (never a private
      // listing) — every `.ts`/`.tsx` git lists, tracked + untracked-not-
      // ignored, exactly the universe the check cache key is built from. The
      // zone config alone decides which of them are in scope
      // (`zoneMap.resolveFile`).
      const repo = await ctx.repo();
      const candidateFiles = repo
        .all()
        .filter((p) => p.endsWith(".ts") || p.endsWith(".tsx"));

      // Yield to the event loop every ~10ms of CPU so this whole-tree scan can't
      // stall the shared check-runner thread (never a microtask — see
      // yieldMacrotask).
      let lastYield = performance.now();

      for (const relFile of candidateFiles) {
        if (excludeSet.has(relFile)) continue;

        const source = zoneMap.resolveFile(relFile);
        if (source.kind === "outside") continue;

        // Every file inside a plugin sits in a folder with a row. One that
        // does not has no rule to read its imports against, so it is the
        // violation, and its imports are not evaluated.
        if (source.kind === "unfoldered") {
          violations.push({
            file: relFile,
            message: `no plugin folder: ${UNFOLDERED_WHY[source.why](source.name)} (${source.zone})`,
            fix:
              source.why === "misplaced-testing"
                ? `move the test helpers to <runtime>/testing/ (e.g. core/testing/index.ts), imported as @plugins/<plugin>/<runtime>/testing`
                : `move it into one of the plugin's folders: ${LEGAL_FOLDERS}. A new kind of folder is declared in plugin-id/core (LEAF_FOLDERS) with its row in boundary-config.ts`,
          });
          continue;
        }

        const src = await repo.read(relFile);
        if (!src) continue;

        const imports = extractImports(src);

        for (const specifier of imports) {
          const target = zoneMap.resolveImport(relFile, specifier);
          if (target.kind === "outside") continue;

          if (target.kind === "unfoldered") {
            violations.push({
              file: relFile,
              message: `import lands in no plugin folder: ${UNFOLDERED_WHY[target.why](target.name)} (${target.zone}, import "${specifier}")`,
              fix: `import a plugin folder instead: ${LEGAL_FOLDERS}`,
            });
            continue;
          }

          // The folder table applies to EVERY import, including one that stays
          // inside the plugin (`core/` reaching its own `../server/x`): a folder
          // may import the same folders whichever plugin they belong to. Test
          // code is gated first: only code that verifies may import it.
          const verdict = judgeImport(
            config.folders,
            rtExceptions,
            source,
            target,
          );
          const samePlugin = source.zone === target.zone;
          const srcLabel = `${source.zone}.${source.folder}`;
          const tgtLabel = `${target.zone}.${target.folder}`;
          const where = samePlugin
            ? `same plugin, ${srcLabel} → ${tgtLabel}`
            : `${srcLabel} → ${tgtLabel}`;

          if (verdict.kind === "test-code") {
            violations.push({
              file: relFile,
              message: `test code: shipping code cannot import test code (${where}, import "${specifier}")`,
              fix: `only test files (*.test.ts(x), __tests__/, <runtime>/testing/) and ${VERIFYING_FOLDERS.map((f) => `${f}/`).join(", ")} may import test code. If shipping code needs the helper, it is not a test helper: move it out of test code`,
            });
            continue;
          }

          if (verdict.kind === "runtime") {
            violations.push({
              file: relFile,
              message: `runtime isolation: ${source.folder} cannot import ${target.folder} (${where}, import "${specifier}")`,
              fix: `${source.folder} can only import from [${config.folders[source.folder].join(", ")}]. The channels between folders are core/ (public) and shared/ (plugin-private). If this is legitimate, add a runtimeException in boundary-config.ts`,
            });
            continue;
          }

          // Allow/deny edges and the cycle graph are about which PLUGINS may
          // depend on each other, so an import inside one plugin stops here.
          if (verdict.kind === "ok") continue;

          const result = evaluateEdges(config.edges, source.zone, target.zone);

          if (result === "allow") {
            realizedEdges.add(
              `${source.zone}.${source.folder}\0${target.zone}.${target.folder}`,
            );
            continue;
          }

          const reason =
            result === "deny"
              ? "denied by boundary rule"
              : "no allow rule (default-deny)";

          violations.push({
            file: relFile,
            message: `${reason}: ${source.zone} → ${target.zone} (import "${specifier}")`,
            fix:
              result === "default-deny"
                ? `add an allow edge in boundary.config.ts: allow("${source.zone} -> ${target.zone}")`
                : `a deny rule blocks this import. If legitimate, add a specific allow above the deny`,
          });
        }

        if (performance.now() - lastYield > 10) {
          await yieldMacrotask();
          lastYield = performance.now();
        }
      }

      const edgeList = Array.from(realizedEdges).map((e) => {
        const [from, to] = e.split("\0");
        return { from: from!, to: to! };
      });
      const cycle = detectCycle(edgeList);
      if (cycle) {
        violations.push({
          file: "(cross-zone graph)",
          message: `import cycle: ${cycle.join(" → ")}`,
          fix: "cycles signal misdrawn boundaries. Extract the shared concept into a separate plugin that both zones import.",
        });
      }

      if (violations.length === 0) return { ok: true };

      return {
        ok: false,
        message: formatViolations(violations),
        hint: PUSH_BACK_HINT,
      };
    },
  };
}
