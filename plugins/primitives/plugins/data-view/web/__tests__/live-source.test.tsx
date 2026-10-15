/**
 * The DataView → live-window adapter (`useLiveSource`) over a real
 * `createLiveStateHarness` (a real client and its QueryClient): which window tuple a view state lowers
 * to (the tuple the scroll subscribes, read back from the query cache), and
 * how the scroll maps onto what the body renders.
 *
 * - the lowering: field id → column rename, the source's scope ANDed first,
 *   the search debounced, a duplicate order column dropped;
 * - a one-bucket-per-value grouping prepends its column and orders sections by
 *   appearance; a bucketed one neither prepends nor reorders;
 * - a saved rule on a field that does not resolve is pending while the
 *   deferred tier loads, and the error arm once it settled;
 * - the skeleton until the head settles, then an empty set is empty;
 * - the paging: `canGrow` / `complete` from the scroll;
 * - a failed head read is the body's read-error arm: the failure with Retry,
 *   whose click re-reads the head (never a bare "Couldn't load" line).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { stringListField } from "@plugins/fields/plugins/string-list/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { markDeferredLoadComplete } from "@plugins/framework/plugins/web-sdk/core";
import { resetDeferredLoadStateForTests } from "@plugins/framework/plugins/web-sdk/core/testing";
import {
  ResourceError,
  queryKeyFor,
} from "@plugins/primitives/plugins/live-state/web";
import {
  createLiveStateHarness,
  type LiveStateHarness,
} from "@plugins/primitives/plugins/live-state/web/testing";
import {
  liveCollection,
  type LiveQuery,
  type LiveWhere,
} from "@plugins/network/plugins/live/core";
import {
  and,
  clause,
  or,
  type Filter,
} from "@plugins/network/plugins/live/plugins/filter/core";
import {
  type FieldDef,
  type FieldGrouping,
  type FilterOperatorSet,
  type LiveDataSource,
  type ViewState,
} from "../../core";
import { liveDataSource } from "../internal/live-data-source";
import { liveGroupLowering, resolveLiveFields } from "../internal/live-fields";
import {
  useLiveSource,
  type FlatSourceView,
  type SectionedSourceView,
  type SourceView,
} from "../internal/live-source";
import { UnavailableSortRuleError } from "../internal/live-filter";
import { resolveBodyState } from "../internal/body-state";
import { BodyFallback } from "../components/body-fallback";

type Thread = {
  id: string;
  subject: string;
  /** Sorts, but no grouping can count it (not filterable). */
  folder: string;
  labelIds: string[];
  unread: boolean;
  lastMessageAt: Date;
};

let n = 0;
const threads = () =>
  liveCollection(`test.data-view.live-adapter-${n++}`, {
    fields: {
      subject: textField({ label: "Subject" }),
      labelIds: stringListField({ label: "Labels" }),
      unread: boolField({ label: "Unread" }),
      lastMessageAt: dateField({ label: "Last message" }),
    },
    // Sorts, but is not listed — so not filterable and no grouping can count it.
    carry: { fields: { id: textField(), folder: textField() } },
    id: "id",
    sortable: ["subject", "lastMessageAt", "folder"],
    default: { orderBy: [["lastMessageAt", "desc"]], limit: 2 },
    maxLimit: 6,
  });
type C = ReturnType<typeof threads>;

/** Operator sets reduced to what the lowering reads: a domain and one operator. */
const SETS: Record<string, FilterOperatorSet> = {
  text: {
    match: "text",
    domain: "text",
    operators: [
      {
        id: "is",
        label: "is",
        hasValue: true,
        lower: (operand, ctx) =>
          typeof operand === "string" && operand !== ""
            ? clause(ctx.column, "eq", operand)
            : undefined,
      },
    ],
  },
  tags: {
    match: "tags",
    domain: "stringArray",
    operators: [
      {
        id: "has-any",
        label: "has any",
        hasValue: true,
        lower: (operand, ctx) =>
          Array.isArray(operand) && operand.length > 0
            ? clause(ctx.column, "hasAny", operand as string[])
            : undefined,
      },
    ],
  },
  bool: { match: "bool", domain: "boolean", operators: [] },
  date: { match: "date", domain: "instant", operators: [] },
};
const resolveOperatorSet = (type: string) => SETS[type];

