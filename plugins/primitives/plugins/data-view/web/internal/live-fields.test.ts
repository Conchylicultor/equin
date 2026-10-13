/**
 * A live DataView source's field resolution (`resolveLiveFields`) and the
 * mount checks (`checkFieldColumns`): which fields the Filter and Sort controls
 * offer, what column each lowers to, and which declarations throw.
 *
 * Run: `./singularity test plugins/primitives/plugins/data-view`.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  liveCollection,
  liveColumns,
  scopedLiveColumns,
  type WithContributedColumns,
} from "@plugins/network/plugins/live/core";
import {
  liveBoolean,
  liveInstant,
  liveNumber,
  liveStringArray,
  liveText,
} from "@plugins/network/plugins/live/plugins/filter/core";
import { type FieldDef, type FilterOperatorSet } from "../../core";
import { liveDataSource } from "./live-data-source";
import {
  checkFieldColumns,
  liveColumnScopeOf,
  resolveLiveFields,
} from "./live-fields";

const Thread = z.object({
  id: z.string(),
  subject: z.string(),
  labelIds: z.array(z.string()),
  unread: z.boolean(),
  lastMessageAt: z.date(),
});
type Thread = z.infer<typeof Thread>;

let n = 0;
const threads = () =>
  liveCollection(`test.data-view.live-source-${n++}`, {
    row: Thread,
    id: "id",
    filterable: {
      subject: liveText(),
      labelIds: liveStringArray(),
      unread: liveBoolean(),
      lastMessageAt: liveInstant(),
    },
    sortable: ["subject", "lastMessageAt"],
    default: { orderBy: [["lastMessageAt", "desc"]], limit: 10 },
    maxLimit: 30,
  });

/** The operator sets data-view resolves per field type — just their domains. */
const DOMAINS: Record<string, FilterOperatorSet["domain"]> = {
  text: "text",
  tags: "stringArray",
  bool: "boolean",
  date: "instant",
  int: "number",
};
const resolveOperatorSet = (type: string) =>
  DOMAINS[type] === undefined
    ? undefined
    : ({
        match: type,
        domain: DOMAINS[type],
        operators: [],
      } as FilterOperatorSet);

describe("resolveLiveFields", () => {
  test("offers fields bound to declared columns, lowering each to its column", () => {
    const c = threads();
    const source = liveDataSource(c, { searchable: ["subject"] });
    const fields: FieldDef<Thread>[] = [
      {
        id: "subject",
        label: "Subject",
        type: "text",
        value: (t) => t.subject,
      },
      {
        id: "labels",
        label: "Labels",
        type: "tags",
        values: (t) => t.labelIds,
        column: c.column("labelIds"),
      },
      { id: "unread", label: "Unread", type: "bool", value: (t) => t.unread },
      {
        id: "lastMessageAt",
        label: "Last message",
        type: "date",
        value: (t) => t.lastMessageAt,
      },
      // Bound to no column: display-only, neither offered nor checked.
      {
        id: "cc-1",
        label: "Custom",
        type: "text",
        value: () => "x",
        sortable: true,
      },
    ];
    const plan = resolveLiveFields(fields, source, resolveOperatorSet, "host");
    expect(plan.filterFields.map((f) => f.id)).toEqual([
      "subject",
      "labels",
      "unread",
      "lastMessageAt",
    ]);
    // `unread` has a value but its column does not sort: not offered, no throw.
    expect(plan.sortFields.map((f) => f.id)).toEqual([
      "subject",
      "lastMessageAt",
    ]);
    expect(plan.columnOf.get("labels")).toBe("labelIds");
    expect(plan.columnOf.has("cc-1")).toBe(false);
    expect(plan.filterable).toEqual({
      subject: { domain: "text" },
      labels: { domain: "stringArray" },
      unread: { domain: "boolean" },
      lastMessageAt: { domain: "instant" },
    });
  });

  test("a field MARKED sortable over a column that does not sort throws", () => {
    const c = threads();
    const source = liveDataSource(c, { searchable: [] });
    expect(() =>
      resolveLiveFields(
        [
          {
            id: "unread",
            label: "Unread",
            type: "bool",
            value: (t: Thread) => t.unread,
            sortable: true,
          },
        ],
        source,
        resolveOperatorSet,
        "host",
      ),
    ).toThrow(/"unread" is marked sortable, but its column "unread"/);
  });

  test("a filterable field whose operator set lowers over another domain throws", () => {
    const c = threads();
    const source = liveDataSource(c, { searchable: [] });
    expect(() =>
      resolveLiveFields(
        [
          {
            id: "subject",
            label: "Subject",
            type: "int",
            value: () => 1,
          },
        ],
        source,
        resolveOperatorSet,
        'field extension "x"',
      ),
    ).toThrow(/field extension "x".*filters over number.*declared text/);
  });

  test("a ref naming another collection throws — it is not this source's column", () => {
    const a = threads();
    const b = threads();
    const source = liveDataSource(a, { searchable: [] });
    expect(() =>
      resolveLiveFields(
        [
          {
            id: "labels",
            label: "Labels",
            type: "tags",
            values: (t: Thread) => t.labelIds,
            column: b.column("labelIds"),
          },
        ],
        source,
        resolveOperatorSet,
        "host",
      ),
    ).toThrow(
      /names a column of "test.data-view.live-source-\d+", but this DataView reads/,
    );
  });

  test("a field over a column the source's scope constrains is not offered to Filter, but still sorts", () => {
    const c = threads();
    const source = liveDataSource(c, { searchable: [] }).scoped({
      where: { subject: "acct" },
    });
    const fields: FieldDef<Thread>[] = [
      {
        id: "subject",
        label: "Subject",
        type: "text",
        value: (t) => t.subject,
      },
      { id: "unread", label: "Unread", type: "bool", value: (t) => t.unread },
    ];
    const plan = resolveLiveFields(fields, source, resolveOperatorSet, "host");
    expect(plan.filterFields.map((f) => f.id)).toEqual(["unread"]);
    expect(plan.filterable).toEqual({ unread: { domain: "boolean" } });
    expect(plan.sortFields.map((f) => f.id)).toEqual(["subject"]);
    // A domain mismatch is still a declaration error, scope or not.
    expect(() =>
      resolveLiveFields(
        [{ id: "subject", label: "Subject", type: "int", value: () => 1 }],
        source,
        resolveOperatorSet,
        "host",
      ),
    ).toThrow(/filters over number.*declared text/);
  });

  test("a column ref is minted only for a declared column", () => {
    const c = threads();
    expect(() => c.column("id" as never)).toThrow(
      /not a declared filterable or sortable column/,
    );
  });
});

