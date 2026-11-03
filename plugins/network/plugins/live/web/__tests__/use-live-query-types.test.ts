/**
 * `useLive`'s collection read, checked by tsc: every misuse is a MULTI-LINE
 * call with its `@ts-expect-error` directly above the offending property (or
 * the argument, where there is no property to point at), so a diagnostic that
 * moved to the call — "No overload matches this call" (TS2769) against some
 * other overload — would leave the marker unused and fail. `@ts-expect-error`
 * cannot tell TS2769 from an elaborated error on the same line, so each
 * marker names its code(s) right after `@ts-expect-error`, then ` — <label>`
 * (several space-separated: `TS2322 TS2353 — <label>`), and
 * `live:read-misuse-diagnostics` pins them: the line's diagnostics must be
 * exactly the listed codes. Nothing here runs: the calls sit in hooks that
 * are never called.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fieldsToZodObject } from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import {
  liveCollection,
  liveValue,
  type CollectionRow,
  type LiveCollection,
  type LiveGroup,
  type LiveGroupableColumn,
  type LiveGroupQuery,
  type LiveQuery,
  type LiveWhereOf,
} from "@plugins/network/plugins/live/core";
import { or } from "@plugins/network/plugins/live/plugins/filter/core";
import type { ResourceResult } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useLive } from "../internal/use-live";
import type {
  LiveListResult,
  LiveRowResult,
  LiveUnavailable,
} from "../internal/use-live";

const FIELDS = {
  id: textField({ label: "Id" }),
  n: intField({ label: "N" }),
  flag: boolField({ label: "Flag" }),
  note: textField({ label: "Note", filterable: false }),
};
const Row = fieldsToZodObject(FIELDS);
type Row = z.infer<typeof Row>;
const SCOPED = { ...FIELDS, pageId: textField({ label: "Page" }) };

const windowed = liveCollection("fx.window", {
  fields: FIELDS,
  id: "id",
  sortable: ["n"],
  default: { orderBy: [["n", "asc"]], limit: 2 },
  maxLimit: 4,
});
const counted = liveCollection("fx.counted", {
  fields: FIELDS,
  id: "id",
  sortable: ["n"],
  default: { orderBy: [["n", "asc"]], limit: 2 },
  maxLimit: 4,
  count: true,
});
const lookup = liveCollection("fx.lookup", { fields: FIELDS, id: "id" });
const whole = liveCollection("fx.all", {
  fields: FIELDS,
  id: "id",
  all: { orderBy: [["n", "asc"]], unbounded: { reason: "fixture" } },
});
const scoped = liveCollection("fx.scoped", {
  fields: SCOPED,
  id: "id",
  all: {
    by: ["pageId"],
    orderBy: [["n", "asc"]],
    unbounded: { reason: "fixture" },
  },
});
const machineRows = liveCollection("fx.machine", {
  fields: FIELDS,
  id: "id",
  needsMachine: { feature: "Reading the checkout" },
});
const withIdParam = liveValue("fx.value-with-id", {
  schema: z.object({ n: z.number() }),
  params: ["id"],
});
const typed = liveValue("fx.typed", {
  schema: z.object({ n: z.number() }),
  params: { window: z.enum(["1h", "24h"]) },
});

function useNegatives(
  id: string,
  maybe: { id: string } | undefined,
  cond: boolean,
) {
  useLive(windowed, {
    // @ts-expect-error TS2322 — id number
    id: 1,
  });
  useLive(windowed, {
    // @ts-expect-error TS2322 — id maybe undefined
    id: maybe?.id,
  });
  useLive(windowed, {
    id,
    // @ts-expect-error TS2322 — id with limit
    limit: 2,
  });
  useLive(windowed, {
    id,
    // @ts-expect-error TS2322 — id with ids
    ids: [id],
  });
  useLive(windowed, {
    ids: [id],
    // @ts-expect-error TS2322 — ids with limit
    limit: 2,
  });
  useLive(windowed, {
    // @ts-expect-error TS2322 — unknown key
    wehre: { flag: true },
  });
  useLive(windowed, {
    // @ts-expect-error TS2322 — groupBy-nope
    groupBy: "nope",
  });
  useLive(windowed, {
    groupBy: "n",
    // @ts-expect-error TS2322 — groupBy-with-orderBy
    orderBy: [["n", "asc"]],
  });
  useLive(counted, {
    count: true,
    // @ts-expect-error TS2322 — count with limit
    limit: 2,
  });
  useLive(windowed, {
    // @ts-expect-error TS2322 — count uncounted
    count: true,
  });
  useLive(windowed, {
    where: or(
      // @ts-expect-error TS2345 — or wrong column
      { column: "nope", op: "eq", operand: true },
      { column: "n", op: "gt", operand: 1 },
    ),
  });
  useLive(windowed, {
    where: or(
      { column: "flag", op: "eq", operand: true },
      // @ts-expect-error TS2345 — or wrong operand
      { column: "n", op: "gt", operand: "x" },
    ),
  });
  useLive(lookup, {
    // @ts-expect-error TS2322 — where on lookup
    where: { flag: true },
  });
  useLive(
    lookup,
    // @ts-expect-error TS2345 — empty on lookup
    {},
  );
  useLive(windowed, {
    // @ts-expect-error TS2322 — select on window
    select: (rows: Row[]) => rows.length,
  });
  useLive(scoped, {
    where: {
      // @ts-expect-error TS2322 — scoped where number
      pageId: 1,
    },
  });
  useLive(scoped, {
    where: {
      // @ts-expect-error TS2353 — scoped where only other
      other: "x",
    },
  });
  useLive(whole, {
    // @ts-expect-error TS2322 — where on unscoped all
    where: { pageId: "p" },
  });
  useLive(
    windowed,
    // @ts-expect-error TS2345 — mixed kind: a union naming two reads (reported on the argument)
    cond ? { id } : { where: { flag: true } },
  );
  useLive(
    lookup,
    // @ts-expect-error TS2345 — undefined on a lookup-only collection: only a window has a default query
    undefined,
  );
  useLive(scoped, {
    where: {
      pageId: "p",
      // @ts-expect-error TS2322 — a row field outside `by` in a scope
      n: 1,
    },
  });
  useLive(
    windowed,
    {
      // @ts-expect-error TS2322 — id with viewport
      id,
    },
    { viewport: null as never },
  );
}

// Keys the fixed check set cannot see, a bad sort, and a bare `null` count —
// each accepted silently by an earlier draft of the folded signature.
function useExtraKeys(id: string, sel: (rows: Row[]) => number) {
  useLive(windowed, {
    id,
    // @ts-expect-error TS2322 — unknown key beside id
    foo: 1,
  });
  useLive(windowed, {
    ids: [id],
    // @ts-expect-error TS2322 — unknown key beside ids
    foo: 1,
  });
  useLive(counted, {
    count: true,
    // @ts-expect-error TS2322 — unknown key beside count
    foo: 1,
  });
  useLive(windowed, {
    where: { flag: true },
    // @ts-expect-error TS2322 — typo key beside where
    wehre: 1,
  });
  useLive(windowed, {
    groupBy: "n",
    // @ts-expect-error TS2322 — unknown key beside groupBy
    foo: 1,
  });
  useLive(whole, {
    select: sel,
    // @ts-expect-error TS2322 — unknown key beside select
    foo: 1,
  });
  useLive(whole, {
    ids: [id],
    // @ts-expect-error TS2322 — select beside ids (the id read would drop it)
    select: sel,
  });
  useLive(whole, {
    id,
    // @ts-expect-error TS2322 — select beside id (the id read would drop it)
    select: sel,
  });
  useLive(windowed, {
    // @ts-expect-error TS2322 — orderBy on a column that is not sortable
    orderBy: [["flag", "asc"]],
  });
  useLive(windowed, {
    // @ts-expect-error TS2322 — orderBy with a direction that is neither asc nor desc
    orderBy: [["n", "up"]],
  });
  useLive(scoped, {
    where: {
      pageId: "p",
      // @ts-expect-error TS2353 — a key outside the row and outside `by` in a scope
      other: "x",
    },
  });
  // @ts-expect-error TS2769 — a bare null collection with a query: nothing to count, nothing a where could name (null fits no overload's argument 0)
  useLive(null, {
    count: true,
    where: { anything: 1 },
  });
}

// The values of a grouping's, a count's and a slice's own keys are checked
// too — each accepted silently by an earlier draft that typed only their
// kind-naming key.
function useFormValues(
  sel: (rows: Row[]) => number,
  cond: boolean,
  maybeCounted: typeof counted | null,
) {
  useLive(windowed, {
    groupBy: "n",
    where: {
      // @ts-expect-error TS2353 — a grouping's where with an unknown column
      nope: 1,
    },
  });
  useLive(windowed, {
    groupBy: "n",
    where: {
      // @ts-expect-error TS2322 — a grouping's where with the wrong value type
      flag: "x",
    },
  });
  useLive(windowed, {
    groupBy: "n",
    where: {
      // @ts-expect-error TS2322 — a grouping's where with the wrong value type, beside a limit
      flag: "x",
    },
    limit: 2,
  });
  useLive(windowed, {
    groupBy: "flag",
    // @ts-expect-error TS2322 — a grouping with a string limit
    limit: "x",
  });
  useLive(windowed, {
    groupBy: "n",
    // @ts-expect-error TS2322 — a grouping with a non-array columns
    columns: 1,
  });
  useLive(counted, {
    count: true,
    where: {
      // @ts-expect-error TS2353 — a count's where with an unknown column
      nope: 1,
    },
  });
  useLive(counted, {
    count: true,
    where: {
      // @ts-expect-error TS2322 — a count's where with the wrong value type
      flag: "x",
    },
  });
  useLive(counted, {
    count: true,
    where: {
      // @ts-expect-error TS2353 — a count's where on a non-filterable column
      note: "x",
    },
  });
  useLive(counted, {
    count: true,
    // @ts-expect-error TS2322 — a count with a non-array columns
    columns: 1,
  });
  // @ts-expect-error TS2769 — a nullable count's where with an unknown column (the collection signature and the nullable count are both candidates for a `C | null`; the count's chain names `nope`)
  useLive(maybeCounted, {
    count: true,
    where: {
      nope: 1,
    },
  });
  useLive(windowed, {
    where: { flag: true },
    // @ts-expect-error TS2322 — select on a window, beside where
    select: sel,
  });
  useLive(windowed, {
    groupBy: "flag",
    // @ts-expect-error TS2322 — select beside a grouping
    select: sel,
  });
  useLive(counted, {
    count: true,
    // @ts-expect-error TS2322 — select beside a count
    select: sel,
  });
  useLive(whole, {
    select: sel,
    // @ts-expect-error TS2322 — where beside select on an unscoped all set
    where: { flag: true },
  });
  useLive(scoped, {
    where: { pageId: "p" },
    // @ts-expect-error TS2322 — a scoped set's select that is not a function
    select: 1,
  });
  useLive(
    counted,
    // @ts-expect-error TS2345 — a count's where with an unknown column, on one branch of a union
    cond ? { count: true, where: { nope: 1 } } : { count: true },
  );
}

// `where: or(…)` stays checked against the collection's columns on a
// grouping and a count too (their `where` is typed now).
function useFormOr() {
  useLive(windowed, {
    groupBy: "n",
    where: or(
      // @ts-expect-error TS2345 — grouping or wrong column
      { column: "nope", op: "eq", operand: true },
      { column: "n", op: "gt", operand: 1 },
    ),
  });
  useLive(windowed, {
    groupBy: "n",
    where: or(
      { column: "flag", op: "eq", operand: true },
      // @ts-expect-error TS2345 — grouping or wrong operand
      { column: "n", op: "gt", operand: "x" },
    ),
  });
  useLive(counted, {
    count: true,
    where: or(
      // @ts-expect-error TS2345 — count or wrong column
      { column: "nope", op: "eq", operand: true },
      { column: "n", op: "gt", operand: 1 },
    ),
  });
  useLive(counted, {
    count: true,
    where: or(
      { column: "flag", op: "eq", operand: true },
      // @ts-expect-error TS2345 — count or wrong operand
      { column: "n", op: "gt", operand: "x" },
    ),
  });
  const g: LiveListResult<LiveGroup<number>> = useLive(windowed, {
    groupBy: "n",
    where: or(
      { column: "flag", op: "eq", operand: true },
      { column: "n", op: "gt", operand: 1 },
    ),
    limit: 2,
  });
  const c: ResourceResult<number> = useLive(counted, {
    count: true,
    where: or(
      { column: "flag", op: "eq", operand: true },
      { column: "n", op: "gt", operand: 1 },
    ),
  });
  return [g, c];
}

// The same, hoisted into consts.
function useFormValuesHoisted() {
  const hg = { groupBy: "n" as const, limit: "x" };
  const hc = { count: true as const, where: { nope: 1 } };
  useLive(
    windowed,
    // @ts-expect-error TS2345 — hoisted grouping with a string limit
    hg,
  );
  useLive(
    counted,
    // @ts-expect-error TS2345 — hoisted count's where with an unknown column
    hc,
  );
}

// A — an `ids` that is not `readonly string[]`, on every collection form. `ids`
// is a kind key (`?: undefined` on the list forms), so a wrong one is never a
// window read; a `null` value reduces the query to `never` (it intersects the
// refusal), so it is refused on the argument.
function useIdsValues(id: string, cond: boolean) {
  useLive(windowed, {
    // @ts-expect-error TS2322 — A ids numbers
    ids: [1],
  });
  useLive(windowed, {
    // @ts-expect-error TS2322 — A ids string
    ids: "a",
  });
  useLive(
    windowed,
    // @ts-expect-error TS2322 — A ids null (on the argument)
    { ids: null },
  );
  useLive(windowed, {
    // @ts-expect-error TS2322 — A ids mixed
    ids: [id, 2],
  });
  useLive(counted, {
    // @ts-expect-error TS2322 — A ids numbers on a counted collection
    ids: [1],
  });
  useLive(lookup, {
    // @ts-expect-error TS2322 — A ids numbers on a lookup-only collection
    ids: [1],
  });
  const hq = { ids: [1] };
  useLive(
    windowed,
    // @ts-expect-error TS2345 — A hoisted ids numbers
    hq,
  );
  useLive(
    windowed,
    // @ts-expect-error TS2345 — A union ids numbers in one branch
    cond ? { ids: [1] } : { ids: [id] },
  );
  useLive(
    windowed,
    // A ids beside a limit spelled undefined: accepted — a key holding `undefined` is absent (read by value)
    { ids: [id], limit: undefined },
  );
  useLive(
    windowed,
    // A id beside a where spelled undefined: accepted — a key holding `undefined` is absent (read by value)
    { id, where: undefined },
  );
}

// B — a same-kind union whose `where` names an unknown column in ONE branch:
// written in the call, each branch is a fresh literal, so tsc refuses the
// failing branch (on its line, for a multi-line one). A union built before the
// call is never excess-checked: it is declared with `LiveWhereOf<typeof c>`
// (the lint `live/where-declared`), and tsc refuses it at the declaration.
function useUnionWhereColumns(cond: boolean) {
  useLive(
    windowed,
    // @ts-expect-error TS2345 — B union where, unknown column in one branch
    cond ? { where: { flag: true } } : { where: { nope: 1 } },
  );
  useLive(
    windowed,
    // @ts-expect-error TS2322 — B union inside where
    { where: cond ? { flag: true } : { nope: 1 } },
  );
  useLive(
    windowed,
    // @ts-expect-error TS2345 — B union where, limit on one side
    cond ? { where: { flag: true }, limit: 2 } : { where: { nope: 1 } },
  );
  useLive(
    windowed,
    cond
      ? { where: { flag: true }, limit: 2 }
      : // @ts-expect-error TS2345 — B union where, limit on both sides
        { where: { nope: 1 }, limit: 3 },
  );
  useLive(
    windowed,
    cond
      ? { groupBy: "n", where: { flag: true } }
      : // @ts-expect-error TS2345 — B union grouping where
        { groupBy: "n", where: { nope: 1 } },
  );
  useLive(
    counted,
    cond
      ? { count: true, where: { flag: true } }
      : // @ts-expect-error TS2345 — B union count where
        { count: true, where: { nope: 1 } },
  );
  // A `where` built before the call is declared with its collection's where
  // type (the lint `live/where-declared` requires it), so tsc's own
  // excess-property check fires at the declaration.
  const declared: LiveWhereOf<typeof windowed> = {
    flag: true,
    // @ts-expect-error TS2353 — B declared where with an unknown column
    nope: 1,
  };
  const declaredUnion: LiveWhereOf<typeof windowed> = cond
    ? { flag: true }
    : {
        // @ts-expect-error TS2322 — B declared union where, unknown column in one branch
        nope: 1,
      };
  const declaredScope: LiveWhereOf<typeof scoped> = {
    pageId: "p",
    // @ts-expect-error TS2353 — B declared scope with a key outside `by`
    other: "x",
  };
  useLive(windowed, { where: declared });
  useLive(windowed, { where: declaredUnion });
  useLive(scoped, { where: declaredScope });
  useLive(
    windowed,
    // @ts-expect-error TS2345 — B union where, wrong value in one branch
    cond ? { where: { flag: true } } : { where: { flag: "x" } },
  );
}

// C — a counted collection with a `null` query reads nothing (pending), typed
// as the count it would read; nothing else takes `null`. A query that MAY be
// `null` is a count or its skip — never a list beside it (the call site would
// read two kinds of thing).
function useCountSkip(cond: boolean) {
  const skipped: ResourceResult<number> = useLive(counted, null);
  const maybe: ResourceResult<number> = useLive(
    counted,
    cond ? { count: true } : null,
  );
  const maybeWhere: ResourceResult<number> = useLive(
    counted,
    cond ? { count: true, where: { flag: true } } : null,
  );
  const hoisted = cond ? { count: true as const } : null;
  const maybeHoisted: ResourceResult<number> = useLive(counted, hoisted);
  const typed: { count: true } | null = cond ? { count: true } : null;
  const maybeTyped: ResourceResult<number> = useLive(counted, typed);
  useLive(
    windowed,
    // @ts-expect-error TS2345 — C null query on an uncounted collection
    null,
  );
  useLive(
    lookup,
    // @ts-expect-error TS2345 — C null query on a lookup-only collection
    null,
  );
  useLive(
    windowed,
    // @ts-expect-error TS2345 — C a count that may be null, on an uncounted collection
    cond ? { count: true } : null,
  );
  useLive(
    counted,
    // @ts-expect-error TS2345 — C a list beside a count's null skip (on the argument)
    cond ? { where: { flag: true } } : null,
  );
  useLive(
    counted,
    // @ts-expect-error TS2345 — C an id read beside a count's null skip (on the argument)
    cond ? { ids: ["a"] } : null,
  );
  useLive(
    counted,
    // @ts-expect-error TS2345 — C a maybe-null count's where with an unknown column (on the argument)
    cond ? { count: true, where: { nope: 1 } } : null,
  );
  return [skipped, maybe, maybeWhere, maybeHoisted, maybeTyped];
}

// A — a kind key holding only `undefined` names no read (the runtime reads
// `id`, `ids` and `count` by value): beside a window it is the read its other
// keys name; on a collection with no window it fits no form.
function useUndefinedKindKeys(id: string, cond: boolean) {
  const list: LiveListResult<Row> = useLive(windowed, {
    ids: undefined,
    where: { flag: true },
  });
  const list2: LiveListResult<Row> = useLive(windowed, { id: undefined });
  const list3: LiveListResult<Row> = useLive(counted, { count: undefined });
  const groups: LiveListResult<LiveGroup<number>> = useLive(windowed, {
    groupBy: "n",
    ids: undefined,
  });
  const total: ResourceResult<number> = useLive(counted, {
    count: true,
    id: undefined,
  });
  const fromIds: ResourceResult<Row[]> = useLive(lookup, {
    id: undefined,
    ids: [id],
  });
  const row: LiveRowResult<Row> = useLive(lookup, { ids: undefined, id });
  useLive(
    lookup,
    // @ts-expect-error TS2322 — A id undefined on a lookup-only collection: no window to list (on the argument)
    { id: undefined },
  );
  useLive(
    whole,
    // @ts-expect-error TS2345 — A id undefined on an `all` set: not its whole-set read (on the argument)
    { id: undefined },
  );
  useLive(
    lookup,
    // @ts-expect-error TS2322 — A ids undefined on a lookup-only collection (on the argument)
    { ids: undefined },
  );
  useLive(
    windowed,
    // @ts-expect-error TS2345 — A a grouping beside `groupBy: undefined` (a list) on the other branch: the kind latch would throw (on the argument)
    cond ? { groupBy: "n" } : { groupBy: undefined },
  );
  useLive(
    windowed,
    // @ts-expect-error TS2345 — A a grouping beside `groupBy: undefined` with a limit (a list) on the other branch (on the argument)
    cond ? { groupBy: "n" } : { groupBy: undefined, limit: 2 },
  );
  useLive(
    windowed,
    // @ts-expect-error TS2345 — A a grouping beside `groupBy: undefined` with a where (a list) on the other branch (on the argument)
    cond
      ? { groupBy: "n", where: { flag: true } }
      : { groupBy: undefined, where: { flag: true } },
  );
  const listByGroup: LiveListResult<Row> = useLive(windowed, {
    groupBy: undefined,
    limit: 2,
  });
  // @ts-expect-error TS2322 — A `{ id: undefined }` is a window list, never a row result
  const notRow: LiveRowResult<Row> = useLive(windowed, { id: undefined });
  return [list, list2, list3, groups, total, fromIds, row, notRow, listByGroup];
}

// B — a generic caller's misuse is refused as a concrete caller's: a query of
// no known key fits no form, and the forms' excess-property check names it.
function useGenericMisuse<R, F, S extends string>(
  c: LiveCollection<R, F, S>,
  select: (rows: R[]) => number,
) {
  useLive(c, {
    // @ts-expect-error TS2322 — B generic unknown key alone
    foo: 1,
  });
  useLive(c, {
    // @ts-expect-error TS2322 — B generic select on a window
    select,
  });
  useLive(c, {
    limit: 2,
    // @ts-expect-error TS2322 — B generic unknown key beside a limit
    foo: 1,
  });
  useLive(c, {
    // @ts-expect-error TS2322 — B generic count on a collection not typed counted
    count: true,
  });
}

// B / C positives: unions whose branches name only known columns, a tree
// beside the sugar, and a typed `where` passed through.
function useUnionWherePositives(
  cond: boolean,
  where: { flag: boolean } | { n: number },
) {
  const a: LiveListResult<Row> = useLive(
    windowed,
    cond ? { where: { flag: true } } : { where: { n: 1 } },
  );
  const b: LiveListResult<Row> = useLive(windowed, {
    where: cond ? { flag: true } : { n: 1 },
  });
  const c: LiveListResult<Row> = useLive(
    windowed,
    cond
      ? {
          where: or(
            { column: "flag", op: "eq", operand: true },
            { column: "n", op: "gt", operand: 1 },
          ),
        }
      : { where: { flag: true } },
  );
  const d: LiveListResult<Row> = useLive(windowed, { where });
  const e: ResourceResult<number> = useLive(
    counted,
    cond
      ? { count: true, where: { flag: true } }
      : { count: true, where: { n: 1 } },
  );
  const f: LiveListResult<LiveGroup<number>> = useLive(
    windowed,
    cond ? { groupBy: "n", where: { flag: true } } : { groupBy: "n" },
  );
  return [a, b, c, d, e, f];
}

// The same cases hoisted into consts (no literal at the call).
function useHoisted(id: string) {
  const idNumber = { id: 1 };
  const idLimit = { id, limit: 2 };
  const idsLimit = { ids: [id], limit: 2 };
  const groupOrder = {
    groupBy: "n" as const,
    orderBy: [["n", "asc"]] as const,
  };
  const countLimit = { count: true as const, limit: 2 };
  const unknownKey = { wehre: { flag: true } };
  const idFoo = { id, foo: 1 };
  const idsFoo = { ids: [id], foo: 1 };
  const whereFoo = { where: { flag: true }, foo: 1 };
  const groupFoo = { groupBy: "n" as const, foo: 1 };
  const countFoo = { count: true as const, foo: 1 };
  useLive(
    windowed,
    // @ts-expect-error TS2345 — hoisted id number
    idNumber,
  );
  useLive(
    windowed,
    // @ts-expect-error TS2345 — hoisted id limit
    idLimit,
  );
  useLive(
    windowed,
    // @ts-expect-error TS2345 — hoisted ids limit
    idsLimit,
  );
  useLive(
    windowed,
    // @ts-expect-error TS2345 — hoisted group orderBy
    groupOrder,
  );
  useLive(
    counted,
    // @ts-expect-error TS2345 — hoisted count limit
    countLimit,
  );
  useLive(
    windowed,
    // @ts-expect-error TS2345 — hoisted unknown key
    unknownKey,
  );
  // An unknown key beside a known one: tsc never excess-checks an object
  // built before the call — the query's own key set (inferred, keys only)
  // refuses it.
  useLive(
    windowed,
    // @ts-expect-error TS2345 — hoisted unknown key beside id
    idFoo,
  );
  useLive(
    windowed,
    // @ts-expect-error TS2345 — hoisted unknown key beside ids
    idsFoo,
  );
  useLive(
    windowed,
    // @ts-expect-error TS2345 — hoisted unknown key beside where
    whereFoo,
  );
  useLive(
    windowed,
    // @ts-expect-error TS2345 — hoisted unknown key beside groupBy
    groupFoo,
  );
  useLive(
    counted,
    // @ts-expect-error TS2345 — hoisted unknown key beside count
    countFoo,
  );
}

// Wrong sources (gate 6).
function useWrongSources(id: string, maybeWindow: typeof windowed | null) {
  useLive(
    // @ts-expect-error TS2769 — non live source: not a collection, so every value overload is a candidate
    { foo: 1 },
    { id },
  );
  useLive(
    // @ts-expect-error TS2345 — nullable collection: not a collection (on the argument)
    maybeWindow,
    { id },
  );
}

// Positives: every one must compile.
function usePositives(
  id: string,
  nullable: string | null,
  cond: boolean,
  w: "1h" | "24h",
  maybeCounted: typeof counted | null,
) {
  // The nullable count: `null` for the collection (or the query) reads nothing.
  const skippedTotal: ResourceResult<number> = useLive(maybeCounted, null);
  const maybeTotal: ResourceResult<number> = useLive(maybeCounted, {
    count: true,
  });
  const nothing: ResourceResult<number> = useLive(null, null);
  // A bare `null` collection with a bare count, or a count that may be its
  // skip: nothing to read either way (accepted at HEAD; no `where` — there
  // is no collection whose columns it could name).
  const nothingCounted: ResourceResult<number> = useLive(null, { count: true });
  const nothingMaybe: ResourceResult<number> = useLive(
    null,
    cond ? { count: true } : null,
  );
  void [nothingCounted, nothingMaybe];
  const allIds: ResourceResult<Row[]> = useLive(whole, { ids: [id] });
  void [skippedTotal, maybeTotal, nothing, allIds];
  const r1: LiveRowResult<Row> = useLive(windowed, { id });
  const r2: LiveRowResult<Row> = useLive(lookup, { id: nullable });
  const r3: LiveRowResult<Row> = useLive(whole, { id });
  const r4: LiveRowResult<Row & { pageId: string }> = useLive(scoped, {
    id: null,
  });
  const r5: LiveRowResult<Row> | LiveUnavailable = useLive(machineRows, { id });
  const ids: ResourceResult<Row[]> = useLive(lookup, { ids: [id] });
  const list: LiveListResult<Row> = useLive(windowed, {
    where: { flag: true },
    limit: 2,
  });
  const list2: LiveListResult<Row> = useLive(windowed, {
    where: or(
      { column: "flag", op: "eq", operand: true },
      { column: "n", op: "gt", operand: 1 },
    ),
    orderBy: [["n", "desc"]],
  });
  const groups: LiveListResult<LiveGroup<number>> = useLive(windowed, {
    groupBy: "n",
  });
  const total: ResourceResult<number> = useLive(counted, {
    count: true,
    where: { flag: true },
  });
  const all: ResourceResult<Row[]> = useLive(whole);
  const slice: ResourceResult<number> = useLive(whole, {
    select: (rows) => rows.length,
  });
  const page: ResourceResult<Row[]> = useLive(scoped, {
    where: { pageId: "p" },
  });
  const pageSlice: ResourceResult<number> = useLive(scoped, {
    where: { pageId: "p" },
    select: (rows) => rows.length,
  });
  const v: ResourceResult<{ n: number }> = useLive(withIdParam, { id });
  const t: ResourceResult<{ n: number }> = useLive(typed, { window: "1h" });
  const t2: ResourceResult<{ n: number }> = useLive(typed, { window: w });
  // Same-kind union from conditional spreads (data-view's shape).
  const spread = useLive(windowed, {
    groupBy: "n",
    ...(cond ? {} : { where: { flag: true } }),
    limit: 2,
  });
  const undef = useLive(windowed, { id: undefined, where: { flag: true } });
  const plain: LiveListResult<Row> = useLive(windowed, undefined);
  const maybeQuery: { limit: number } | undefined = cond
    ? { limit: 1 }
    : undefined;
  const maybe: LiveListResult<Row> = useLive(windowed, maybeQuery);
  void maybe;
  return [
    r1,
    r2,
    r3,
    r4,
    r5,
    ids,
    list,
    list2,
    groups,
    total,
    all,
    slice,
    page,
    pageSlice,
    v,
    t,
    t2,
    spread,
    undef,
    plain,
  ];
}

// The group literal is kept: its value type is the row field's (number), not never.
function useGroupLiteral() {
  // @ts-expect-error TS2322 — group literal not string
  const wrong: LiveListResult<LiveGroup<string>> = useLive(windowed, {
    groupBy: "n",
  });
  return wrong;
}

// A generic wrapper resolves.
function useGenericWindow<R, F, S extends string>(
  c: LiveCollection<R, F, S>,
  q: LiveQuery<F, S>,
) {
  return useLive(c, q);
}
function useGenericRow<R, F, S extends string>(
  c: LiveCollection<R, F, S>,
  id: string | null,
) {
  return useLive(c, { id });
}

// Generic wrappers (a caller passing its own type parameters through).
function useGW<R, F, S extends string>(
  c: LiveCollection<R, F, S>,
  q: LiveQuery<F, S>,
): LiveListResult<CollectionRow<R>> {
  return useLive(c, q);
}
function useGR<R, F, S extends string>(
  c: LiveCollection<R, F, S>,
  id: string | null,
): LiveRowResult<CollectionRow<R>> {
  return useLive(c, { id });
}
function useGIds<R, F, S extends string>(
  c: LiveCollection<R, F, S>,
  ids: readonly string[],
): ResourceResult<CollectionRow<R>[]> {
  return useLive(c, { ids });
}
function useGOpt<R, F, S extends string>(
  c: LiveCollection<R, F, S>,
  q?: LiveQuery<F, S>,
): LiveListResult<CollectionRow<R>> {
  return useLive(c, q);
}
function useGG<R, F, S extends string>(
  c: LiveCollection<R, F, S>,
  q: LiveGroupQuery<F>,
): LiveListResult<unknown> {
  return useLive(c, q);
}
// Same-kind unions resolve to their one read.
function useSameKindUnions(cond: boolean) {
  const row: LiveRowResult<Row> = useLive(
    windowed,
    cond ? { id: "a" } : { id: null },
  );
  const list: LiveListResult<Row> = useLive(
    windowed,
    cond ? { where: { flag: true } } : { limit: 2 },
  );
  const groups: LiveListResult<LiveGroup<number>> = useLive(
    windowed,
    cond ? { groupBy: "n" } : { groupBy: "n", limit: 2 },
  );
  return [row, list, groups];
}
// A generic `groupBy: G` is a grouping on every branch — its value is never
// read for the kind (it would defer), alone or in a same-kind union.
function useGGUnion<R, F, S extends string, G extends LiveGroupableColumn<F>>(
  c: LiveCollection<R, F, S>,
  groupBy: G,
  cond: boolean,
): unknown[] {
  return [
    useLive(c, { groupBy }),
    useLive(c, cond ? { groupBy } : { groupBy, limit: 3 }),
  ];
}

describe("useLive's collection read types", () => {
  it("are checked by tsc (see the @ts-expect-error lines)", () => {
    for (const hook of [
      useNegatives,
      useHoisted,
      useWrongSources,
      usePositives,
      useGroupLiteral,
      useGenericWindow,
      useGenericRow,
      useExtraKeys,
      useFormValues,
      useFormValuesHoisted,
      useFormOr,
      useGW,
      useGR,
      useGIds,
      useGOpt,
      useGG,
      useSameKindUnions,
      useGGUnion,
      useIdsValues,
      useUnionWhereColumns,
      useCountSkip,
      useUndefinedKindKeys,
      useGenericMisuse,
      useUnionWherePositives,
    ]) {
      expect(typeof hook).toBe("function");
    }
  });
});