const PER_VALUE: FieldGrouping = {
  id: "value",
  label: "Value",
  oneBucketPerValue: true,
  plan: () => (v) => ({ key: String(v), label: String(v), order: 0 }),
};
const BY_DAY: FieldGrouping = {
  id: "day",
  label: "Day",
  plan: () => (v) => ({ key: String(v), label: String(v), order: 0 }),
};
const resolveGrouping = (_type: string, groupingId: string) =>
  groupingId === "day" ? BY_DAY : PER_VALUE;

function fieldsOf(c: C): FieldDef<Thread>[] {
  return [
    { id: "subject", label: "Subject", type: "text", value: (t) => t.subject },
    { id: "folder", label: "Folder", type: "text", value: (t) => t.folder },
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
  ];
}

const baseState: ViewState = { sort: [], filter: null, query: "" };
const NO_COLLAPSED: ReadonlySet<string> = new Set();

/** The flat arm of a source view — the one a scroll over the whole query reads. */
function flat<T>(view: SourceView<T> | null): FlatSourceView<T> {
  if (view?.kind !== "flat")
    throw new Error(`expected a flat view, got ${view?.kind}`);
  return view;
}

function mount(
  live: LiveStateHarness,
  c: C,
  initial: {
    state: ViewState;
    scoped?: boolean;
    awaiting?: boolean;
  },
) {
  const all = liveDataSource(c, { searchable: ["subject"] });
  const source = initial.awaiting
    ? all.awaitingScope(["unread"])
    : initial.scoped
      ? all.scoped({ where: { unread: true } })
      : all;
  const fields = fieldsOf(c);
  const plan = resolveLiveFields(fields, source, resolveOperatorSet, "host");
  vi.spyOn(live.notifications, "hasEverBeenReady").mockReturnValue(true);
  const rendered = renderHook(
    (p: { state: ViewState }) =>
      useLiveSource<Thread>({
        source,
        plan,
        fields,
        state: p.state,
        resolveOperatorSet,
        resolveGrouping,
        now: 0,
        collapsedSections: NO_COLLAPSED,
      }),
    { wrapper: live.Wrapper, initialProps: { state: initial.state } },
  );
  return rendered;
}

/** The window tuples of `c` the cache holds (one per subscribed segment). */
function tuples(client: QueryClient, c: C): unknown[] {
  return client
    .getQueryCache()
    .findAll()
    .filter((q) => (q.queryKey as unknown[])[0] === c.key)
    .map((q) => (q.queryKey as unknown[])[1] ?? {});
}
const expectTuple = (
  client: QueryClient,
  c: C,
  query: LiveQuery<C["filterable"], "subject" | "lastMessageAt" | "folder">,
) => expect(tuples(client, c)).toContainEqual(c.window.window.encode(query));

const wire = (ids: number[]) =>
  ids.map((i) => ({
    id: `t${i}`,
    subject: `s${i}`,
    folder: "inbox",
    labelIds: [],
    unread: true,
    lastMessageAt: new Date(i * 1000),
    $key: JSON.stringify([String(i), `t${i}`]),
  }));

beforeEach(() => resetDeferredLoadStateForTests());
afterEach(() => {
  cleanup();
  resetDeferredLoadStateForTests();
});

