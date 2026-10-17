/**
 * A list's derived schema (`./derived-fields`): a collection declared by
 * fields hands every list its own fields, the exposed fields of the entities
 * it reaches and its arms' — presented by their owners' registrations — and
 * the list says only `overrides` (by id, typed against the collection's) and
 * `extraFields`.
 */

import { describe, expect, test } from "bun:test";
import { nullable } from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { stringListField } from "@plugins/fields/plugins/string-list/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import {
  liveArm,
  liveCollection,
  LIVE_COLUMNS_KEY,
  clientFields,
  rowKind,
} from "@plugins/network/plugins/live/core";
import type {
  StoredClientFieldsResolution,
  StoredFieldPresentation,
} from "@plugins/network/plugins/live/web";
import { fieldOverrides } from "../../core";
import { deriveFields, listSchema, mergePresentations } from "./derived-fields";

const tasks = entityRef("tasks", { id: textField() });
const notes = entityRef("notes", {
  id: textField(),
  title: nullable(textField({ label: "Title", primary: true })),
  status: enumTextField(["open", "done"] as const, {
    label: "Status",
    options: {
      open: { label: "Open" },
      done: { label: "Done", variant: "success" },
    },
  }),
  tags: stringListField({ label: "Tags" }),
  createdAt: dateField({ label: "Created" }),
});
const trackShape = defineExtensionShape({
  key: "taskId",
  fields: {
    track: enumTextField(["main", "side"] as const, {
      label: "Track",
      default: "main",
    }),
  },
  exposes: { parent: tasks, name: "track", fields: { track: {} } },
});

const notesList = liveCollection("test.derived-fields.notes", {
  from: notes,
  pick: ["title", "status", "tags", "createdAt"],
  fields: { taskTitle: textField({ label: "Task" }) },
  carry: { pick: ["id"] },
  related: { task: tasks },
  id: "id",
  sortable: ["title", "createdAt"],
  default: { orderBy: [["createdAt", "desc"]], limit: 10 },
  maxLimit: 40,
});

const row = {
  id: "n1",
  title: "Hello",
  status: "done",
  tags: ["a", "b"],
  createdAt: new Date(0),
  taskTitle: "T",
  [LIVE_COLUMNS_KEY]: { tasks_ext_track: { track: "side" } },
};

const registration = (
  r: Partial<StoredFieldPresentation> & Pick<StoredFieldPresentation, "owner">,
): StoredFieldPresentation => ({ reads: [], fields: {}, ...r });

