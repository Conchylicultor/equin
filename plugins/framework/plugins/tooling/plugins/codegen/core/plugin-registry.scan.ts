import {
  findImports,
  maskSource,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import type { FileScan } from "@plugins/plugin-meta/plugins/plugin-records/core";

// The registry generator's per-file scans (`plugin-registry-gen.ts`). A
// scan's records are keyed by its module's whole closure (`FileScan.url`), so
// this module holds the scans and the code they run, and nothing else.

function hasDefaultExport(text: string): boolean {
  // Mask comments/regex/strings so a commented-out or string-embedded `export
  // default` can't make an entryless barrel look like an entry. These are pure
  // code-construct detectors — the string interior is never read back.
  const src = maskSource(text);
  return (
    /(^|\n)\s*export\s+default\b/.test(src) ||
    /(^|\n)\s*export\s*\{[^}]*\bdefault\b[^}]*\}/.test(src)
  );
}

export const DEFAULT_EXPORT_SCAN: FileScan<boolean> = {
  url: import.meta.url,
  params: ["default-export"],
  scan: (src) => hasDefaultExport(src),
};
export const IMPORT_SPECIFIER_SCAN: FileScan<string[]> = {
  url: import.meta.url,
  params: ["import-specifiers"],
  scan: (src) => findImports(src).map((imp) => imp.specifier),
};