describe("useLiveSource — lowering", () => {
  it("renames a field onto its column, ANDs the scope first, and sorts by columns", () => {
    const c = threads();
    const live = createLiveStateHarness();
    const client = live.queryClient;
    mount(live, c, {
      scoped: true,
      state: {
        ...baseState,
        sort: [{ fieldId: "subject", direction: "asc" }],
        filter: {
          kind: "group",
          id: "g",
          conjunction: "and",
          children: [
            {
              kind: "rule",
              id: "r",
              fieldId: "labels",
              operatorId: "has-any",
              value: ["INBOX"],
            },
          ],
        },
      },
    });
    expectTuple(client, c, {
      where: and(
        clause("unread", "eq", true),
        clause("labelIds", "hasAny", ["INBOX"]),
      ),
      orderBy: [["subject", "asc"]],
      limit: 2,
    });
  });

  it("debounces the search, and a search-only change keeps the previous rows until the new head settles", async () => {
    const c = threads();
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const { result, rerender } = mount(live, c, { state: baseState });
    act(() => {
      client.setQueryData(queryKeyFor(c.key, { limit: "2" }), wire([1]));
    });
    await waitFor(() => expect(result.current!.loading).toBe(false));

    rerender({ state: { ...baseState, query: "hello" } });
    // Not yet: the keystroke has not settled.
    expect(tuples(client, c)).toHaveLength(1);
    const searched = c.window.window.encode({
      where: or(clause("subject", "contains", "hello")),
      limit: 2,
    });
    await waitFor(() => expect(tuples(client, c)).toContainEqual(searched), {
      timeout: 1000,
    });
    // The previous rows stay on screen, never the skeleton.
    expect(result.current!.loading).toBe(false);
    expect(result.current!.rows.map((r) => r.id)).toEqual(["t1"]);
    act(() => {
      client.setQueryData(queryKeyFor(c.key, searched), []);
    });
    await waitFor(() => expect(result.current!.rows).toEqual([]));
    expect(result.current!.loading).toBe(false);
  });

  it("a one-bucket-per-value grouping over a column no grouping counts leads the order (the default after it), sections by appearance", () => {
    const c = threads();
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const { result } = mount(live, c, {
      state: {
        ...baseState,
        groupBy: { fieldId: "folder", groupingId: "value" },
      },
    });
    expectTuple(client, c, {
      orderBy: [
        ["folder", "asc"],
        ["lastMessageAt", "desc"],
      ],
      limit: 2,
    });
    expect(flat(result.current).sectionOrder).toBe("appearance");
  });

  it("a grouped column the sort already names is not named twice", () => {
    const c = threads();
    const live = createLiveStateHarness();
    const client = live.queryClient;
    mount(live, c, {
      state: {
        ...baseState,
        sort: [
          { fieldId: "lastMessageAt", direction: "asc" },
          { fieldId: "folder", direction: "desc" },
        ],
        groupBy: { fieldId: "folder", groupingId: "value" },
      },
    });
    expectTuple(client, c, {
      orderBy: [
        ["folder", "desc"],
        ["lastMessageAt", "asc"],
      ],
      limit: 2,
    });
  });

  it("a bucketed grouping neither prepends nor reorders the user's sort", () => {
    const c = threads();
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const { result } = mount(live, c, {
      state: {
        ...baseState,
        sort: [{ fieldId: "subject", direction: "asc" }],
        groupBy: { fieldId: "lastMessageAt", groupingId: "day" },
      },
    });
    expectTuple(client, c, { orderBy: [["subject", "asc"]], limit: 2 });
    expect(flat(result.current).sectionOrder).toBe("bucket");
  });
});

describe("useLiveSource — states", () => {
  it("a scope not known yet reads nothing and is the loading state", () => {
    const c = threads();
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const { result } = mount(live, c, { awaiting: true, state: baseState });
    expect(result.current?.loading).toBe(true);
    expect(result.current?.rows).toEqual([]);
    expect(tuples(client, c)).toEqual([]);
  });

  it("a saved sort on a field that does not resolve is pending before the deferred tier settles, the error arm after", async () => {
    const c = threads();
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const { result } = mount(live, c, {
      state: {
        ...baseState,
        sort: [{ fieldId: "playCount", direction: "desc" }],
      },
    });
    expect(result.current!.loading).toBe(true);
    expect(result.current!.error).toBeNull();
    expect(tuples(client, c)).toHaveLength(0);
    act(() => markDeferredLoadComplete());
    await waitFor(() =>
      expect(result.current!.error).toBeInstanceOf(UnavailableSortRuleError),
    );
    expect(result.current!.loading).toBe(false);
  });

  it("the skeleton until the head settles; an empty head is the empty state", async () => {
    const c = threads();
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const { result } = mount(live, c, { state: baseState });
    expect(result.current!.loading).toBe(true);
    act(() => {
      client.setQueryData(queryKeyFor(c.key, { limit: "2" }), []);
    });
    await waitFor(() => expect(result.current!.loading).toBe(false));
    expect(result.current!.rows).toEqual([]);
    expect(flat(result.current).paging.complete).toBe(true);
  });

  it("the paging can grow while the scroll can", async () => {
    const c = threads();
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const { result } = mount(live, c, { state: baseState });
    act(() => {
      client.setQueryData(queryKeyFor(c.key, { limit: "2" }), wire([1, 2]));
    });
    await waitFor(() => expect(flat(result.current).paging.canGrow).toBe(true));
    expect(flat(result.current).paging.complete).toBe(false);
    expect(result.current!.rows.map((r) => r.id)).toEqual(["t1", "t2"]);
    // `$key` never reaches the view.
    expect(Object.keys(result.current!.rows[0]!)).not.toContain("$key");
  });
});