describe("checkFieldColumns", () => {
  test("a column on an in-memory DataView throws — it would be ignored", () => {
    const c = threads();
    expect(() =>
      checkFieldColumns(
        [
          {
            id: "labels",
            label: "Labels",
            column: c.column("labelIds"),
          } as FieldDef<unknown>,
        ],
        undefined,
        resolveOperatorSet,
        "the host's fields",
      ),
    ).toThrow(
      /"labels" names a live column, but this DataView has no live `source`/,
    );
    // Without a column, nothing to check.
    expect(() =>
      checkFieldColumns(
        [{ id: "x", label: "X" }],
        undefined,
        resolveOperatorSet,
        "host",
      ),
    ).not.toThrow();
  });
});

describe("liveDataSource", () => {
  test("scoped ANDs a canonical base filter, validated by the collection's codec", () => {
    const c = threads();
    const source = liveDataSource(c, { searchable: ["subject"] });
    expect(source.scope).toEqual({ kind: "all" });
    const inbox = source.scoped({ where: { labelIds: { hasAny: ["INBOX"] } } });
    expect(inbox.scope).toEqual({
      kind: "where",
      filter: { column: "labelIds", op: "hasAny", operand: ["INBOX"] },
    });
    const unreadInbox = inbox.scoped({ where: { unread: true } });
    expect(unreadInbox.scope).toEqual({
      kind: "where",
      filter: {
        and: [
          { column: "labelIds", op: "hasAny", operand: ["INBOX"] },
          { column: "unread", op: "eq", operand: true },
        ],
      },
    });
    expect(() => source.scoped({ where: { id: "x" } as never })).toThrow();
  });

  test("awaitingScope names the columns the coming scope constrains — kept out of Filter already", () => {
    const c = threads();
    const source = liveDataSource(c, { searchable: ["subject"] });
    expect(source.awaitingScope(["unread"]).scope).toEqual({
      kind: "awaiting",
      columns: ["unread"],
    });
    // An existing scope's columns stay scope columns while the rest arrives.
    expect(
      source.scoped({ where: { subject: "x" } }).awaitingScope(["unread"])
        .scope,
    ).toEqual({ kind: "awaiting", columns: ["unread", "subject"] });
    expect(() => source.awaitingScope(["id" as never])).toThrow(
      /not a filterable column/,
    );
  });

  test("searchable must name declared text columns", () => {
    const c = threads();
    expect(() =>
      liveDataSource(c, { searchable: ["unread" as never] }),
    ).toThrow(/searchable column "unread" must be a declared text column/);
  });
});

