// Line-level formatting: prettier's changes are applied only where the branch
// changed the file, so a prettier upgrade never reformats lines nobody touched.
//
// The whole file is formatted (prettier needs the whole program; its
// `rangeStart` / `rangeEnd` mode widens to enclosing nodes unpredictably), then
// only the hunks of `content → formatted` that overlap a line the branch changed
// against the merge-base are applied — the `darker` / `git-clang-format` shape.
// Applying a hunk can make prettier want more nearby (a joined line now fits),
// so it repeats until nothing more is selected.
//
// ONE function decides the bytes, and it is a pure function of (content, base):
// the writer (build, `./singularity format`) and the readers (`format-clean`,
// `lint-directives-stable`) call it alike, so "formatted" means the same thing
// to all of them. In particular a file the writer left as `X` is one where the
// reader's `formatInScope(X)` is `X` — the loop stops exactly at that fixed point.

import type { ArrayChange } from "diff";
import type { SourceBytes } from "./prettier";
import { FormatSyntaxError } from "./format-error";

/**
 * Which lines of a file are the branch's to format.
 *
 * `file`: all of it — a file the merge-base does not have (added, untracked),
 * or a member of a coupled set. `lines`: only the lines that differ from
 * `base`, the file's bytes at the merge-base (its rename origin's, for a rename).
 */
export type FormatScope = { kind: "file" } | { kind: "lines"; base: string };

/** A changed file of the branch, with the part of it that is the branch's. */
export interface ChangedFile {
  file: string;
  scope: FormatScope;
}

/**
 * Bounds the fixed-point loop. A file that has not settled by then is formatted
 * whole — a stable answer the readers reproduce (a fully formatted file selects
 * no hunk), never a throw that would block every build touching it.
 */
const MAX_ROUNDS = 8;

/** Memoized DYNAMIC import, for the same reason as prettier's (`./prettier`). */
let diffMod: Promise<typeof import("diff")> | null = null;
function diffLib(): Promise<typeof import("diff")> {
  return (diffMod ??= import("diff"));
}

function lines(text: string): string[] {
  return text.split("\n");
}

/**
 * Per line of `cur`: did the branch change it against `base`? An inserted or
 * rewritten line is changed; a pure deletion marks the lines either side of
 * the gap it left, which is where a reflow it causes lands.
 */
function touchedLines(
  changes: readonly ArrayChange<string>[],
  curLength: number,
): boolean[] {
  const touched = new Array<boolean>(curLength).fill(false);
  let i = 0;
  for (const [j, c] of changes.entries()) {
    const n = c.count ?? c.value.length;
    if (c.added) {
      for (let k = i; k < i + n; k++) touched[k] = true;
      i += n;
    } else if (c.removed) {
      // Removed next to added is a rewrite: the added lines carry it.
      const rewrite =
        changes[j - 1]?.added === true || changes[j + 1]?.added === true;
      if (rewrite) continue;
      if (i > 0) touched[i - 1] = true;
      if (i < curLength) touched[i] = true;
    } else {
      i += n;
    }
  }
  return touched;
}

/** One replacement prettier wants: `cur[start, start + length)` → `replacement`. */
interface Hunk {
  start: number;
  length: number;
  replacement: string[];
}

function hunksOf(changes: readonly ArrayChange<string>[]): Hunk[] {
  const hunks: Hunk[] = [];
  let i = 0;
  let open: Hunk | null = null;
  for (const c of changes) {
    const n = c.count ?? c.value.length;
    if (!c.added && !c.removed) {
      if (open) hunks.push(open);
      open = null;
      i += n;
      continue;
    }
    open ??= { start: i, length: 0, replacement: [] };
    if (c.removed) {
      open.length += n;
      i += n;
    } else {
      open.replacement.push(...c.value);
    }
  }
  if (open) hunks.push(open);
  // A run of lines prettier rewrote one for one (quotes, semicolons, spacing on
  // consecutive statements) is a run of independent edits, not one: split it,
  // so an edit on one line does not drag in its untouched neighbours. A hunk
  // that joins or splits lines stays whole — its lines are one construct.
  return hunks.flatMap((h) =>
    h.length === h.replacement.length && h.length > 1
      ? h.replacement.map((line, k) => ({
          start: h.start + k,
          length: 1,
          replacement: [line],
        }))
      : [h],
  );
}

function overlaps(h: Hunk, touched: readonly boolean[]): boolean {
  if (h.length === 0) {
    // A pure insertion sits between two lines: it is the branch's when either is.
    return touched[h.start - 1] === true || touched[h.start] === true;
  }
  for (let k = h.start; k < h.start + h.length; k++) {
    if (touched[k] === true) return true;
  }
  return false;
}

/**
 * `cur` with only the hunks of `cur → formatted` that overlap a line the branch
 * changed against `base`. Pure.
 */
export async function selectChangedHunks(args: {
  cur: string;
  formatted: string;
  base: string;
}): Promise<string> {
  const { diffArrays } = await diffLib();
  const cur = lines(args.cur);
  const touched = touchedLines(diffArrays(lines(args.base), cur), cur.length);
  const out: string[] = [];
  let i = 0;
  for (const h of hunksOf(diffArrays(cur, lines(args.formatted)))) {
    if (!overlaps(h, touched)) continue;
    out.push(...cur.slice(i, h.start), ...h.replacement);
    i = h.start + h.length;
  }
  out.push(...cur.slice(i));
  return out.join("\n");
}

/**
 * The bytes `content` must have to count as formatted, for its scope: prettier's
 * whole output for a `file` scope; for a `lines` scope, prettier's changes to
 * the lines the branch changed, repeated to a fixed point.
 *
 * `format` is `formatSource`, in-process (the writer) or on the format thread
 * (the readers). A syntax error in `content` itself throws, as it always has;
 * one that only a partial selection produced (a reflow split across hunks)
 * settles on the whole-file answer instead, like a file that does not converge.
 *
 * So does a partial selection that still parses but CHANGED THE PROGRAM. The
 * line diff may align one prettier edit as two hunks — joining a multi-line
 * `import {…}` matched its `import {` to the next import's, giving "insert the
 * joined line" + "delete the old block" — and selecting only the deletion drops
 * the import, silently. Applying prettier's own hunks can never change what
 * prettier makes of the file, so `format(selection) === whole` is the invariant
 * every round checks; a selection that breaks it is not a formatting.
 */
export async function formatInScope(args: {
  file: string;
  content: string;
  scope: FormatScope;
  format: (bytes: SourceBytes) => Promise<string>;
}): Promise<string> {
  const { file, content, scope, format } = args;
  const whole = await format({ file, content });
  if (scope.kind === "file") return whole;
  let cur = content;
  let formatted = whole;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const next = await selectChangedHunks({ cur, formatted, base: scope.base });
    if (next === cur) return cur;
    cur = next;
    try {
      formatted = await format({ file, content: cur });
    } catch (err) {
      if (err instanceof FormatSyntaxError) return whole;
      throw err;
    }
    if (formatted !== whole) return whole;
  }
  return whole;
}