/**
 * The body's path for a live source, minus the views: the adapter's answer,
 * `resolveBodyState`, and what renders in place of the view.
 */
function LiveBody(props: {
  source: LiveDataSource<Thread>;
  fields: FieldDef<Thread>[];
}) {
  const plan = resolveLiveFields(
    props.fields,
    props.source,
    resolveOperatorSet,
    "host",
  );
  const origin = useLiveSource<Thread>({
    source: props.source,
    plan,
    fields: props.fields,
    state: baseState,
    resolveOperatorSet,
    resolveGrouping,
    now: 0,
    collapsedSections: NO_COLLAPSED,
  });
  const state = resolveBodyState({
    server: origin,
    readiness: undefined,
    readFields: [],
  });
  return state.kind === "view" ? (
    <ul>
      {origin!.rows.map((r) => (
        <li key={r.id}>{r.subject}</li>
      ))}
    </ul>
  ) : (
    <BodyFallback
      state={state}
      errorState={undefined}
      loadingState={<p>loading</p>}
      loadingVariant={undefined}
      loadingCount={undefined}
    />
  );
}

describe("useLiveSource — a failed head read", () => {
  it("renders the read's failure with Retry, and Retry re-reads the head", async () => {
    const c = threads();
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const source = liveDataSource(c, { searchable: ["subject"] });
    const notifications = live.notifications;
    vi.spyOn(notifications, "hasEverBeenReady").mockReturnValue(true);
    render(
      <live.Wrapper>
        <LiveBody source={source} fields={fieldsOf(c)} />
      </live.Wrapper>,
    );
    expect(screen.getByText("loading")).toBeTruthy();

    const head = queryKeyFor(c.key, { limit: "2" });
    const fetch = vi
      .spyOn(notifications, "fetchOverHttp")
      .mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      await expect(
        client.getQueryCache().find({ queryKey: head, exact: true })!.fetch(),
      ).rejects.toThrow("boom");
    });
    // The read's own failure, typed — not a bare server-error line.
    await waitFor(() => expect(screen.getByText(/boom/)).toBeTruthy());
    const retry = screen.getByRole("button", { name: "Retry" });

    fetch.mockResolvedValueOnce(wire([1, 2]));
    await act(async () => {
      fireEvent.click(retry);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText("s1")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("the adapter hands the head failure over as a read error, not a query error", async () => {
    const c = threads();
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const { result } = mount(live, c, { state: baseState });
    const notifications = live.notifications;
    vi.spyOn(notifications, "fetchOverHttp").mockRejectedValueOnce(
      new Error("boom"),
    );
    await act(async () => {
      await expect(
        client
          .getQueryCache()
          .find({ queryKey: queryKeyFor(c.key, { limit: "2" }), exact: true })!
          .fetch(),
      ).rejects.toThrow("boom");
    });
    await waitFor(() => expect(result.current!.readError).not.toBeNull());
    expect(result.current!.error).toBeNull();
    expect(result.current!.loading).toBe(false);
    expect(result.current!.readError!.error).toBeInstanceOf(ResourceError);
  });
});

/**
 * Grouped by a GROUPABLE column (an own filterable text / number / boolean
 * one), the source is server-sectioned: one grouping read lists the sections
 * with exact counts, and a section reads its own rows only once its footer
 * asked for them (expanded and in view), until it is collapsed.
 */
describe("useLiveSource — server sections", () => {
  function Sectioned(props: {
    source: LiveDataSource<Thread>;
    fields: FieldDef<Thread>[];
    state: ViewState;
    collapsed: ReadonlySet<string>;
    onView: (view: SourceView<Thread> | null) => void;
  }) {
    const plan = resolveLiveFields(
      props.fields,
      props.source,
      resolveOperatorSet,
      "host",
    );
    const view = useLiveSource<Thread>({
      source: props.source,
      plan,
      fields: props.fields,
      state: props.state,
      resolveOperatorSet,
      resolveGrouping,
      now: 0,
      collapsedSections: props.collapsed,
    });
    const { onView } = props;
    useEffect(() => onView(view));
    return view?.kind === "sectioned" ? <>{view.readers}</> : null;
  }

  function mountSectioned(
    live: LiveStateHarness,
    c: C,
    initial: { state: ViewState; scoped?: boolean },
  ) {
    const all = liveDataSource(c, { searchable: ["subject"] });
    const source = initial.scoped
      ? all.scoped({ where: { labelIds: { hasAny: ["INBOX"] } } })
      : all;
    const fields = fieldsOf(c);
    let latest: SourceView<Thread> | null = null;
    const onView = (view: SourceView<Thread> | null) => {
      latest = view;
    };
    vi.spyOn(live.notifications, "hasEverBeenReady").mockReturnValue(true);
    const tree = (state: ViewState, collapsed: ReadonlySet<string>) => (
      <live.Wrapper>
        <Sectioned
          source={source}
          fields={fields}
          state={state}
          collapsed={collapsed}
          onView={onView}
        />
      </live.Wrapper>
    );
    const rendered = render(tree(initial.state, NO_COLLAPSED));
    return {
      view(): SectionedSourceView<Thread> {
        const v = latest as SourceView<Thread> | null;
        if (v?.kind !== "sectioned") {
          throw new Error(`expected a sectioned view, got ${v?.kind}`);
        }
        return v;
      },
      rerender(state: ViewState, collapsed: ReadonlySet<string>) {
        rendered.rerender(tree(state, collapsed));
      },
    };
  }

  const groupsKey = (c: C, groupBy: "unread" | "subject", where?: Filter) =>
    queryKeyFor(
      `${c.key}:groups`,
      c.groups.groups.encode({
        groupBy,
        ...(where === undefined
          ? {}
          : { where: where as LiveWhere<C["filterable"]> }),
        limit: c.groups.groups.maxLimit,
      }),
    );
  const sectionKey = (c: C, where: Filter) =>
    queryKeyFor(
      c.key,
      c.window.window.encode({
        where: where as LiveWhere<C["filterable"]>,
        limit: 2,
      }),
    );
  const observers = (client: QueryClient, key: readonly unknown[]) =>
    client
      .getQueryCache()
      .find({ queryKey: key, exact: true })
      ?.getObserversCount() ?? 0;

  const byUnread: ViewState = {
    ...baseState,
    groupBy: { fieldId: "unread", groupingId: "value" },
  };

  it("reads ONE grouping over the view's whole where, and no rows until a section asks", async () => {
    const c = threads();
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const state: ViewState = {
      ...byUnread,
      filter: {
        kind: "group",
        id: "g",
        conjunction: "and",
        children: [
          {
            kind: "rule",
            id: "r",
            fieldId: "subject",
            operatorId: "is",
            value: "hello",
          },
        ],
      },
    };
    const m = mountSectioned(live, c, { state, scoped: true });
    const where = and(
      clause("labelIds", "hasAny", ["INBOX"]),
      clause("subject", "eq", "hello"),
    );
    await waitFor(() =>
      expect(observers(client, groupsKey(c, "unread", where))).toBeGreaterThan(
        0,
      ),
    );
    // One grouping read, and it is that one.
    expect(
      client
        .getQueryCache()
        .findAll()
        .filter((q) => (q.queryKey as unknown[])[0] === `${c.key}:groups`),
    ).toHaveLength(1);
    expect(m.view().loading).toBe(true);
    // The body's own scroll reads nothing: each section reads its own.
    expect(tuples(client, c)).toEqual([]);

    act(() => {
      client.setQueryData(groupsKey(c, "unread", where), [
        { value: true, count: 3 },
        { value: false, count: 2 },
        { value: null, count: 1 },
      ]);
    });
    await waitFor(() => expect(m.view().loading).toBe(false));
    const sections = m.view().sections;
    // Every section, with the server's exact count; "None" last.
    expect(sections.map((s) => [s.label, s.count])).toEqual([
      ["true", 3],
      ["false", 2],
      ["None", 1],
    ]);
    expect(sections.every((s) => s.rows.length === 0)).toBe(true);
    expect(sections.every((s) => s.paging.canGrow)).toBe(true);
    expect(tuples(client, c)).toEqual([]);
  });

  it("a section reads its value only once its footer asks; collapsing it unsubscribes", async () => {
    const c = threads();
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const m = mountSectioned(live, c, { state: byUnread });
    act(() => {
      client.setQueryData(groupsKey(c, "unread"), [
        { value: true, count: 3 },
        { value: false, count: 2 },
        { value: null, count: 1 },
      ]);
    });
    await waitFor(() => expect(m.view().sections).toHaveLength(3));

    // The footer of "false" came into view: its first page starts its read.
    act(() => m.view().sections[1]!.paging.loadMore());
    const falseKey = sectionKey(c, clause("unread", "eq", false));
    await waitFor(() => expect(observers(client, falseKey)).toBe(1));
    expect(tuples(client, c)).toHaveLength(1);
    expect(m.view().sections[1]!.paging.growing).toBe(true);

    act(() => {
      client.setQueryData(falseKey, wire([7, 8]));
    });
    await waitFor(() =>
      expect(m.view().sections[1]!.rows.map((r) => r.id)).toEqual(["t7", "t8"]),
    );
    expect(m.view().rows.map((r) => r.id)).toEqual(["t7", "t8"]);

    // "None" reads the empty value.
    act(() => m.view().sections[2]!.paging.loadMore());
    await waitFor(() =>
      expect(
        observers(client, sectionKey(c, clause("unread", "isEmpty"))),
      ).toBe(1),
    );

    // Collapsing "false" stops its read.
    m.rerender(byUnread, new Set(["false"]));
    await waitFor(() => expect(observers(client, falseKey)).toBe(0));
    expect(m.view().sections[1]!.rows).toEqual([]);
  });

  it("a blank text value is the one None; the grouping full at its max says so", async () => {
    const c = threads();
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const m = mountSectioned(live, c, {
      state: {
        ...baseState,
        groupBy: { fieldId: "subject", groupingId: "value" },
      },
    });
    const max = c.groups.groups.maxLimit;
    act(() => {
      client.setQueryData(groupsKey(c, "subject"), [
        { value: "", count: 2 },
        { value: null, count: 1 },
        ...Array.from({ length: max - 2 }, (_, i) => ({
          value: `s${i}`,
          count: 1,
        })),
      ]);
    });
    await waitFor(() => expect(m.view().loading).toBe(false));
    const sections = m.view().sections;
    expect(sections).toHaveLength(max - 2 + 1);
    expect(sections.at(-1)).toMatchObject({ label: "None", count: 3 });
    expect(m.view().groupsPaging.truncated).not.toBe(false);
    expect(m.view().groupsPaging.complete).toBe(false);
  });
});

describe("liveGroupLowering — what the Group-by control offers under a live source", () => {
  const c = threads();
  const source = liveDataSource(c, { searchable: ["subject"] });
  const fields: FieldDef<Thread>[] = [
    ...fieldsOf(c),
    // A derived value: bound to no column.
    { id: "derived", label: "Derived", type: "text", value: (t) => t.id },
  ];
  const plan = resolveLiveFields(fields, source, resolveOperatorSet, "host");
  const field = (id: string) => fields.find((f) => f.id === id)!;

  it("server sections over a groupable column", () => {
    expect(liveGroupLowering(plan, field("unread"), PER_VALUE)).toMatchObject({
      kind: "sections",
      column: { name: "unread", domain: "boolean" },
    });
    expect(liveGroupLowering(plan, field("subject"), PER_VALUE).kind).toBe(
      "sections",
    );
  });

  it("an order prefix over a column that only sorts", () => {
    expect(liveGroupLowering(plan, field("folder"), PER_VALUE)).toEqual({
      kind: "prefix",
      column: "folder",
    });
  });

  it("buckets over a sortable column; nothing over a derived value", () => {
    expect(liveGroupLowering(plan, field("lastMessageAt"), BY_DAY).kind).toBe(
      "buckets",
    );
    expect(liveGroupLowering(plan, field("derived"), PER_VALUE).kind).toBe(
      "none",
    );
    expect(liveGroupLowering(plan, field("unread"), BY_DAY).kind).toBe("none");
  });
});
