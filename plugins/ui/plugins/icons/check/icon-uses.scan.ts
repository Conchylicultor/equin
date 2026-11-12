import { parseForESLint } from "@typescript-eslint/parser";
import type { FileScan } from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  iconUsesIn,
  type IconMarker,
} from "@plugins/ui/plugins/icons/plugins/icon-uses/core";

// The per-file scan behind `icons:manifest-covers-uses`. A scan's records are
// keyed by its module's whole closure (`FileScan.url`), so this module holds
// the scan and the code it runs, and nothing else.

/** One literal icon-constructor call, as ESLint's scope analysis sees it. */
export interface IconUse {
  marker: IconMarker;
  name: string;
  line: number;
}

/**
 * Sound pre-filter: a file whose text never spells a constructor's name cannot
 * import one (an import names the export, aliased or not), so it is not parsed.
 */
const MARKER_NAME_RE = /\b(?:symbol|brand|seti)\b/;

type Keys = Record<string, readonly string[] | undefined>;

/**
 * Link every node to its parent, as ESLint does while it traverses: the parser
 * leaves `parent` unset, and the reader walks from a reference up to its call.
 */
function setParents(root: object, keys: Keys): void {
  const stack: { type: string; parent?: unknown }[] = [
    root as { type: string },
  ];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const key of keys[node.type] ?? []) {
      const value = (node as unknown as Record<string, unknown>)[key];
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child === null || typeof child !== "object" || !("type" in child))
          continue;
        const c = child as { type: string; parent?: unknown };
        c.parent = node;
        stack.push(c);
      }
    }
  }
}

/**
 * Every icon name one file draws, read the way the icons lint rules read it —
 * `@typescript-eslint/parser`'s scope manager following each imported
 * constructor's references (`iconUsesIn`) — and NOT through the manifest
 * generator's TypeScript name walk (`codegen/core/icon-manifest.scan.ts`): the
 * point of this scan is to be a second, independent reading of the same
 * source, so one reader's bug cannot hide in both sides of a comparison.
 *
 * Seam: when checks/core grows a shared TS-program analysis, only this parse
 * changes; `iconUsesIn` stays the reader.
 */
export function scanIconUses(src: string, rel: string): IconUse[] {
  if (!MARKER_NAME_RE.test(src)) return [];
  const { ast, scopeManager, visitorKeys } = parseForESLint(src, {
    filePath: rel,
    sourceType: "module",
    range: true,
    loc: true,
    ecmaFeatures: { jsx: rel.endsWith(".tsx") },
  });
  setParents(ast, visitorKeys);
  const { calls } = iconUsesIn(ast, rel, (node) =>
    scopeManager.getDeclaredVariables(node),
  );
  return calls.map(({ marker, name, call }) => ({
    marker,
    name,
    line: call.loc?.start.line ?? 0,
  }));
}

export const iconUsesScan: FileScan<IconUse[]> = {
  url: import.meta.url,
  scan: scanIconUses,
};
