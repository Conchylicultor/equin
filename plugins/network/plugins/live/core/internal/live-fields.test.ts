import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { nullable } from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { stringListField } from "@plugins/fields/plugins/string-list/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { liveCollection } from "./live-collection";
import { liveArm } from "./live-columns";
import { LIVE_COLUMNS_KEY } from "./live-columns";
import { schemaDomain } from "./field-domain";

// The fields spelling: a collection names its entity, the fields a list shows
// and the fields it computes, and the row schema, filter domains and field
// descriptors are derived (`./live-fields`).

const tasks = entityRef("tasks", {
  id: textField(),
  title: textField({ label: "Title" }),
});
const notes = entityRef("notes", {
  id: textField(),
  taskId: textField(),
  title: nullable(textField({ label: "Title", primary: true })),
  status: enumTextField(["open", "done"] as const, {
    label: "Status",
    options: {
      open: { label: "Open" },
      done: { label: "Done", variant: "success" },
    },
  }),
  words: intField({ label: "Words" }),
  pinned: boolField({ label: "Pinned" }),
  tags: stringListField({ label: "Tags" }),
  secretish: textField({ label: "Hash", filterable: false }),
  blob: jsonField({
    label: "Blob",
    schema: z.object({ a: z.number() }),
    default: { a: 0 },
  }),
  createdAt: dateField({ label: "Created" }),
  internal: textField(),
});

const window = liveCollection("test.live-fields.window", {
  from: notes,
  pick: [
    "title",
    "status",
    "words",
    "pinned",
    "tags",
    "secretish",
    "createdAt",
  ],
  related: { task: tasks },
  fields: { taskTitle: textField({ label: "Task" }) },
  carry: { pick: ["id", "taskId"], fields: { rank: textField() } },
  id: "id",
  sortable: ["title", "createdAt", "rank"],
  default: { orderBy: [["createdAt", "desc"]], limit: 10 },
  maxLimit: 40,
});