describe("deriveFields", () => {
  test("derives the collection's own fields, in declaration order, then the reached exposures'", () => {
    const { fields } = deriveFields(notesList, false, [
      registration({ owner: trackShape.exposure }),
    ]);
    expect(fields.map((f) => f.id)).toEqual([
      "title",
      "status",
      "tags",
      "createdAt",
      "taskTitle",
      "track",
    ]);
    const byId = new Map(fields.map((f) => [f.id, f]));
    expect(byId.get("title")).toMatchObject({ label: "Title", primary: true });
    expect(byId.get("status")).toMatchObject({
      type: "enum",
      options: [
        { value: "open", label: "Open" },
        { value: "done", label: "Done", variant: "success" },
      ],
    });
    expect(byId.get("status")!.value!(row)).toBe("done");
    expect(byId.get("tags")!.values!(row)).toEqual(["a", "b"]);
    expect(byId.get("tags")!.value).toBeUndefined();
    expect(byId.get("createdAt")!.type).toBe("date");
    expect(byId.get("track")!.value!(row)).toBe("side");
    // In memory nothing binds a column; an own field lowers under its id.
    expect(fields.some((f) => f.column !== undefined)).toBe(false);
  });

  test("an exposure no registration names is not reached; an unreached entity's is skipped", () => {
    expect(
      deriveFields(notesList, false, []).fields.map((f) => f.id),
    ).not.toContain("track");
    const other = entityRef("others", {});
    const otherShape = defineExtensionShape({
      key: "otherId",
      fields: { n: intField({ label: "N", default: 0 }) },
      exposes: { parent: other, name: "n", fields: { n: {} } },
    });
    expect(
      deriveFields(notesList, false, [
        registration({ owner: otherShape.exposure }),
      ]).fields.map((f) => f.id),
    ).not.toContain("n");
  });

  test("applies the owner's presentation: the cell reads the value and the declared reads", () => {
    const seen: unknown[] = [];
    const { fields } = deriveFields(notesList, false, [
      registration({
        owner: notes,
        reads: ["id"],
        fields: {
          status: {
            cell: (value, r) => {
              seen.push([value, (r as { id: string }).id]);
              return null;
            },
            width: "4rem",
          },
        },
      }),
    ]);
    const status = fields.find((f) => f.id === "status")!;
    expect(status.width).toBe("4rem");
    expect(status.cell!(row)).toBeNull();
    expect(seen).toEqual([["done", "n1"]]);
  });

  test("throws when the entity's presentation reads a field the collection does not carry", () => {
    expect(() =>
      deriveFields(notesList, false, [
        registration({ owner: notes, reads: ["nope"] }),
      ]),
    ).toThrow(/reads "nope", which "test.derived-fields.notes" does not carry/);
  });

  test("two registrations of one owner merge, and clash on one property of one field", () => {
    const merged = mergePresentations([
      registration({ owner: notes, fields: { status: { width: "1rem" } } }),
      registration({ owner: notes, fields: { status: { align: "end" } } }),
    ]);
    expect(merged.get("entity:notes")!.fields.get("status")).toEqual({
      width: "1rem",
      align: "end",
    });
    expect(() =>
      mergePresentations([
        registration({ owner: notes, fields: { status: { width: "1rem" } } }),
        registration({ owner: notes, fields: { status: { width: "2rem" } } }),
      ]),
    ).toThrow(/set width of field "status"/);
  });

  test("collects a live option read per field presented with `useOptions`", () => {
    const useOptions = () => ({
      status: "loading" as const,
      refetch: () => Promise.resolve(),
    });
    const { optionReaders } = deriveFields(notesList, false, [
      registration({ owner: notes, fields: { title: { useOptions } } }),
    ]);
    expect(optionReaders).toEqual([{ id: "title", useOptions }]);
  });

  /** A union of `key` / `kind` / `label` rows — the kind (its source field) listed, the key and label carried. */
  const unionRuns = (key: string) =>
    liveCollection(key, {
      fields: { kind: textField({ label: "Kind" }) },
      carry: {
        fields: { key: textField(), label: textField() },
      },
      id: "key",
      arms: { discriminator: "kind" },
      sortable: ["label"],
      default: { orderBy: [["label", "asc"]], limit: 10 },
      maxLimit: 40,
    });

  test("a union's arm fields, under the arm's label, bound to its columns under a live source", () => {
    const runs = unionRuns("test.derived-fields.runs");
    const build = liveArm(runs, "build", {
      label: "Build",
      order: 10,
      fields: { exitCode: nullable(intField({ label: "Exit code" })) },
      sortable: ["exitCode"],
    });
    const { fields } = deriveFields(runs, true, [
      registration({ owner: build }),
    ]);
    expect(fields.map((f) => f.id)).toEqual(["kind", "build.exitCode"]);
    const exitCode = fields[1];
    expect(exitCode).toMatchObject({
      id: "build.exitCode",
      label: "Exit code",
      section: "Build",
    });
    expect(exitCode!.column?.name).toBe("build.exitCode");
    const buildRow = {
      key: "build:1",
      kind: "build",
      label: "x",
      [LIVE_COLUMNS_KEY]: { build: { exitCode: 2 } },
    };
    expect(exitCode!.value!(buildRow)).toBe(2);
    expect(
      exitCode!.value!({
        key: "b:1",
        kind: "backup",
        label: "y",
        [LIVE_COLUMNS_KEY]: {},
      }),
    ).toBeNull();
  });

  test("the arms' bands follow their declared order, never the order they registered in", () => {
    const runs = unionRuns("test.derived-fields.runs-order");
    const arm = (name: string, order: number) =>
      liveArm(runs, name, {
        label: name.toUpperCase(),
        order,
        fields: { code: nullable(intField({ label: "Code" })) },
      });
    const release = arm("release", 30);
    const build = arm("build", 10);
    const backup = arm("backup", 20);
    // Registered release, build, backup — the plugins' load order.
    const { fields } = deriveFields(runs, false, [
      registration({ owner: release }),
      registration({ owner: build }),
      registration({ owner: backup }),
    ]);
    expect(fields.map((f) => [f.id, f.section])).toEqual([
      ["kind", undefined],
      ["build.code", "BUILD"],
      ["backup.code", "BACKUP"],
      ["release.code", "RELEASE"],
    ]);
  });

  test("the source field (the discriminator) is an enum of the registered arms, in their declared order", () => {
    const runs = unionRuns("test.derived-fields.runs-source");
    const arm = (name: string, label: string, order: number) =>
      liveArm(runs, name, {
        label,
        order,
        fields: { code: nullable(intField({ label: "Code" })) },
      });
    const release = arm("release", "Release", 30);
    const build = arm("build", "Build", 10);
    const { fields } = deriveFields(runs, true, [
      registration({ owner: release }),
      registration({ owner: build }),
    ]);
    const kind = fields.find((f) => f.id === "kind")!;
    expect(kind.type).toBe("enum");
    expect(kind.options).toEqual([
      { value: "build", label: "Build" },
      { value: "release", label: "Release" },
    ]);
    expect(kind.value!({ key: "build:1", kind: "build", label: "x" })).toBe(
      "build",
    );
  });

  test("a presentation reading the source field's options throws: they are the arms", () => {
    const runs = unionRuns("test.derived-fields.runs-source-read");
    const useOptions = () => ({
      status: "loading" as const,
      refetch: () => Promise.resolve(),
    });
    expect(() =>
      deriveFields(runs, false, [
        registration({ owner: runs, fields: { kind: { useOptions } } }),
      ]),
    ).toThrow(/its source field/);
  });
});