describe("resolveLiveFields — contributed columns", () => {
  test("a field bound through a contributor's handle lowers to its wire name, and names the handle", () => {
    const c = liveCollection(`test.data-view.live-source-contrib-${n++}`, {
      row: Thread,
      id: "id",
      filterable: { subject: liveText() },
      sortable: ["subject"],
      default: { orderBy: [["subject", "asc"]], limit: 10 },
      maxLimit: 30,
      contributed: true,
    });
    const stats = liveColumns(c, "stats", {
      row: z.object({ opens: z.number() }),
      filterable: { opens: liveNumber() },
      sortable: ["opens"],
    });
    const source = liveDataSource(c, { searchable: ["subject"] });
    const fields: FieldDef<WithContributedColumns<Thread>>[] = [
      {
        id: "opens",
        label: "Opens",
        type: "int",
        value: (t) => stats.read(t).opens,
        column: stats.column("opens"),
      },
    ];
    const plan = resolveLiveFields(fields, source, resolveOperatorSet, "host");
    expect(plan.columnOf.get("opens")).toBe("stats.opens");
    expect(plan.sortFields.map((f) => f.id)).toEqual(["opens"]);
    expect(plan.filterable).toEqual({ opens: { domain: "number" } });
    expect([...plan.handles.values()]).toEqual([stats]);
  });
});

describe("scoped columns (a surface's custom columns)", () => {
  const scopedThreads = () =>
    liveCollection(`test.data-view.live-source-${n++}`, {
      row: Thread,
      id: "id",
      filterable: { subject: liveText() },
      sortable: ["subject"],
      default: { orderBy: [["subject", "asc"]], limit: 10 },
      maxLimit: 30,
      columnScope: "test.surface",
    });
  const custom = (scope: string) =>
    scopedLiveColumns(scope, "custom", {
      "cc-1": { domain: "number", sortable: true },
      "cc-2": { domain: null, sortable: true },
    });
  const ccField = (
    id: string,
    type: string,
    column: FieldDef<Thread>["column"],
  ): FieldDef<Thread> => ({
    id,
    label: id,
    type,
    value: () => null,
    column,
  });

  test("a member of the collection's scope sorts and filters under its wire name, and its set is handed to the codec", () => {
    const c = scopedThreads();
    const source = liveDataSource(c, { searchable: ["subject"] });
    const set = custom("test.surface");
    const plan = resolveLiveFields(
      [
        ccField("cc-1", "int", set.column("cc-1")),
        ccField("cc-2", "text", set.column("cc-2")),
      ],
      source,
      resolveOperatorSet,
      "test",
    );
    expect(plan.columnOf.get("cc-1")).toBe("custom.cc-1");
    expect(plan.filterFields.map((f) => f.id)).toEqual(["cc-1"]);
    expect(plan.sortFields.map((f) => f.id)).toEqual(["cc-1", "cc-2"]);
    expect([...plan.handles.values()]).toEqual([set]);
    // The codec takes it: the query names the member by wire name.
    expect(
      c.window.window.encode({
        orderBy: [["custom.cc-1", "desc"]],
        columns: [set],
      } as never).order,
    ).toBe('[["custom.cc-1","desc"]]');
  });

  test("a member of another scope throws where it is declared", () => {
    const source = liveDataSource(scopedThreads(), { searchable: [] });
    expect(() =>
      resolveLiveFields(
        [ccField("cc-1", "int", custom("elsewhere").column("cc-1"))],
        source,
        resolveOperatorSet,
        "test",
      ),
    ).toThrow(/scoped column of "elsewhere".*column scope is "test.surface"/);
  });

  test("a collection with no column scope takes no scoped member", () => {
    const source = liveDataSource(threads(), { searchable: [] });
    expect(() =>
      resolveLiveFields(
        [ccField("cc-1", "int", custom("test.surface").column("cc-1"))],
        source,
        resolveOperatorSet,
        "test",
      ),
    ).toThrow(/column scope is none/);
  });

  test("a scoped member's domain must be its field's operator set's", () => {
    const source = liveDataSource(scopedThreads(), { searchable: [] });
    expect(() =>
      resolveLiveFields(
        [ccField("cc-1", "text", custom("test.surface").column("cc-1"))],
        source,
        resolveOperatorSet,
        "test",
      ),
    ).toThrow(/filters over text/);
  });

  test("the surface listing a scoped collection must BE its scope (asserted at mount)", () => {
    const source = liveDataSource(scopedThreads(), { searchable: [] });
    expect(liveColumnScopeOf(source, "test.surface")).toBe("test.surface");
    expect(() => liveColumnScopeOf(source, "another.surface")).toThrow(
      /whose column scope is "test.surface"/,
    );
    expect(
      liveColumnScopeOf(liveDataSource(threads(), { searchable: [] }), "x"),
    ).toBeNull();
    expect(liveColumnScopeOf(undefined, "x")).toBeNull();
  });
});
