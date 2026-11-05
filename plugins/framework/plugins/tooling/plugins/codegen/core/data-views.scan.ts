import {
  lineAt,
  markerCallSpans,
  maskSource,
  parseStaticCallId,
  unresolvableCallIdMessage,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import type { FileScan } from "@plugins/plugin-meta/plugins/plugin-records/core";

// The data-views generator's per-file scan (`data-views-gen.ts`). A scan's
// records are keyed by its module's whole closure (`FileScan.url`), so this
// module holds the scan and the code it runs, and nothing else.

const DATA_VIEW_MARKER = "defineDataView";

/**
 * Every `defineDataView("<id>")` id in one source file, in source order.
 *
 * The file is FULL-masked (so a marker written inside a comment, string or
 * template literal is never matched) and each id is read back from the ORIGINAL
 * by offset. THROWS — naming `displayPath`, the line, and the offending
 * expression — on a call whose id is not a static string literal. Unlike the slot
 * scanner there is no legitimate unresolvable shape here: `defineDataView` is
 * only ever called, never declared in a plugin's `web/**`, and no factory
 * produces data views. So there is nothing to exempt and no escape hatch.
 */
export function scanDataViewIds(src: string, displayPath: string): string[] {
  const out: string[] = [];
  for (const span of markerCallSpans(maskSource(src), DATA_VIEW_MARKER)) {
    const id = parseStaticCallId(src, span);
    if (id.kind !== "value") {
      throw new Error(
        unresolvableCallIdMessage({
          marker: DATA_VIEW_MARKER,
          file: displayPath,
          line: lineAt(src, span.identifier),
          expr: id.kind === "dynamic" ? id.expr : "",
          hint:
            "The data-views manifest is built from source text, so every id must be a " +
            "literal at the call site — a data view whose id this scanner cannot read " +
            "would silently register no config descriptor and lose its saved views. " +
            "Inline the literal instead of hoisting or interpolating it.",
        }),
      );
    }
    out.push(id.value);
  }
  return out;
}

export const DATA_VIEW_SCAN: FileScan<string[]> = {
  url: import.meta.url,
  scan: (src, rel) =>
    src.includes(DATA_VIEW_MARKER) ? [...scanDataViewIds(src, rel)] : [],
};
