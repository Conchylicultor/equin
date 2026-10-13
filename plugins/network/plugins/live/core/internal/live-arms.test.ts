/**
 * A UNION collection (`liveCollection(key, { arms })`, T12) and its arms' own
 * column sets (`liveArmColumns`, A16), plus the owner-discriminated column
 * declarations every reader switches on (T11).
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  liveNumber,
  liveText,
} from "@plugins/network/plugins/live/plugins/filter/core";
import { liveCollection } from "./live-collection";
import {
  liveArmColumns,
  liveColumns,
  LIVE_COLUMNS_KEY,
  scopedLiveColumns,
  type LiveColumnsDeclaration,
} from "./live-columns";

const Run = z.object({
  runKey: z.string(),
  kind: z.string(),
  label: z.string(),
  startedAt: z.number(),
});

let seq = 0;
const runs = () =>
  liveCollection(`test.live.arms-${seq++}`, {
    row: Run,
    id: "runKey",
    arms: { discriminator: "kind" },
    filterable: { kind: liveText(), label: liveText() },
    sortable: ["startedAt"],
    default: { orderBy: [["startedAt", "desc"]], limit: 10 },
    maxLimit: 30,
  });

const BuildRow = z.object({ exitCode: z.number().nullable() });

describe("liveCollection — the `arms` overload", () => {
  test("a union is a window whose rows carry `$columns`", () => {
    const c = runs();
    expect(c.arms).toEqual({ discriminator: "kind" });
    expect(c.contributed).toBe(false);
    expect(c.columnScope).toBeNull();
    // `rowKeys` stay the author's fields: `$columns` is folded, never bound.
    expect(c.rowKeys).toEqual(["runKey", "kind", "label", "startedAt"]);
    const parsed = c.row.parse({
      runKey: "build:1",
      kind: "build",
      label: "x",
      startedAt: 1,
      [LIVE_COLUMNS_KEY]: { build: { exitCode: 0 } },
    });
    expect(parsed.$columns).toEqual({ build: { exitCode: 0 } });
  });

  test("a single-table collection is `arms: null`", () => {
    const c = liveCollection(`test.live.arms-plain-${seq++}`, {
      row: Run,
      id: "runKey",
      filterable: {},
      sortable: ["startedAt"],
      default: { orderBy: [["startedAt", "desc"]], limit: 10 },
      maxLimit: 30,
    });
    expect(c.arms).toBeNull();
  });

  test("runtime throws mirror the overload: contributed, columnScope, no default, a bad discriminator", () => {
    const base = {
      row: Run,
      id: "runKey",
      filterable: {},
      sortable: ["startedAt"],
      default: { orderBy: [["startedAt", "desc"]], limit: 10 },
      maxLimit: 30,
    } as const;
    // Untyped callers: each spec is one the overloads refuse.
    const untyped = liveCollection as unknown as (
      key: string,
      spec: Record<string, unknown>,
    ) => unknown;
    expect(() =>
      untyped(`test.live.arms-bad-${seq++}`, {
        ...base,
        arms: { discriminator: "kind" },
        contributed: true,
      }),
    ).toThrow(/contributed beside `arms`/);
    expect(() =>
      untyped(`test.live.arms-bad-${seq++}`, {
        ...base,
        arms: { discriminator: "kind" },
        columnScope: "s",
      }),
    ).toThrow(/columnScope beside `arms`/);
    expect(() =>
      untyped(`test.live.arms-bad-${seq++}`, {
        row: Run,
        id: "runKey",
        arms: { discriminator: "kind" },
      }),
    ).toThrow(/without `default`/);
    expect(() =>
      untyped(`test.live.arms-bad-${seq++}`, {
        ...base,
        arms: { discriminator: "nope" },
      }),
    ).toThrow(/"nope" is not a field/);
    expect(() =>
      untyped(`test.live.arms-bad-${seq++}`, {
        ...base,
        arms: { discriminator: "runKey" },
      }),
    ).toThrow(/is the id/);
  });

  test("types: the overload refuses contributed / columnScope, and types the discriminator (T12)", () => {
    // Never called — the assertions are the `@ts-expect-error`s.
    const _typesOnly = () => {
      const spec = {
        row: Run,
        id: "runKey",
        filterable: {},
        sortable: ["startedAt"],
        default: { orderBy: [["startedAt", "desc"]], limit: 10 },
        maxLimit: 30,
      } as const;
      // A union needs nothing beside `arms`: every window pages.
      liveCollection("t.a", { ...spec, arms: { discriminator: "kind" } });
      // One line per refused call: past three failed overloads TypeScript may
      // report the call itself rather than the field at fault.
      const arms = { discriminator: "kind" } as const;
      // @ts-expect-error — a union's columns are its arms', never contributed
      liveCollection("t.b", { ...spec, arms, contributed: true });
      // @ts-expect-error — nor scoped
      liveCollection("t.c", { ...spec, arms, columnScope: "s" });
      const nope = { discriminator: "nope" } as const;
      // @ts-expect-error — the discriminator is a row field
      liveCollection("t.d", { ...spec, arms: nope });
    };
    void _typesOnly;
  });
});

describe("liveArmColumns", () => {
  test("wire names are `<arm>.<field>`; the owner names the collection and the arm", () => {
    const c = runs();
    const build = liveArmColumns(c, "build", {
      row: BuildRow,
      filterable: { exitCode: liveNumber() },
      sortable: ["exitCode"],
    });
    expect(build.owner).toEqual({
      kind: "arm",
      collection: c.key,
      arm: "build",
    });
    expect(build.name).toBe("build");
    expect(build.wireName("exitCode")).toBe("build.exitCode");
    expect(Object.keys(build.wireFilterable)).toEqual(["build.exitCode"]);
    expect(build.wireSortable).toEqual(["build.exitCode"]);
    const ref = build.column("exitCode");
    expect(ref.owner).toEqual(build.owner);
    expect(ref.name).toBe("build.exitCode");
    expect(ref.handle).toBe(build);
  });

  test("read: null on another arm's row; its own slice parsed once; a missing own slice throws (A16)", () => {
    const c = runs();
    const build = liveArmColumns(c, "build", {
      row: BuildRow,
      filterable: {},
      sortable: [],
    });
    const other = {
      runKey: "backup:1",
      kind: "backup",
      label: "b",
      startedAt: 1,
      $columns: { backup: { size: 3 } },
    };
    expect(build.read(other)).toBeNull();
    const own = {
      runKey: "build:1",
      kind: "build",
      label: "b",
      startedAt: 1,
      $columns: { build: { exitCode: 2 } },
    };
    const first = build.read(own);
    expect(first).toEqual({ exitCode: 2 });
    expect(build.read(own)).toBe(first);
    expect(() =>
      build.read({ ...own, $columns: { backup: { size: 3 } } }),
    ).toThrow(/carries no "build" slice .*A16/);
  });

  test("throws on a collection without `arms`, and on an arm KIND_RE refuses", () => {
    const plain = liveCollection(`test.live.arms-plain-${seq++}`, {
      row: Run,
      id: "runKey",
      filterable: {},
      sortable: ["startedAt"],
      default: { orderBy: [["startedAt", "desc"]], limit: 10 },
      maxLimit: 30,
    });
    expect(() =>
      liveArmColumns(
        // @ts-expect-error — only a union collection has arms
        plain,
        "build",
        { row: BuildRow, filterable: {}, sortable: [] },
      ),
    ).toThrow(/not declared with `arms`/);
    expect(() =>
      liveArmColumns(runs(), "a.b", {
        row: BuildRow,
        filterable: {},
        sortable: [],
      }),
    ).toThrow(/plain identifier/);
  });
});

describe("the codec switches on the owner (T11)", () => {
  test("a union decodes its arms' columns; a contributed / scoped set is refused there; an arm set elsewhere is refused", () => {
    const c = runs();
    const build = liveArmColumns(c, "build", {
      row: BuildRow,
      filterable: { exitCode: liveNumber() },
      sortable: ["exitCode"],
    });
    const columns: readonly LiveColumnsDeclaration[] = [build];
    const params = c.window.window.encode({
      where: { "build.exitCode": 1 },
      orderBy: [["build.exitCode", "asc"]],
      columns,
    } as never);
    const decoded = c.window.window.decode(params, columns);
    expect(decoded.orderBy[0] as readonly string[]).toEqual([
      "build.exitCode",
      "asc",
    ]);

    const scoped = scopedLiveColumns("s", "custom", {
      a: { domain: "text", sortable: true },
    });
    expect(() =>
      c.window.window.encode({
        orderBy: [["custom.a", "asc"]],
        columns: [scoped],
      } as never),
    ).toThrow(/declares no `columnScope`/);

    const other = runs();
    expect(() =>
      other.window.window.encode({
        orderBy: [["build.exitCode", "asc"]],
        columns,
      } as never),
    ).toThrow(/arm columns "build" belong to "test.live.arms-/);

    const contributedHost = liveCollection(`test.live.arms-co-${seq++}`, {
      row: Run,
      id: "runKey",
      filterable: {},
      sortable: ["startedAt"],
      default: { orderBy: [["startedAt", "desc"]], limit: 10 },
      maxLimit: 30,
      contributed: true,
    });
    const contributed = liveColumns(contributedHost, "extra", {
      row: BuildRow,
      filterable: {},
      sortable: ["exitCode"],
    });
    expect(contributed.owner).toEqual({
      kind: "contributed",
      collection: contributedHost.key,
    });
    expect(() =>
      c.window.window.encode({
        orderBy: [["extra.exitCode", "asc"]],
        columns: [contributed],
      } as never),
    ).toThrow(/not declared `contributed: true`/);
    expect(() =>
      contributedHost.window.window.encode({
        orderBy: [["build.exitCode", "asc"]],
        columns,
      } as never),
    ).toThrow(/not declared with `arms`/);
  });
});
