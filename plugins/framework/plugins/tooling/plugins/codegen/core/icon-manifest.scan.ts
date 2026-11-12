import {
  failClosed,
  fileTargetUses,
  literalString,
  unreadableAt,
  type ParsedFile,
} from "@plugins/framework/plugins/tooling/plugins/checks/plugins/source-analysis/core";
import { isIconRefModule } from "@plugins/ui/plugins/icons/plugins/icon-uses/core";
import type { FileScan } from "@plugins/plugin-meta/plugins/plugin-records/core";
import ts from "typescript";
import type TS from "typescript";

// The icon manifest's per-file scan (`icon-manifest-gen.ts`). A scan's records
// are keyed by its module's whole closure (`FileScan.url`), so this module
// holds the scan and the code it runs, and nothing else.

const MARKERS = { symbol: "symbols", brand: "brands", seti: "seti" } as const;
type Marker = keyof typeof MARKERS;

/**
 * Sound pre-filter: a file whose text never spells a constructor's name cannot
 * import one (an import names the export, aliased or not) — unless it imports
 * a namespace, which it may index without spelling one (`icons[k]`), or
 * re-exports a whole module (`export * from`), or loads one dynamically
 * (`import(…)` / `require(…)`) — so it is not parsed.
 */
const MARKER_NAME_RE =
  /\b(?:symbol|brand|seti)\b|\*\s*as\b|\bexport\s*\*|\b(?:import|require)\s*\(/;

const HINT =
  "The icon manifest lists every name a constructor is called with, so an icon " +
  "name must be a literal at the call site — a name the scan cannot read would " +
  "ship no sprite symbol and draw an empty box.";

export interface IconManifest {
  symbols: string[];
  brands: string[];
  seti: string[];
}

function isMarker(name: string): name is Marker {
  return Object.hasOwn(MARKERS, name);
}

/**
 * The icon names one file draws, read from its syntax tree — not its text.
 *
 * Every reference to a constructor (`symbol` / `brand` / `seti`) imported from
 * the icons core by any spelling (`isIconRefModule`) — named, aliased, or
 * through a namespace (`icons.symbol("x")`) — is classified by the shared
 * source analysis (`fileTargetUses`). Each must be a call whose one argument
 * is a string literal (what `icons/literal-icon-name` requires), and its
 * literal is collected wherever the call sits (a spread, an argument, a
 * default). Any other use — passed around, shadowed, a namespace indexed, a
 * re-export outside the icons core's own modules — fails the scan, naming
 * every one (`failClosed`): the scan answers for every reference or refuses,
 * so a name cannot be missed by how its call is written.
 *
 * `displayPath` is repo-relative: relative imports resolve against it.
 */
export function scanIconNames(
  ts: typeof TS,
  src: string,
  displayPath: string,
): IconManifest {
  const out: IconManifest = { symbols: [], brands: [], seti: [] };
  if (!MARKER_NAME_RE.test(src)) return out;
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
  const uses = fileTargetUses<Marker>(ts, file, {
    imported: (spec, exported) =>
      isIconRefModule(displayPath, spec) && isMarker(exported)
        ? exported
        : undefined,
    isTargetModule: (spec) => isIconRefModule(displayPath, spec),
  });
  // The icons core's own modules re-export the constructors (the barrel
  // re-exporting `./icon-ref`): that is the module every import above names.
  const base = displayPath.slice(displayPath.lastIndexOf("/") + 1);
  const isIconModule = isIconRefModule(displayPath, `./${base}`);
  const unreadable = [...uses.unreadable];
  for (const use of uses.found) {
    if (use.kind === "reexport" || use.kind === "reexport-all") {
      if (!isIconModule)
        unreadable.push({
          site: use.site,
          reason:
            "an icon constructor is re-exported: its importers would name it under a module the scan does not read; import it from the icons core instead.",
          text: use.kind === "reexport" ? use.as : `* from "${use.specifier}"`,
        });
      continue;
    }
    if (use.kind === "member-call" || use.call.arguments.length !== 1) {
      unreadable.push(
        unreadableAt(
          file,
          use.call,
          `\`${use.exported}\` is not called with exactly one argument.`,
        ),
      );
      continue;
    }
    const name = literalString(ts, file, use.call.arguments[0]!);
    if (name.kind === "unreadable") unreadable.push(name.unreadable);
    else out[MARKERS[use.key]].push(name.value);
  }
  failClosed({ found: [], unreadable }, `${HINT} (icon manifest scan)`);
  return out;
}

/**
 * The icon manifest's per-file scan. It imports `typescript` itself, never
 * takes it from its caller: the records are keyed by the npm code this
 * module's closure imports, so a parser handed in would run unkeyed. Load this
 * module lazily (`await import`) where `typescript`'s eval cost matters.
 */
export const ICON_MANIFEST_SCAN: FileScan<IconManifest> = {
  url: import.meta.url,
  scan: (src, rel) => scanIconNames(ts, src, rel),
};
