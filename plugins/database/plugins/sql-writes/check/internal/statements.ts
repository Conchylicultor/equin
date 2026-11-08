import { hasSqlDetails, parseSync, type Node } from "libpg-query";
import type { ResolvedRef } from "./probe-types";
import type { Hole, SqlSite } from "./sites";

// ── A site's text, parsed by Postgres's own grammar ─────────────────────────
//
// Every hole is rendered as what it is: a resolved name inline (quoted the way
// drizzle quotes it), a constant string inline, and anything else as a
// placeholder identifier `__h<N>__`. A placeholder parses as a value, a name or
// a condition; where the grammar wants a clause instead (`VALUES ${rows}`,
// `SET ${assignments}`, `WITH ${ctes}`), the parse fails AT the placeholder and
// it is re-tried as the next filler below. The validator then reads where a
// placeholder landed: as a value it is harmless; as a table or a written
// column, the statement writes a name the source does not spell.

/** Placeholder spelling of opaque hole `n`. */
export const placeholder = (n: number): string => `__h${n}__`;
export const PLACEHOLDER = /^__h(\d+)__$/;

const FILLERS: readonly ((p: string) => string)[] = [
  (p) => p, //                     a value, a name, a condition
  (p) => `${p} = ${p}`, //          an assignment list (SET ${…})
  (p) => `SELECT ${p}`, //          a query (INSERT … ${select}, a CTE body)
  (p) => `VALUES (${p})`, //        a row list
  (p) => `${p} AS (SELECT 1)`, //   a CTE list (WITH ${ctes})
  (p) => `(${p})`, //               a parenthesised list (IN ${ids})
  () => "", //                      an optional fragment rendered empty
];

export type Parsed =
  | {
      readonly kind: "parsed";
      readonly stmts: readonly Node[];
      readonly text: string;
    }
  | {
      readonly kind: "unparseable";
      readonly error: string;
      readonly text: string;
    };

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Render `site` with each hole's resolution (an `export` hole's probe answer
 * keyed by `refId(site, i)`), and parse it — retrying fillers for the
 * placeholder each failure lands on.
 */
export function parseSite(
  site: SqlSite,
  refs: (holeIndex: number) => ResolvedRef | undefined,
): Parsed {
  const rendered = site.holes.map((h, i) => renderHole(site, h, refs(i)));
  const fillers = rendered.map(() => 0);
  let last = "";
  for (let attempt = 0; attempt < 64; attempt++) {
    const spans: { start: number; end: number; hole: number }[] = [];
    let text = site.chunks[0] ?? "";
    site.holes.forEach((_, i) => {
      const r = rendered[i] as string | null;
      const start = text.length;
      if (r === null) {
        const filler = FILLERS[fillers[i] as number] as (p: string) => string;
        text += filler(placeholder(i));
        spans.push({ start, end: text.length, hole: i });
      } else text += r;
      text += site.chunks[i + 1] ?? "";
    });
    try {
      const stmts = (parseSync(text).stmts ?? []).flatMap((s) =>
        s.stmt ? [s.stmt] : [],
      );
      return { kind: "parsed", stmts, text };
    } catch (err) {
      if (!hasSqlDetails(err)) throw err;
      last = err.message;
      // The placeholder the error is at, else the last one before it.
      const at = (err.sqlDetails?.cursorPosition ?? text.length + 1) - 1;
      const blamed =
        // (The reported position may sit on the space just before the token.)
        spans.find(
          (s) => at >= s.start - 1 && at < Math.max(s.end, s.start + 1),
        ) ?? spans.filter((s) => s.start <= at).at(-1);
      if (!blamed || (fillers[blamed.hole] as number) + 1 >= FILLERS.length)
        return { kind: "unparseable", error: last, text };
      fillers[blamed.hole] = (fillers[blamed.hole] as number) + 1;
    }
  }
  return { kind: "unparseable", error: last, text: "" };
}

/** The text a hole renders as, or null for a placeholder. */
function renderHole(
  site: SqlSite,
  hole: Hole,
  ref: ResolvedRef | undefined,
): string | null {
  switch (hole.kind) {
    case "text":
      return hole.text;
    case "ident":
      return quoteIdent(hole.name);
    case "opaque":
      return null;
    case "export": {
      if (!ref) return null;
      if (ref.kind === "table")
        return ref.schema === "public"
          ? quoteIdent(ref.name)
          : `${quoteIdent(ref.schema)}.${quoteIdent(ref.name)}`;
      // drizzle renders a column interpolated in sql`…` table-qualified.
      if (ref.kind === "column")
        return site.tagged
          ? `${quoteIdent(ref.table)}.${quoteIdent(ref.name)}`
          : ref.name;
      if (ref.kind === "string") return site.tagged ? null : ref.value;
      return null;
    }
  }
}