describe("liveCollection — the fields spelling", () => {
  test("derives the row: picked, own and carried fields, plus `$columns` when it reaches an entity", () => {
    expect(window.rowKeys).toEqual([
      "title",
      "status",
      "words",
      "pinned",
      "tags",
      "secretish",
      "createdAt",
      "taskTitle",
      "id",
      "taskId",
      "rank",
    ]);
    expect(Object.keys(window.row.shape)).toContain(LIVE_COLUMNS_KEY);
    expect(window.exposes).toEqual({ base: notes, task: tasks });
  });

  test("derives every listed field's filter domain from its value; carried, opted-out and JSON ones are not filterable", () => {
    expect(window.filterable).toEqual({
      title: { domain: "text" },
      status: { domain: "text" },
      words: { domain: "number" },
      pinned: { domain: "boolean" },
      tags: { domain: "stringArray" },
      createdAt: { domain: "instant" },
      taskTitle: { domain: "text" },
    });
  });

  test("carries each listed field's descriptor, in declaration order", () => {
    expect(Object.keys(window.fields)).toEqual([
      "title",
      "status",
      "words",
      "pinned",
      "tags",
      "secretish",
      "createdAt",
      "taskTitle",
    ]);
    expect(window.fields.title).toEqual({
      id: "title",
      key: "title",
      label: "Title",
      typeId: "text",
      options: null,
      primary: true,
      domain: "text",
      sortable: true,
    });
    expect(window.fields.status.options).toEqual({
      open: { label: "Open" },
      done: { label: "Done", variant: "success" },
    });
    expect(window.fields.secretish.domain).toBeNull();
    expect(window.fields.words.sortable).toBe(false);
  });

  test("`baseExposures: false` keeps the base entity's exposures off, the related ones on", () => {
    const c = liveCollection("test.live-fields.no-base", {
      from: notes,
      pick: ["title"],
      related: { task: tasks },
      carry: { pick: ["id"] },
      baseExposures: false,
      id: "id",
      all: { orderBy: [["title", "asc"]], unbounded: { reason: "a test set" } },
    });
    expect(c.exposes).toEqual({ task: tasks });
    expect(c.fields.title.sortable).toBe(true);
  });

  test("a lookup-only declaration reads its fields and reaches no entity", () => {
    const c = liveCollection("test.live-fields.lookup", {
      from: notes,
      pick: ["title"],
      carry: { pick: ["id"] },
      id: "id",
    });
    expect(c.exposes).toBeNull();
    expect(c.rowKeys).toEqual(["title", "id"]);
    expect(Object.keys(c.row.shape)).not.toContain(LIVE_COLUMNS_KEY);
  });

  test("a collection over no entity declares only its own fields", () => {
    const c = liveCollection("test.live-fields.free", {
      fields: { name: textField({ label: "Name" }) },
      carry: { fields: { id: textField() } },
      id: "id",
      sortable: ["name"],
      default: { orderBy: [["name", "asc"]], limit: 10 },
      maxLimit: 40,
    });
    expect(c.exposes).toBeNull();
    expect(c.filterable).toEqual({ name: { domain: "text" } });
  });

  test("throws, for an untyped caller, on what tsc refuses", () => {
    const declare = (spec: Record<string, unknown>) => () =>
      liveCollection("test.live-fields.bad", spec as never);
    const base = {
      from: notes,
      carry: { pick: ["id"] },
      id: "id",
      all: { orderBy: [["id", "asc"]], unbounded: { reason: "r" } },
    };
    expect(declare({ ...base, pick: ["internal"] })).toThrow(
      /listed field "internal" has no label/,
    );
    expect(declare({ ...base, pick: ["nope"] })).toThrow(
      /names "nope", which is not a wire field of entity "notes"/,
    );
    expect(declare({ ...base, pick: ["title", "title"] })).toThrow(
      /"title" is declared twice/,
    );
    expect(declare({ ...base, row: z.object({}) })).toThrow(
      /row beside the fields spelling/,
    );
    expect(declare({ ...base, carry: undefined, pick: ["title"] })).toThrow(
      /the id "id" is not a field of the row/,
    );
    expect(
      declare({ ...base, fields: { title: textField({ label: "T" }) } }),
    ).toThrow(/own field "title" is named like a field of entity "notes"/);
    expect(
      declare({
        fields: { a: textField({ label: "A" }) },
        pick: ["a"],
        id: "a",
      }),
    ).toThrow(/`pick` without `from`/);
  });

  test("types: a listed field needs a label, a picked key is a field of `from`, the id is a row field", () => {
    // Never called — the assertions are the `@ts-expect-error`s. Each spec is
    // a valid window but for the one error marked.
    const win = {
      sortable: [],
      default: { orderBy: [], limit: 10 },
      maxLimit: 40,
    } as const;
    const _typesOnly = () => {
      const ok = liveCollection("test.types.fields.ok", {
        from: notes,
        pick: ["title"],
        carry: { pick: ["id"] },
        id: "id",
        ...win,
      });
      liveCollection("test.types.fields.a", {
        from: notes,
        // @ts-expect-error — `internal` carries no label: a list cannot name it
        pick: ["internal"],
        carry: { pick: ["id"] },
        id: "id",
        ...win,
      });
      liveCollection("test.types.fields.b", {
        from: notes,
        // @ts-expect-error — not a field of `notes`
        pick: ["nope"],
        carry: { pick: ["id"] },
        id: "id",
        ...win,
      });
      liveCollection("test.types.fields.c", {
        from: notes,
        pick: ["title"],
        // @ts-expect-error — an own field with no label
        fields: { extra: textField() },
        carry: { pick: ["id"] },
        id: "id",
        ...win,
      });
      liveCollection("test.types.fields.d", {
        from: notes,
        pick: ["title"],
        // @ts-expect-error — the id is not a field of the row
        id: "taskId",
        ...win,
      });
      // The derived filterable columns: listed fields with a domain only.
      const f: keyof typeof window.filterable = "title";
      // @ts-expect-error — carried: not filterable
      const g: keyof typeof window.filterable = "taskId";
      // @ts-expect-error — `filterable: false`
      const h: keyof typeof window.filterable = "secretish";
      // The row type is derived from the fields' values.
      const row: (typeof window.row)["_output"] = null as never;
      const status: "open" | "done" = row.status;
      const title: string | null = row.title;
      return [ok, f, g, h, status, title];
    };
    expect(typeof _typesOnly).toBe("function");
  });
});

