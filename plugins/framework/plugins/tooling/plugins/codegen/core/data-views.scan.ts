import {
  failClosed,
  fileTargetUses,
  literalString,
  unreadableAt,
  type ParsedFile,
  type Unreadable,
} from "@plugins/framework/plugins/tooling/plugins/checks/plugins/source-analysis/core";
import { resolveSpecifier } from "@plugins/plugin-meta/plugins/plugin-records/plugins/specifier/core";
import type { FileScan } from "@plugins/plugin-meta/plugins/plugin-records/core";
import ts from "typescript";

// The data-views generator's per-file scan (`data-views-gen.ts`). A scan's
// records are keyed by its module's whole closure (`FileScan.url`), so this
// module holds the scan and the code it runs, and nothing else.

const DATA_VIEW_MARKER = "defineDataView";

/**
 * The modules `defineDataView` can be imported from, by repo path: the
 * data-view core barrel, the web barrel re-exporting it, and the file
 * defining it (which the plugin's own files reach by a relative path).
 */
const DATA_VIEW_MODULES = [
  "plugins/primitives/plugins/data-view/core/index.ts",
  "plugins/primitives/plugins/data-view/core/internal/define-data-view.ts",
  "plugins/primitives/plugins/data-view/web/index.ts",
] as const;

const isDataViewFile = (path: string): boolean =>
  DATA_VIEW_MODULES.some((m) => path === m || path.endsWith(`/${m}`));

const isDataViewModule = (fromFile: string, spec: string): boolean =>
  resolveSpecifier(fromFile, spec, isDataViewFile) !== null;

/**
 * Sound pre-filter: a file whose text never spells `defineDataView` cannot
 * import it (an import names the export, aliased or not) — unless it imports a
 * namespace (`dv.defineDataView` spells it, `dv[k]` does not), re-exports a
 * whole module, or loads one dynamically — so it is not parsed.
 */
const PREFILTER_RE =
  /\bdefineDataView\b|\*\s*as\b|\bexport\s*\*|\b(?:import|require)\s*\(/;

const HINT =
  "The data-views manifest is the only thing that registers a data view's config " +
  "descriptor, so every `defineDataView` must be called with a literal id where " +
  "it is imported — a view whose id this scan cannot read would register no " +
  "descriptor and throw on its first config read.";

/**
 * Every `defineDataView("<id>")` id in one source file, in source order, read
 * from its syntax tree — not its text.
 *
 * Every reference to `defineDataView` imported from the data-view plugin by any
 * spelling — named, aliased, through a namespace — is classified by the shared
 * source analysis (`fileTargetUses`). Each must be a call whose first argument
 * is a string literal; any other use (passed around, shadowed, a namespace
 * indexed, a re-export outside the data-view plugin's own modules, a hoisted or
 * interpolated id) fails the scan naming every one (`failClosed`), so an id
 * cannot be missed by how its call is written.
 *
 * `displayPath` is repo-relative: relative imports resolve against it.
 */
export function scanDataViewIds(src: string, displayPath: string): string[] {
  const out: string[] = [];
  if (!PREFILTER_RE.test(src)) return out;
  const file: ParsedFile = {
    rel: displayPath,
    sf: ts.createSourceFile(
      displayPath,
      src,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      displayPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    ),
  };
  const uses = fileTargetUses<"defineDataView">(ts, file, {
    imported: (spec, exported) =>
      exported === DATA_VIEW_MARKER && isDataViewModule(displayPath, spec)
        ? "defineDataView"
        : undefined,
    isTargetModule: (spec) => isDataViewModule(displayPath, spec),
  });
  const isOwnModule = isDataViewFile(displayPath);
  const unreadable: Unreadable[] = [...uses.unreadable];
  for (const use of uses.found) {
    if (use.kind === "reexport" || use.kind === "reexport-all") {
      if (!isOwnModule)
        unreadable.push({
          site: use.site,
          reason:
            "`defineDataView` is re-exported: its importers would name it under a module the scan does not read; import it from the data-view plugin instead.",
          text: use.kind === "reexport" ? use.as : `* from "${use.specifier}"`,
        });
      continue;
    }
    if (use.kind === "member-call" || use.call.arguments.length === 0) {
      unreadable.push(
        unreadableAt(
          file,
          use.call,
          "`defineDataView` is not called with an id.",
        ),
      );
      continue;
    }
    const id = literalString(ts, file, use.call.arguments[0]!);
    if (id.kind === "unreadable") unreadable.push(id.unreadable);
    else out.push(id.value);
  }
  failClosed({ found: [], unreadable }, `${HINT} (data-views scan)`);
  return out;
}

/**
 * The data-views manifest's per-file scan. It imports `typescript` itself,
 * never takes it from its caller: the records are keyed by the npm code this
 * module's closure imports.
 */
export const DATA_VIEW_SCAN: FileScan<string[]> = {
  url: import.meta.url,
  scan: (src, rel) => scanDataViewIds(src, rel),
};