describe("deriveFields — client fields", () => {
  const files = rowKind("test.derived-fields.files", {
    fields: { name: textField({ label: "Name", primary: true }) },
    carry: { fields: { id: textField() } },
    id: "id",
  });
  const git = clientFields(files, "git", {
    section: "Git",
    fields: {
      branch: nullable(textField({ label: "Branch" })),
      dirty: nullable(boolField({ label: "Dirty" })),
    },
  });
  const usage = clientFields(files, "usage", {
    fields: { opens: nullable(intField({ label: "Opens" })) },
  });
  // A resolver registration: only its declaration is read by the derivation.
  const resolver = (
    fields: StoredClientFieldsResolution["fields"],
  ): StoredClientFieldsResolution => ({ fields, component: null });

  test("derive in declaration order after the owner's own fields, each under its declared section", () => {
    const { fields, clientReaders } = deriveFields(
      files,
      false,
      [],
      [resolver(git), resolver(usage)],
    );
    expect(fields.map((f) => [f.id, f.section])).toEqual([
      ["name", undefined],
      ["branch", "Git"],
      ["dirty", "Git"],
      ["opens", undefined],
    ]);
    expect(clientReaders).toHaveLength(2);
  });

  test("a row kind with no resolver derives only its own fields", () => {
    const { fields, clientReaders } = deriveFields(files, false, []);
    expect(fields.map((f) => f.id)).toEqual(["name"]);
    expect(clientReaders).toEqual([]);
  });

  test("a resolver of another owner is not this owner's", () => {
    const other = rowKind("test.derived-fields.other", {
      fields: { title: textField({ label: "Title" }) },
      carry: { fields: { id: textField() } },
      id: "id",
    });
    const foreign = clientFields(other, "git", {
      fields: { branch: textField({ label: "Branch" }) },
    });
    expect(
      deriveFields(files, false, [], [resolver(foreign)]).fields.map(
        (f) => f.id,
      ),
    ).toEqual(["name"]);
  });

  test("a live source with client fields throws: they are filtered in memory", () => {
    expect(() => deriveFields(files, true, [], [resolver(git)])).toThrow(
      /has client fields.*cannot list them/,
    );
  });
});

