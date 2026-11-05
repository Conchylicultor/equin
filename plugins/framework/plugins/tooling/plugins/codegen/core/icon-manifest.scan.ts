import {
  findImports,
  lineAt,
  markerCallSpans,
  maskSource,
  parseStaticCallId,
  unresolvableCallIdMessage,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import { isIconRefModule } from "@plugins/ui/plugins/icons/core";
import type { FileScan } from "@plugins/plugin-meta/plugins/plugin-records/core";

// The icon manifest's per-file scan (`icon-manifest-gen.ts`). A scan's records
// are keyed by its module's whole closure (`FileScan.url`), so this module
// holds the scan and the code it runs, and nothing else.

/** Cheap pre-filter: a file with no `symbol(` / `brand(` / `seti(` text draws no icon. */
const MARKER_CALL_RE = /\b(?:symbol|brand|seti)\s*\(/;

const MARKERS = { symbol: "symbols", brand: "brands", seti: "seti" } as const;

export interface IconManifest {
  symbols: string[];
  brands: string[];
  seti: string[];
}

/** Is the call at `index` a member call (`x.symbol(…)`) or a declaration (`function symbol(…)`)? */
function isNotABareCall(masked: string, index: number): boolean {
  const before = masked.slice(Math.max(0, index - 16), index);
  return /\.\s*$/.test(before) || /\bfunction\s+$/.test(before);
}

/** Does the file import the icon constructors, by any spelling? */
function importsIconConstructors(src: string, displayPath: string): boolean {
  return findImports(src).some(
    (imp) => !imp.typeOnly && isIconRefModule(displayPath, imp.specifier),
  );
}

/**
 * The icon names one file's source draws. Throws on a non-literal argument.
 * `displayPath` is repo-relative: relative imports resolve against it.
 */
export function scanIconNames(src: string, displayPath: string): IconManifest {
  const out: IconManifest = { symbols: [], brands: [], seti: [] };
  if (!MARKER_CALL_RE.test(src)) return out;
  if (!importsIconConstructors(src, displayPath)) return out;
  const masked = maskSource(src);
  for (const [marker, list] of Object.entries(MARKERS) as [
    keyof typeof MARKERS,
    keyof IconManifest,
  ][]) {
    for (const span of markerCallSpans(masked, marker)) {
      if (isNotABareCall(masked, span.identifier)) continue;
      const id = parseStaticCallId(src, span);
      if (id.kind !== "value") {
        throw new Error(
          unresolvableCallIdMessage({
            marker,
            file: displayPath,
            line: lineAt(src, span.identifier),
            expr: id.kind === "dynamic" ? id.expr : "",
            hint:
              "The icon manifest is built from source text, so an icon name must be a " +
              "literal at the call site — a name this scanner cannot read would ship no " +
              "sprite symbol and draw an empty box.",
          }),
        );
      }
      out[list].push(id.value);
    }
  }
  return out;
}

export const ICON_SCAN: FileScan<IconManifest> = {
  url: import.meta.url,
  scan: (src, rel) => scanIconNames(src, rel),
};
