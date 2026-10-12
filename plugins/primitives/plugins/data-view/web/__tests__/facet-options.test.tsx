/**
 * A live source's facets (`liveDataSource({ facets })`): each facet column's
 * values, read live as a grouping, handed to the field over that column as its
 * `optionsResult` — over `createLiveStateHarness` (a real client and its QueryClient), the
 * grouping tuple read back from the query cache.
 *
 * - declaration: a facet must be a declared text column, read by a field that
 *   declares no `options` of its own;
 * - the states: loading until the grouping settles (and while the scope is
 *   awaited), the failure with Retry, a grouping full at its max the error arm;
 * - the options: value-sorted (never count-ordered), NULL dropped, and the same
 *   list — same identity — across a count change;
 * - the filter input renders loading / the failure with Retry, never an empty
 *   grid.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { z } from "zod";
import {
  ResourceError,
  queryKeyFor,
} from "@plugins/primitives/plugins/live-state/web";
import {
  createLiveStateHarness,
  type LiveStateHarness,
} from "@plugins/primitives/plugins/live-state/web/testing";
import { liveCollection } from "@plugins/network/plugins/live/core";
import {
  liveBoolean,
  liveInstant,
  liveText,
} from "@plugins/network/plugins/live/plugins/filter/core";
import type {
  FieldDef,
  FieldOptionsResult,
  FilterOperatorSet,
  LiveDataSource,
} from "../../core";
import { liveDataSource } from "../internal/live-data-source";
import {
  CollectFacetOptions,
  facetFieldColumns,
  facetOptionsResult,
} from "../internal/facet-options";
import { ChipSelectFilterInput } from "../components/filter/chip-select-filter-input";

const Report = z.object({
  id: z.string(),
  kind: z.string(),
  source: z.string(),
  noise: z.boolean(),
  lastSeenAt: z.date(),
});
type Report = z.infer<typeof Report>;

let n = 0;
const reports = () =>
  liveCollection(`test.data-view.facets-${n++}`, {
    row: Report,
    id: "id",
    filterable: {
      kind: liveText(),
      source: liveText(),
      noise: liveBoolean(),
      lastSeenAt: liveInstant(),
    },
    sortable: ["lastSeenAt"],
    default: { orderBy: [["lastSeenAt", "desc"]], limit: 2 },
    maxLimit: 6,
    scroll: true,
  });
type C = ReturnType<typeof reports>;

const SETS: Record<string, FilterOperatorSet> = {
  enum: { match: "enum", domain: "text", operators: [] },
  bool: { match: "bool", domain: "boolean", operators: [] },
};
const resolveOperatorSet = (type: string) => SETS[type];

const fieldsOf = (): FieldDef<Report>[] => [
  { id: "kind", label: "Kind", type: "enum", value: (r) => r.kind },
  { id: "source", label: "Source", type: "enum", value: (r) => r.source },
  { id: "noise", label: "Noise", type: "bool", value: (r) => r.noise },
];

/** The grouping tuple a facet over `column` reads (max limit, scope as `where`). */
const groupsKey = (c: C, column: "kind" | "source") =>
  queryKeyFor(
    `${c.key}:groups`,
    c.groups.groups.encode({
      groupBy: column,
      limit: c.groups.groups.maxLimit,
    }),
  );

/** Mount the facet overlay; `latest()` is the schema it last handed down. */
function mount(live: LiveStateHarness, source: LiveDataSource<Report>) {
  let latest: FieldDef<unknown>[] = [];
  vi.spyOn(live.notifications, "hasEverBeenReady").mockReturnValue(true);
  const view = (s: LiveDataSource<Report>) => (
    <live.Wrapper>
      <CollectFacetOptions
        source={s as LiveDataSource<unknown>}
        fields={fieldsOf() as FieldDef<unknown>[]}
        resolveOperatorSet={resolveOperatorSet}
      >
        {(fields) => {
          latest = fields;
          return null;
        }}
      </CollectFacetOptions>
    </live.Wrapper>
  );
  const rendered = render(view(source));
  return {
    optionsOf: (id: string) =>
      latest.find((f) => f.id === id)!.optionsResult as
        FieldOptionsResult | undefined,
    rerender: (s: LiveDataSource<Report>) => rendered.rerender(view(s)),
    notifications: live.notifications,
  };
}