describe("deriveFields — a collection's own presentation and non-string options", () => {
  const verdictShape = defineExtensionShape({
    key: "taskId",
    fields: { ok: boolField({ label: "Status" }) },
    exposes: {
      parent: tasks,
      name: "health",
      fields: {
        ok: {
          as: "status",
          options: {
            true: { label: "Online", variant: "success" },
            false: { label: "Offline" },
            null: { label: "Unknown" },
          },
        },
      },
    },
  });
  const tasksList = liveCollection("test.derived-fields.tasks", {
    fields: { name: textField({ label: "Name", primary: true }) },
    carry: { fields: { id: textField() } },
    related: { task: tasks },
    id: "id",
    all: { orderBy: [["name", "asc"]], unbounded: { reason: "a test" } },
  });

  test("an exposure over a boolean keeps its raw values, keyed options and a boolean valueDomain", () => {
    const { fields } = deriveFields(tasksList, false, [
      registration({ owner: verdictShape.exposure }),
    ]);
    const status = fields.find((f) => f.id === "status")!;
    expect(status).toMatchObject({ type: "enum", valueDomain: "boolean" });
    expect(status.options!.map((o) => [o.value, o.label])).toEqual([
      ["true", "Online"],
      ["false", "Offline"],
      ["null", "Unknown"],
    ]);
    const at = (ok: boolean | null) => ({
      id: "t",
      name: "n",
      [LIVE_COLUMNS_KEY]: { tasks_ext_health: { ok } },
    });
    expect(status.value!(at(false))).toBe(false);
    expect(status.value!(at(null))).toBeNull();
  });

  test("a collection presents its own fields, and throws on a field it does not list", () => {
    const { fields } = deriveFields(tasksList, false, [
      registration({ owner: tasksList, fields: { name: { width: "9rem" } } }),
    ]);
    expect(fields.find((f) => f.id === "name")!.width).toBe("9rem");
    expect(() =>
      deriveFields(tasksList, false, [
        registration({ owner: tasksList, fields: { nope: { width: "1rem" } } }),
      ]),
    ).toThrow(/names "nope", which it lists no field of/);
  });

  test("a picked field: the entity and the collection may each present it, never one property twice", () => {
    const both = deriveFields(notesList, false, [
      registration({ owner: notes, fields: { status: { width: "4rem" } } }),
      registration({ owner: notesList, fields: { status: { align: "end" } } }),
    ]).fields.find((f) => f.id === "status")!;
    expect(both).toMatchObject({ width: "4rem", align: "end" });
    expect(() =>
      deriveFields(notesList, false, [
        registration({ owner: notes, fields: { status: { width: "4rem" } } }),
        registration({
          owner: notesList,
          fields: { status: { width: "1rem" } },
        }),
      ]),
    ).toThrow(/both set width of field "status"/);
  });
});

describe("listSchema", () => {
  const { fields: derived } = deriveFields(notesList, false, []);

  test("applies overrides by id, then appends the list's own fields", () => {
    const schema = listSchema({
      collection: notesList,
      derived,
      fields: undefined,
      overrides: fieldOverrides(notesList, { status: { groupable: false } }),
      extraFields: [{ id: "section", label: "Section", value: () => "x" }],
    });
    expect(schema.map((f) => f.id)).toEqual([
      "title",
      "status",
      "tags",
      "createdAt",
      "taskTitle",
      "section",
    ]);
    expect(schema.find((f) => f.id === "status")!.groupable).toBe(false);
  });

  test("refuses hand fields beside a collection declared by fields, and none without one", () => {
    expect(() =>
      listSchema({
        collection: notesList,
        derived,
        fields: [{ id: "x", label: "X" }],
        overrides: undefined,
        extraFields: undefined,
      }),
    ).toThrow(/is declared by fields/);
    expect(() =>
      listSchema({
        collection: undefined,
        derived: [],
        fields: undefined,
        overrides: undefined,
        extraFields: undefined,
      }),
    ).toThrow(/has no fields/);
  });

  test("throws on an override of an unknown id, and on a duplicate id", () => {
    expect(() =>
      listSchema({
        collection: notesList,
        derived,
        fields: undefined,
        // Untyped: tsc refuses the id (see the type test below).
        overrides: { collection: notesList.key, byId: { nope: {} } },
        extraFields: undefined,
      }),
    ).toThrow(
      /name "nope", which "test.derived-fields.notes" derives no field of/,
    );
    expect(() =>
      listSchema({
        collection: notesList,
        derived,
        fields: undefined,
        overrides: undefined,
        extraFields: [{ id: "status", label: "Mine" }],
      }),
    ).toThrow(/field "status" is declared twice/);
  });

  test("types: an override names one of the collection's field ids", () => {
    const _typesOnly = () =>
      // @ts-expect-error — not a field of the collection
      fieldOverrides(notesList, { nope: { groupable: false } });
    expect(typeof _typesOnly).toBe("function");
  });
});
