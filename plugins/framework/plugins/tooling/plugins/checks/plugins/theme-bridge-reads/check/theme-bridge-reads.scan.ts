import type { FileFold } from "@plugins/plugin-meta/plugins/plugin-records/core";
import { matchBracket } from "@plugins/plugin-meta/plugins/parse-utils/core";

// theme-bridge-reads' per-file work as a fold kept along the directory tree
// (`defineFoldCheck`): what each file declares (its `@theme` bridges) and
// reads (every `var(--color-*)` outside `@theme`), so a pass after an edit
// reads only the edited files. Which reads are of a bridge is cross-file, and
// decided by the check's verdict over the folded answer.

function stripCssComments(src: string): string {
  // Keep the newlines, so a read's line still points at the source.
  return src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
}

/** The interiors of every `@theme` block, and the source with them blanked. */
function splitThemeBlocks(src: string): { themes: string[]; rest: string } {
  const themes: string[] = [];
  let rest = src;
  const re = /@theme\b[^{]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest))) {
    const braceStart = rest.indexOf("{", m.index);
    if (braceStart < 0) break;
    const braceEnd = matchBracket(rest, braceStart, "{", "}");
    if (braceEnd < 0) break;
    const body = rest.slice(braceStart + 1, braceEnd);
    themes.push(body);
    // Blanked line by line, so a read after the block keeps its line.
    rest =
      rest.slice(0, braceStart + 1) +
      body.replace(/[^\n]/g, " ") +
      rest.slice(braceEnd);
    re.lastIndex = braceEnd;
  }
  return { themes, rest };
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

/** One `var(--color-*)` read: where, and which custom property. */
export interface ColorRead {
  rel: string;
  line: number;
  name: string;
}

/** A set of files' bridges (`--color-x` → the runtime var it copies) and reads, in path order. */
export interface ThemeBridgePart {
  bridges: [string, string][];
  /** Reads in plugin CSS (comments stripped, `@theme` interiors blanked). */
  cssReads: ColorRead[];
  /** Reads in `.ts` / `.tsx` (class strings). */
  codeReads: ColorRead[];
}

function readsOf(rel: string, src: string): ColorRead[] {
  return [...src.matchAll(/var\(\s*(--color-[\w-]+)/g)].map((m) => ({
    rel,
    line: lineOf(src, m.index),
    name: m[1]!,
  }));
}

export const themeBridgeFold: FileFold<null, ThemeBridgePart> = {
  url: import.meta.url,
  scan(src, rel) {
    if (!rel.endsWith(".css"))
      return { bridges: [], cssReads: [], codeReads: readsOf(rel, src) };
    const { themes, rest } = splitThemeBlocks(stripCssComments(src));
    const bridges: [string, string][] = [];
    for (const body of themes)
      for (const bm of body.matchAll(
        /(--color-[\w-]+)\s*:\s*var\(\s*(--[\w-]+)\s*\)/g,
      ))
        bridges.push([bm[1]!, bm[2]!]);
    return { bridges, cssReads: readsOf(rel, rest), codeReads: [] };
  },
  combine: (parts) => ({
    bridges: parts.flatMap((p) => p.bridges),
    cssReads: parts.flatMap((p) => p.cssReads),
    codeReads: parts.flatMap((p) => p.codeReads),
  }),
};
