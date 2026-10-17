/**
 * A UNION collection (`liveCollection(key, { arms })`, T12) and its arms' own
 * fields (`liveArm`, A16), plus the owner-discriminated column declarations
 * every reader switches on (T11).
 */

import { describe, expect, test } from "bun:test";
import { nullable } from "@plugins/fields/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { exposedColumns } from "./exposed-columns";
import { liveCollection } from "./live-collection";
import {
  liveArm,
  LIVE_COLUMNS_KEY,
  scopedLiveColumns,
  type LiveColumnsDeclaration,
} from "./live-columns";

const RUN = {
  runKey: textField({ label: "Key" }),
  kind: textField({ label: "Kind" }),
  label: textField({ label: "Label" }),
  startedAt: intField({ label: "Started" }),
};

let seq = 0;
const runs = () =>
  liveCollection(`test.live.arms-${seq++}`, {
    fields: RUN,
    id: "runKey",
    arms: { discriminator: "kind" },
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
      fields: RUN,
      id: "runKey",
      sortable: ["startedAt"],
      default: { orderBy: [["startedAt", "desc"]], limit: 10 },
      maxLimit: 30,
    });
    expect(c.arms).toBeNull();
  });

  test("runtime throws mirror the overload: from, columnScope, no default, a bad discriminator", () => {
    const base = {
      fields: RUN,
      id: "runKey",
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
        from: entityRef("runs", RUN),
      }),
    ).toThrow(/from beside `arms`/);
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
        fields: RUN,
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

  test("types: the overload refuses `from` / columnScope, and types the discriminator (T12)", () => {
    // Never called — the assertions are the `@ts-expect-error`s.
    const _typesOnly = () => {
      const spec = {
        fields: RUN,
        id: "runKey",
        sortable: ["startedAt"],
        default: { orderBy: [["startedAt", "desc"]], limit: 10 },
        maxLimit: 30,
      } as const;
      // A union needs nothing beside `arms`: every window pages.
      liveCollection("t.a", { ...spec, arms: { discriminator: "kind" } });
      // Overload resolution reports some refusals at the call, not the field.
      // @ts-expect-error — a union's rows are no entity's
      liveCollection("t.b", {
        ...spec,
        arms: { discriminator: "kind" },
        from: entityRef("runs", RUN),
      });
      liveCollection("t.c", {
        ...spec,
        // @ts-expect-error — nor scoped
        arms: { discriminator: "kind" },
        columnScope: "s",
      });
      // @ts-expect-error — the discriminator is a row field
      liveCollection("t.d", {
        ...spec,
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
      order: 10,
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
    const build = liveArm(c, "build", {
      label: "Build",
      order: 10,
      fields: BUILD_FIELDS,
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
      fields: RUN,
      id: "runKey",
      sortable: ["startedAt"],
      default: { orderBy: [["startedAt", "desc"]], limit: 10 },
      maxLimit: 30,
    });
    expect(() =>
      liveArm(
        // @ts-expect-error — only a union collection has arms
        plain,
        "build",
        { label: "Build", order: 10, fields: BUILD_FIELDS },
      ),
    ).toThrow(/not declared with `arms`/);
    expect(() =>
      liveArm(runs(), "a.b", { label: "A", order: 10, fields: BUILD_FIELDS }),
    ).toThrow(/plain identifier/);
  });
});

describe("the codec switches on the owner (T11)", () => {
  test("a union decodes its arms' columns (and passes an exposed set to the server); a scoped set is refused there; an arm set elsewhere is refused", () => {
    const c = runs();
    const build = liveArm(c, "build", {
      label: "Build",
      order: 10,
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

    // An exposure is read by a collection reaching its entity — and by a
    // union, whose entity arms reach theirs: arms are declared after the
    // union, so its codec lets an exposed set through and the server (which
    // folds each arm's exposures) decodes strictly.
    const runsEntity = entityRef("test_arm_runs", RUN);
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
    ).not.toThrow();
    const host = liveCollection(`test.live.arms-ex-${seq++}`, {
      from: runsEntity,
      pick: ["runKey", "kind", "label", "startedAt"],
      id: "runKey",
      sortable: ["startedAt"],
      default: { orderBy: [["startedAt", "desc"]], limit: 10 },
      maxLimit: 30,
    });
    expect(() =>
      host.window.window.encode({
        orderBy: [["build.exitCode", "asc"]],
        columns,
      } as never),
    ).toThrow(/not declared with `arms`/);
  });
});

describe("liveArm — declared from an entity", () => {
  const NOTE = {
    id: textField(),
    title: textField({ label: "Title" }),
    secret: textField(),
  };
  const notes = entityRef("arm_notes", NOTE);

  test("picked fields are listed first, with the entity's labels; picked ones are recorded", () => {
    const arm = liveArm(runs(), "note", {
      label: "Notes",
      order: 10,
      from: notes,
      pick: ["title"],
      fields: { size: nullable(intField({ label: "Size" })) },
    });
    expect(Object.values(arm.listed).map((f) => f.id)).toEqual([
      "note.title",
      "note.size",
    ]);
    expect(arm.picked).toEqual(["title"]);
  });

  test("runtime throws mirror the types: an unknown pick, pick without from, an own field named like the entity's", () => {
    const untyped = liveArm as unknown as (
      c: unknown,
      arm: string,
      spec: Record<string, unknown>,
    ) => unknown;
    expect(() =>
      untyped(runs(), "n", {
        label: "N",
        order: 1,
        from: notes,
        pick: ["nope"],
      }),
    ).toThrow(/not a wire field/);
    expect(() =>
      untyped(runs(), "n", { label: "N", order: 1, pick: ["title"] }),
    ).toThrow(/without `from`/);
    expect(() =>
      untyped(runs(), "n", {
        label: "N",
        order: 1,
        from: notes,
        fields: { title: textField({ label: "T" }) },
      }),
    ).toThrow(/named like a field of `from`/);
    // Types: an unlabelled entity field cannot be picked.
    const _typesOnly = () =>
      liveArm(runs(), "n", {
        label: "N",
        order: 1,
        from: notes,
        // @ts-expect-error `secret` carries no label: no list may show it
        pick: ["secret"],
      });
    void _typesOnly;
  });
});