const refetch = () => Promise.resolve();
const ready = (data: { value: string | null; count: number }[]) =>
  ({ status: "ready", data, refetch }) as const;

afterEach(() => cleanup());

describe("liveDataSource({ facets }) — declaration", () => {
  it("refuses a facet that is not a declared text column", () => {
    const c = reports();
    expect(() =>
      liveDataSource(c, {
        searchable: [],
        facets: ["noise" as "kind"],
      }),
    ).toThrow(/facet column "noise" must be a declared text column/);
  });

  it("refuses a field over a facet that declares its own options, and a facet no field reads", () => {
    const columnOf = new Map([
      ["kind", "kind"],
      ["source", "source"],
    ]);
    const declared: FieldDef<unknown>[] = [
      { id: "kind", label: "Kind", options: [{ value: "a", label: "a" }] },
    ];
    expect(() => facetFieldColumns(declared, ["kind"], columnOf, "c")).toThrow(
      /declares `options`/,
    );
    expect(() =>
      facetFieldColumns(
        [{ id: "kind", label: "Kind" }],
        ["kind", "source"],
        columnOf,
        "c",
      ),
    ).toThrow(/facet "source", but no field reads/);
  });
});

describe("facetOptionsResult", () => {
  it("is loading, then the error arm with Retry when the read failed", () => {
    expect(
      facetOptionsResult({ status: "loading", refetch }, "kind", 100),
    ).toEqual({ status: "loading" });
    const error = new ResourceError("loader-failed", "boom", null);
    const failed = facetOptionsResult(
      { status: "error", error, refetch },
      "kind",
      100,
    );
    expect(failed).toEqual({ status: "error", error, refetch });
  });

  it("sorts options by value, never by count, and drops the NULL group", () => {
    const result = facetOptionsResult(
      ready([
        { value: "crash", count: 9 },
        { value: null, count: 5 },
        { value: "build", count: 1 },
        { value: "audit", count: 3 },
      ]),
      "kind",
      100,
    );
    expect(result).toEqual({
      status: "ready",
      options: ["audit", "build", "crash"].map((v) => ({ value: v, label: v })),
    });
  });

  it("a grouping full at its max is refused: the error arm (incomplete)", () => {
    const full = Array.from({ length: 3 }, (_, i) => ({
      value: `v${i}`,
      count: 1,
    }));
    const result = facetOptionsResult(ready(full), "kind", 3);
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.error).toBeInstanceOf(ResourceError);
    expect(result.error.message).toMatch(/"kind" takes more than 2 values/);
    // One short of the max is complete.
    expect(facetOptionsResult(ready(full.slice(1)), "kind", 3).status).toBe(
      "ready",
    );
  });
});

