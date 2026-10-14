/**
 * A UNION collection (`liveCollection(key, { arms })`, T12) and its arms' own
 * fields (`liveArm`, A16), plus the owner-discriminated column declarations
 * every reader switches on (T11).
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { nullable } from "@plugins/fields/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { liveText } from "@plugins/network/plugins/live/plugins/filter/core";
import { exposedColumns } from "./exposed-columns";
import { liveCollection } from "./live-collection";
import {
  liveArm,
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

/** The build arm's one field, as its core would declare it. */
const BUILD_FIELDS = { exitCode: nullable(intField({ label: "Exit code" })) };

describe("liveCollection — the `arms` overload", () => {
  test("a union is a window whose rows carry `$columns`", () => {
    const c = runs();
    expect(c.arms).toEqual({ discriminator: "kind" });
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

  test("runtime throws mirror the overload: exposes, columnScope, no default, a bad discriminator", () => {
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
        exposes: { base: entityRef("runs", {}) },
      }),
    ).toThrow(/exposes beside `arms`/);
    // The deleted `contributed` option fails loudly rather than being ignored.
    expect(() =>
      untyped(`test.live.arms-bad-${seq++}`, {
        ...base,
        arms: { discriminator: "kind" },
        contributed: true,
      }),
    ).toThrow(/`contributed` no longer exists/);
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

  test("types: the overload refuses exposes / columnScope, and types the discriminator (T12)", () => {
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
      // Overload resolution reports the refused spec at every field the last
      // overload tried (the fields spelling's) has no place for.
      liveCollection("t.b", {
        ...spec,
        // @ts-expect-error — a union's columns are its arms', never exposed
        arms: { discriminator: "kind" },
        // @ts-expect-error — (the same refusal, reported at the field)
        exposes: { base: entityRef("runs", {}) },
      });
      liveCollection("t.c", {
        ...spec,
        // @ts-expect-error — nor scoped
        arms: { discriminator: "kind" },
        columnScope: "s",
      });
      liveCollection("t.d", {
        ...spec,
        // @ts-expect-error — the discriminator is a row field
        arms: { discriminator: "nope" },
      });
    };
    void _typesOnly;
  });
});

describe("liveArm — the column set", () => {
  test("wire names are `<arm>.<field>`; the owner names the collection and the arm", () => {
    const c = runs();
    const build = liveArm(c, "build", {
      label: "Build",
      fields: BUILD_FIELDS,
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
    const build = liveArm(c, "build", { label: "Build", fields: BUILD_FIELDS });
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
      liveArm(
        // @ts-expect-error — only a union collection has arms
        plain,
        "build",
        { label: "Build", fields: BUILD_FIELDS },
      ),
    ).toThrow(/not declared with `arms`/);
    expect(() =>
      liveArm(runs(), "a.b", { label: "A", fields: BUILD_FIELDS }),
    ).toThrow(/plain identifier/);
  });
});

describe("the codec switches on the owner (T11)", () => {
  test("a union decodes its arms' columns; an exposed / scoped set is refused there; an arm set elsewhere is refused", () => {
    const c = runs();
    const build = liveArm(c, "build", {
      label: "Build",
      fields: BUILD_FIELDS,
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

    // An exposure is read by a collection reaching its entity — never a union.
    const runsEntity = entityRef("test_arm_runs", {});
    const extra = exposedColumns(
      defineExtensionShape({
        key: "runKey",
        fields: { size: intField({ label: "Size", default: 0 }) },
        exposes: { parent: runsEntity, name: "extra", fields: { size: {} } },
      }).exposure,
    );
    expect(() =>
      c.window.window.encode({
        orderBy: [[extra.wireName("size"), "asc"]],
        columns: [extra],
      } as never),
    ).toThrow(/which the collection's `exposes` does not reach/);
    const host = liveCollection(`test.live.arms-ex-${seq++}`, {
      row: Run,
      id: "runKey",
      filterable: {},
      sortable: ["startedAt"],
      default: { orderBy: [["startedAt", "desc"]], limit: 10 },
      maxLimit: 30,
      exposes: { base: runsEntity },
    });
    expect(() =>
      host.window.window.encode({
        orderBy: [["build.exitCode", "asc"]],
        columns,
      } as never),
    ).toThrow(/not declared with `arms`/);
  });
});
