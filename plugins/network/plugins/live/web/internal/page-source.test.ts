import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { liveText } from "@plugins/network/plugins/live/plugins/filter/core";
import { liveCollection, liveValue } from "../../core";
import { startPages } from "../../shared/page-plan";
import { pageZeroParams } from "../testing";
import { pageSourceOf } from "./page-source";

const Row = z.object({
  id: z.string(),
  title: z.string(),
  endedAt: z.coerce.date().nullable(),
});

let seq = 0;
const scrolled = (limit: number) =>
  liveCollection(`test.page-source.${seq++}`, {
    row: Row,
    id: "id",
    filterable: { title: liveText() },
    sortable: ["endedAt", "title"],
    default: { orderBy: [["endedAt", "desc"]], limit },
    maxLimit: 4 * limit,
  });

describe("pageSourceOf — a collection's window", () => {
  it("page 0 of the empty question is the default tuple (boot-snapshot equality)", () => {
    for (const limit of [1, 20, 100]) {
      const c = scrolled(limit);
      expect(pageZeroParams(c)).toEqual(c.window.defaultParams);
    }
    // A preloaded one, declared like the conversations' `conversationsGone`.
    const booted = liveCollection(`test.page-source.${seq++}`, {
      row: Row,
      id: "id",
      filterable: {},
      sortable: ["endedAt"],
      default: { orderBy: [["endedAt", "desc"]], limit: 50 },
      maxLimit: 500,
      count: true,
      preload: "boot",
    });
    expect(pageZeroParams(booted)).toEqual(booted.window.defaultParams);
  });

  it("page 0 of a question is that question's plain window tuple", () => {
    const c = scrolled(20);
    const source = pageSourceOf(c);
    const [start] = startPages({ ...source.limits, staleRows: 0 }).pages;
    const query = {
      where: { title: "a" },
      orderBy: [["title", "asc"]] as const,
    };
    expect(source.params(query, start!.page)).toEqual(
      c.window.window.encode(query),
    );
  });

  it("a later page carries its limit and cuts", () => {
    const c = scrolled(20);
    const after = JSON.stringify(["2026-09-30 10:00:00+00", "r1"]);
    const until = JSON.stringify(["2026-09-29 10:00:00+00", "r9"]);
    expect(pageSourceOf(c).params({}, { after, until, limit: 40 })).toEqual({
      limit: "40",
      after,
      until,
    });
  });

  it("is one source per declaration, with the collection's limits and id", () => {
    const c = scrolled(20);
    const source = pageSourceOf(c);
    expect(pageSourceOf(c)).toBe(source);
    expect(source.limits).toEqual({ step: 20, maxLimit: 80 });
    expect(source.idField).toBe("id");
    expect(source.descriptor).toBe(
      c.window as unknown as typeof source.descriptor,
    );
  });

  it("base names the collection and the question, not a column set", () => {
    const a = scrolled(20);
    const b = scrolled(20);
    expect(pageSourceOf(a).base({})).not.toBe(pageSourceOf(b).base({}));
    expect(pageSourceOf(a).base({ columns: [] })).toBe(
      pageSourceOf(a).base({}),
    );
  });

  it("the detached source reads nothing", () => {
    const detached = pageSourceOf(null);
    expect(() =>
      detached.params({}, { after: null, until: null, limit: 1 }),
    ).toThrow(/encodes nothing/);
  });
});

describe("pageSourceOf — a paged value", () => {
  const Item = z.object({ id: z.string(), at: z.string() });
  const value = liveValue(`test.page-source.value.${seq++}`, {
    query: z.object({ metric: z.string(), days: z.number().default(7) }),
    paged: {
      item: Item,
      id: "id",
      key: { of: (i) => [i.at], order: ["desc"] },
      limit: 5,
      maxLimit: 50,
    },
  });

  it("page 0 at the step is { q, limit } — the tuple a plain read names", () => {
    const source = pageSourceOf(value);
    const [start] = startPages({ ...source.limits, staleRows: 0 }).pages;
    expect(source.params({ metric: "m" }, start!.page)).toEqual({
      q: '{"days":7,"metric":"m"}',
      limit: "5",
    });
  });

  it("a page's cuts ride verbatim", () => {
    const after = JSON.stringify(["9", "a"]);
    expect(
      pageSourceOf(value).params(
        { metric: "m" },
        { after, until: null, limit: 10 },
      ),
    ).toEqual({ q: '{"days":7,"metric":"m"}', limit: "10", after });
  });

  it("is one source per declaration: the value's limits and id, its descriptor keyed by the id", () => {
    const source = pageSourceOf(value);
    expect(pageSourceOf(value)).toBe(source);
    expect(source.limits).toEqual({ step: 5, maxLimit: 50 });
    expect(source.idField).toBe("id");
    // A page is a keyed window (D3): its rows are identified by the id.
    expect(source.descriptor.keyed?.keyOf({ id: "a", $key: null })).toBe("a");
    expect(source.columnsOf({ metric: "m" })).toBeUndefined();
  });

  it("base is the value and the question's canonical q — a default folds in", () => {
    const source = pageSourceOf(value);
    expect(source.base({ metric: "m" })).toBe(
      source.base({ metric: "m", days: 7 }),
    );
    expect(source.base({ metric: "m" })).not.toBe(source.base({ metric: "n" }));
  });
});
