/**
 * The build-owned `// @legend` block of a committed config override: a
 * descriptor's `overrideLegend` lines, stamped directly under the `// @hash`
 * header so whoever opens the file to hand-edit it sees how to write its values
 * — for a reorder slot, that a spacer node exists and what it does.
 *
 * Kept here, next to the review marker, because it is part of the override's
 * on-disk header format; the one writer is the build (codegen's legend stamp and
 * seeder). It is a JSONC comment, so it never reaches the parsed document or its
 * `@hash`.
 */
export const LEGEND_MARKER = "// @legend";

const LEGEND_HEAD = `${LEGEND_MARKER} — how to write this file (rewritten by ./equin build; edits inside this block are lost):`;

// A legend line is indented under the head, which is what marks where the
// block ends — the author's own comments below it use a single space.
const LEGEND_INDENT = "//   ";

const HASH_LINE_RE = /^\/\/ @hash [a-f0-9]+\n/;

/**
 * `fileText` with exactly one current legend block right under its `// @hash`
 * line: any existing block (wherever it sits in the leading comment run) is
 * removed, and `legend` is written in its place. An empty `legend` removes the
 * block. Idempotent. Throws on a hashless file — that file is corrupt, and
 * `config-origins-in-sync` says so by name.
 */
export function withOverrideLegend(
  fileText: string,
  legend: readonly string[],
): string {
  const header = HASH_LINE_RE.exec(fileText);
  if (!header) {
    throw new Error(
      'withOverrideLegend: the file has no leading "// @hash" line to stamp the legend under.',
    );
  }
  const lines = fileText.slice(header[0].length).split("\n");
  const kept: string[] = [];
  let i = 0;
  // Only the leading comment run is the header; the body is never touched.
  while (i < lines.length && lines[i]!.startsWith("//")) {
    if (lines[i]!.startsWith(LEGEND_MARKER)) {
      i++;
      while (i < lines.length && lines[i]!.startsWith(LEGEND_INDENT)) i++;
      continue;
    }
    kept.push(lines[i]!);
    i++;
  }
  const block =
    legend.length === 0
      ? ""
      : [LEGEND_HEAD, ...legend.map((l) => `${LEGEND_INDENT}${l}`)]
          .map((l) => `${l}\n`)
          .join("");
  return header[0] + block + [...kept, ...lines.slice(i)].join("\n");
}