describe("liveArm — a union arm declared by fields", () => {
  const runs = liveCollection("test.live-fields.runs", {
    fields: { label: textField({ label: "Label" }) },
    carry: { fields: { key: textField(), kind: textField() } },
    id: "key",
    arms: { discriminator: "kind" },
    sortable: ["label"],
    default: { orderBy: [["label", "asc"]], limit: 10 },
    maxLimit: 40,
  });
  const build = liveArm(runs, "build", {
    label: "Build",
    order: 10,
    fields: {
      status: enumTextField(["ok", "failed"] as const, {
        label: "Build status",
      }),
      exitCode: nullable(intField({ label: "Exit code" })),
      targets: stringListField({ label: "Targets" }),
    },
    sortable: ["status", "exitCode"],
  });

  test("derives the arm's domains and its listed fields (ids `<arm>.<field>`)", () => {
    expect(build.wireFilterable).toEqual({
      "build.status": { domain: "text" },
      "build.exitCode": { domain: "number" },
      "build.targets": { domain: "stringArray" },
    });
    expect(build.wireSortable).toEqual(["build.status", "build.exitCode"]);
    expect(build.label).toBe("Build");
    expect(Object.keys(build.listed)).toEqual([
      "build.status",
      "build.exitCode",
      "build.targets",
    ]);
    expect(build.listed["build.exitCode"]).toMatchObject({
      key: "exitCode",
      label: "Exit code",
      domain: "number",
      sortable: true,
    });
    expect(
      build.read({
        key: "build:1",
        kind: "build",
        label: "x",
        $columns: { build: { status: "ok", exitCode: null, targets: [] } },
      }),
    ).toEqual({ status: "ok", exitCode: null, targets: [] });
  });

  test("`carry` puts fields on the slice that no list shows, filters or sorts", () => {
    const backup = liveArm(runs, "backup", {
      label: "Backup",
      order: 10,
      fields: { size: nullable(intField({ label: "Archive size" })) },
      carry: {
        results: nullable(
          jsonField({ schema: z.array(z.string()), default: [] }),
        ),
      },
      sortable: ["size"],
    });
    expect(Object.keys(backup.listed)).toEqual(["backup.size"]);
    expect(backup.fields).toEqual(["size", "results"]);
    expect(Object.keys(backup.wireFilterable)).toEqual(["backup.size"]);
    expect(
      backup.read({
        key: "backup:1",
        kind: "backup",
        label: "x",
        $columns: { backup: { size: 3, results: ["a"] } },
      }),
    ).toEqual({ size: 3, results: ["a"] });
    expect(() =>
      liveArm(runs, "dup", {
        label: "Dup",
        order: 10,
        fields: { size: intField({ label: "Size" }) },
        carry: { size: intField() },
      }),
    ).toThrow(/both a listed and a carried field/);
  });

  test("types: an arm field needs a label", () => {
    const _typesOnly = () =>
      liveArm(runs, "backup", {
        label: "Backup",
        order: 10,
        // @ts-expect-error — no label
        fields: { size: intField() },
      });
    expect(typeof _typesOnly).toBe("function");
  });
});

describe("schemaDomain", () => {
  test("reads a value's domain through its wrappers", () => {
    expect(schemaDomain(z.string().nullable().default(null))).toBe("text");
    expect(schemaDomain(z.preprocess((v) => v, z.enum(["a", "b"])))).toBe(
      "text",
    );
    expect(schemaDomain(z.coerce.date())).toBe("instant");
    expect(schemaDomain(z.number().int().optional())).toBe("number");
    expect(schemaDomain(z.union([z.literal("a"), z.literal("b")]))).toBe(
      "text",
    );
    expect(schemaDomain(z.array(z.enum(["x"])))).toBe("stringArray");
    expect(schemaDomain(z.array(z.number()))).toBeNull();
    expect(schemaDomain(z.object({ a: z.string() }))).toBeNull();
  });
});
