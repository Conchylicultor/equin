import { findImports } from "@plugins/plugin-meta/plugins/parse-utils/core";
import type { FileFold } from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  PLUGIN_FOLDERS,
  VERIFYING_FOLDERS,
} from "@plugins/framework/plugins/plugin-id/core";
import { parseRuntimeException } from "@plugins/framework/plugins/tooling/plugins/boundaries/plugins/runtime-exception/core";
import boundaryConfig from "./boundary-config";
import { evaluateEdges, judgeImport } from "./evaluate";
import { buildZoneMap, type UnfolderedReason, type ZoneMap } from "./resolve";

// `boundary-rules`' per-file judgement as a fold kept along the directory tree
// (`plugin-records`' `foldFilesCached`): one file's violations and the
// cross-plugin edges it realizes, folded per directory — so a pass after an
// edit judges the edited files only, and every other directory is one lookup.
// Its records are keyed by this module's whole closure, so it holds the
// judgement and the code it runs, and nothing else.

export interface Violation {
  file: string;
  message: string;
  fix?: string;
}

/** What the judgement reads besides the file: every plugin's directory under `plugins/` and its id. */
export type BoundaryContext = {
  plugins: readonly (readonly [path: string, id: string])[];
};

/** One file's, or one directory's, part of the verdict. */
export interface BoundaryPart {
  violations: Violation[];
  /** Allowed cross-plugin edges (`<zone>.<folder>\0<zone>.<folder>`), sorted, unique: the cycle graph's. */
  edges: string[];
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

const LEGAL_FOLDERS = `${PLUGIN_FOLDERS.join(", ")}, or a child plugin under plugins/`;

const UNFOLDERED_WHY: Record<UnfolderedReason, (name: string) => string> = {
  "loose-file": (name) =>
    name ? `loose file "${name}" at the plugin root` : "the plugin root itself",
  "unknown-folder": (name) => `folder "${name}/" is not a plugin folder`,
  "not-in-child-plugin": () => "under plugins/ but inside no child plugin",
  "misplaced-testing": (name) =>
    `"${name}/" — a testing/ folder sits directly under a runtime folder (not e2e/), e.g. core/testing/`,
};

const RUNTIME_EXCEPTIONS: ReadonlySet<string> = new Set(
  (boundaryConfig.runtimeExceptions ?? []).map((expr) => {
    const { source, target } = parseRuntimeException(expr);
    return `${source}\0${target}`;
  }),
);

// One zone map per context: the fold hands every scan the same parsed object.
const zoneMaps = new WeakMap<BoundaryContext, ZoneMap>();
function zoneMapOf(context: BoundaryContext): ZoneMap {
  let map = zoneMaps.get(context);
  if (!map) {
    map = buildZoneMap(boundaryConfig.zones, {
      byDir: new Map(context.plugins.map(([path, id]) => [path, { id, path }])),
    });
    zoneMaps.set(context, map);
  }
  return map;
}

/** One file's violations and realized edges. */
export function judgeFile(
  src: string,
  relFile: string,
  context: BoundaryContext,
): BoundaryPart {
  const config = boundaryConfig;
  const zoneMap = zoneMapOf(context);
  const violations: Violation[] = [];
  const edges = new Set<string>();
  const source = zoneMap.resolveFile(relFile);
  if (source.kind === "outside") return { violations, edges: [] };

  // Every file inside a plugin sits in a folder with a row. One that does not
  // has no rule to read its imports against, so it is the violation, and its
  // imports are not evaluated.
  if (source.kind === "unfoldered") {
    violations.push({
      file: relFile,
      message: `no plugin folder: ${UNFOLDERED_WHY[source.why](source.name)} (${source.zone})`,
      fix:
        source.why === "misplaced-testing"
          ? `move the test helpers to <runtime>/testing/ (e.g. core/testing/index.ts), imported as @plugins/<plugin>/<runtime>/testing`
          : `move it into one of the plugin's folders: ${LEGAL_FOLDERS}. A new kind of folder is declared in plugin-id/core (LEAF_FOLDERS) with its row in boundary-config.ts`,
    });
    return { violations, edges: [] };
  }

  for (const specifier of extractImports(src)) {
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
    // inside the plugin (`core/` reaching its own `../server/x`): a folder may
    // import the same folders whichever plugin they belong to. Test code is
    // gated first: only code that verifies may import it.
    const verdict = judgeImport(
      config.folders,
      RUNTIME_EXCEPTIONS,
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

    // Allow/deny edges and the cycle graph are about which PLUGINS may depend
    // on each other, so an import inside one plugin stops here.
    if (verdict.kind === "ok") continue;

    const result = evaluateEdges(config.edges, source.zone, target.zone);
    if (result === "allow") {
      edges.add(`${srcLabel}\0${tgtLabel}`);
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
  return { violations, edges: [...edges].sort() };
}

export const boundaryRulesFold: FileFold<BoundaryContext, BoundaryPart> = {
  url: import.meta.url,
  scan: judgeFile,
  combine(parts) {
    if (parts.length === 1) return parts[0]!;
    const edges = new Set<string>();
    for (const p of parts) for (const e of p.edges) edges.add(e);
    return {
      violations: parts.flatMap((p) => p.violations),
      edges: [...edges].sort(),
    };
  },
};
