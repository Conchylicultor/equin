// ---------------------------------------------------------------------------
// A statement's label: the name every `db` profiler span, its deadline and
// everything downstream (slow-ops, op-rate's per-op history) know it by.
//
// The label is the statement's SHAPE, never its arity. drizzle renders
// `inArray(col, ids)` as `in ($1, $2, …, $n)` and a multi-row insert as
// `values ($1, $2), ($3, $4), …`, so the raw text of one call site changes with
// every list length — and every parameter after the list is renumbered too
// (`… in ($1…$22) and regime = $23` vs `$60`). Keyed by raw text, main held
// ~1,660 distinct `db` ops (2026-11-15), ~420 of them the same statements at
// another list length: one slow statement filed as several slow-op rows, each
// under its occurrence threshold, and op-rate's history growing with them.
//
// So the label is derived here, the one place a `db` label is made, for every
// call site at once:
//   - a list of placeholders inside `(…)` / `[…]` — two or more, or one right
//     after `IN` / `ARRAY` / `VALUES` (a one-element list of the same call
//     site) — becomes `$…`: `in ($…)`, `ARRAY[$…]`, `values ($…)`;
//   - a run of identical `($…)` tuples (`values ($…), ($…), …`) becomes one;
//   - the placeholders left are renumbered by first appearance, so what
//     follows a list reads the same whatever the list's length.
// What it does NOT reach: values spelled INTO the text (an interpolated
// literal, `sql.raw`) — those make one statement per value at the call site,
// which a parameter fixes.
// ---------------------------------------------------------------------------

// The runtime-profiler caps span labels at 500 chars (recorder MAX_LABEL_LEN):
// the label is cut to the same length, so a deadline names the label its
// `<sql>` span records, and the `[deadline]` span keeps its suffix instead of
// losing it to the recorder's cut.
export const SQL_LABEL_MAX = 500;

// One placeholder, with an optional cast (`$3::text`, `$1::int[]`,
// `$2::"char"`).
const PLACEHOLDER = String.raw`\$\d+(?:\s*::\s*(?:"[^"]*"|[A-Za-z_][\w.]*)(?:\[\])*)?`;

// An optional `IN` / `ARRAY` / `VALUES` keyword, then a bracketed group holding
// only placeholders.
const PLACEHOLDER_GROUP = new RegExp(
  String.raw`(\b(?:in|array|values)\s*)?([(\[])\s*(${PLACEHOLDER}(?:\s*,\s*${PLACEHOLDER})*)\s*([)\]])`,
  "gi",
);
const LIST = "$…";
const TUPLE_RUN = /\(\$…\)(?:\s*,\s*\(\$…\))+/g;
const NUMBERED = /\$(\d+)/g;

/** A statement's label: its text with every list's arity taken out, cut to the span label's length. */
export function sqlLabel(text: string): string {
  return cap(text.includes("$") ? shapeOf(text) : text);
}

function shapeOf(text: string): string {
  const collapsed = text
    .replace(
      PLACEHOLDER_GROUP,
      (
        whole,
        keyword: string | undefined,
        open: string,
        list: string,
        close: string,
      ) => {
        // A lone placeholder in parentheses is a list only after a list
        // keyword: `coalesce($1)` / `= ($1)` keep their number.
        if (keyword === undefined && !list.includes(",")) return whole;
        // A `(` closed by `]` (or the reverse) is not one group.
        if ((open === "(") !== (close === ")")) return whole;
        return `${keyword ?? ""}${open}${LIST}${close}`;
      },
    )
    .replace(TUPLE_RUN, `(${LIST})`);
  const renumbered = new Map<string, number>();
  return collapsed.replace(NUMBERED, (_m, n: string) => {
    let next = renumbered.get(n);
    if (next === undefined) {
      next = renumbered.size + 1;
      renumbered.set(n, next);
    }
    return `$${next}`;
  });
}

function cap(label: string): string {
  return label.length > SQL_LABEL_MAX ? label.slice(0, SQL_LABEL_MAX) : label;
}