describe("CollectFacetOptions", () => {
  it("is loading until the grouping settles, then value-sorted options that stay put across a count change", async () => {
    const c = reports();
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const source = liveDataSource(c, { searchable: [], facets: ["kind"] });
    const { optionsOf } = mount(live, source);

    expect(optionsOf("kind")).toEqual({ status: "loading" });
    // A field over no facet is untouched.
    expect(optionsOf("source")).toBeUndefined();

    act(() => {
      client.setQueryData(groupsKey(c, "kind"), [
        { value: "crash", count: 5 },
        { value: "audit", count: 2 },
      ]);
    });
    await waitFor(() => expect(optionsOf("kind")?.status).toBe("ready"));
    const first = optionsOf("kind");
    expect(first).toEqual({
      status: "ready",
      options: [
        { value: "audit", label: "audit" },
        { value: "crash", label: "crash" },
      ],
    });

    // The counts flip (the grouping re-orders by count): same options, same object.
    act(() => {
      client.setQueryData(groupsKey(c, "kind"), [
        { value: "audit", count: 9 },
        { value: "crash", count: 5 },
      ]);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(optionsOf("kind")).toBe(first);

    // A new value is inserted in place.
    act(() => {
      client.setQueryData(groupsKey(c, "kind"), [
        { value: "audit", count: 9 },
        { value: "crash", count: 5 },
        { value: "build", count: 1 },
      ]);
    });
    await waitFor(() =>
      expect(
        (
          optionsOf("kind") as unknown as { options: { value: string }[] }
        ).options.map((o) => o.value),
      ).toEqual(["audit", "build", "crash"]),
    );
  });

  it("reads the grouping over the scope, and nothing while the scope is awaited", async () => {
    const c = reports();
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const all = liveDataSource(c, { searchable: [], facets: ["kind"] });
    const { optionsOf, rerender } = mount(live, all.awaitingScope(["noise"]));
    const groupTuples = () =>
      client
        .getQueryCache()
        .findAll()
        .filter((q) => (q.queryKey as unknown[])[0] === `${c.key}:groups`);
    expect(optionsOf("kind")).toEqual({ status: "loading" });
    expect(groupTuples()).toHaveLength(0);

    rerender(all.scoped({ where: { noise: false } }));
    const scopedKey = queryKeyFor(
      `${c.key}:groups`,
      c.groups.groups.encode({
        groupBy: "kind",
        where: { noise: false },
        limit: c.groups.groups.maxLimit,
      }),
    );
    await waitFor(() =>
      expect(groupTuples().map((q) => q.queryKey)).toContainEqual(scopedKey),
    );
    act(() => {
      client.setQueryData(scopedKey, [{ value: "crash", count: 1 }]);
    });
    await waitFor(() =>
      expect(optionsOf("kind")).toEqual({
        status: "ready",
        options: [{ value: "crash", label: "crash" }],
      }),
    );
  });

  it("a failed grouping is the error arm, and its Retry re-reads it", async () => {
    const c = reports();
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const source = liveDataSource(c, { searchable: [], facets: ["kind"] });
    const { optionsOf, notifications } = mount(live, source);
    const fetch = vi
      .spyOn(notifications, "fetchOverHttp")
      .mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      await expect(
        client
          .getQueryCache()
          .find({ queryKey: groupsKey(c, "kind"), exact: true })!
          .fetch(),
      ).rejects.toThrow("boom");
    });
    await waitFor(() => expect(optionsOf("kind")?.status).toBe("error"));
    const failed = optionsOf("kind");
    if (failed?.status !== "error") throw new Error("expected the error arm");
    expect(failed.error.message).toMatch(/boom/);

    fetch.mockResolvedValueOnce([{ value: "audit", count: 1 }]);
    await act(async () => {
      await failed.refetch();
    });
    await waitFor(() =>
      expect(optionsOf("kind")).toEqual({
        status: "ready",
        options: [{ value: "audit", label: "audit" }],
      }),
    );
  });
});

describe("ChipSelectFilterInput over read options", () => {
  const open = () =>
    fireEvent.click(
      screen.getByRole("button", { name: "Select filter values" }),
    );
  const field = (optionsResult: FieldOptionsResult): FieldDef<unknown> => ({
    id: "kind",
    label: "Kind",
    type: "enum",
    optionsResult,
  });

  it("renders loading, never an empty grid", () => {
    render(
      <ChipSelectFilterInput
        multiple
        value={undefined}
        onChange={() => {}}
        field={field({ status: "loading" })}
      />,
    );
    open();
    expect(screen.getByText("Loading options…")).toBeTruthy();
    expect(screen.queryByText("No matches")).toBeNull();
  });

  it("renders the failure with Retry, which re-reads", async () => {
    const retry = vi.fn(() => Promise.resolve());
    const error = new ResourceError("loader-failed", "boom", null);
    render(
      <ChipSelectFilterInput
        multiple
        value={undefined}
        onChange={() => {}}
        field={field({ status: "error", error, refetch: retry })}
      />,
    );
    open();
    expect(screen.getByText(/boom/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await Promise.resolve();
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("lists the ready options", () => {
    render(
      <ChipSelectFilterInput
        multiple
        value={undefined}
        onChange={() => {}}
        field={field({
          status: "ready",
          options: [{ value: "audit", label: "audit" }],
        })}
      />,
    );
    open();
    expect(screen.getByText("audit")).toBeTruthy();
  });
});
