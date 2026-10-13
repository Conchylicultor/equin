import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { defineExtensionShape } from "./define-extension-shape";

describe("defineExtensionShape", () => {
  test("orders the full record key → own fields → timestamps", () => {
    const shape = defineExtensionShape({
      key: "songId",
      fields: { semitones: intField(), label: textField() },
    });
    // drizzle-kit diffs columns positionally, so this order IS the DDL order.
    expect(Object.keys(shape.fields)).toEqual([
      "songId",
      "semitones",
      "label",
      "createdAt",
      "updatedAt",
    ]);
    expect(shape.key).toBe("songId");
  });

  test("keeps both timestamps off the wire by default", () => {
    const shape = defineExtensionShape({
      key: "songId",
      fields: { semitones: intField() },
    });
    expect(Object.keys(shape.schema.shape)).toEqual(["songId", "semitones"]);
    expect(shape.serverOnly).toEqual(["createdAt", "updatedAt"]);
    expect(shape.schema.parse({ songId: "s1", semitones: 3 })).toEqual({
      songId: "s1",
      semitones: 3,
    });
  });

  test("wireTimestamps puts the listed timestamps on the wire", () => {
    const shape = defineExtensionShape({
      key: "taskId",
      fields: { level: textField() },
      wireTimestamps: ["updatedAt"],
    });
    expect(Object.keys(shape.schema.shape)).toEqual([
      "taskId",
      "level",
      "updatedAt",
    ]);
    expect(shape.serverOnly).toEqual(["createdAt"]);
  });

  test("serverOnly keeps own fields off the wire, alongside the timestamps", () => {
    const shape = defineExtensionShape({
      key: "songId",
      fields: { attachmentId: textField(), contentHash: textField() },
      serverOnly: ["contentHash"],
      wireTimestamps: ["createdAt", "updatedAt"],
    });
    expect(Object.keys(shape.schema.shape)).toEqual([
      "songId",
      "attachmentId",
      "createdAt",
      "updatedAt",
    ]);
    expect(shape.serverOnly).toEqual(["contentHash"]);
  });

  test("an extension with no own fields carries only the key", () => {
    const shape = defineExtensionShape({ key: "blockId", fields: {} });
    expect(Object.keys(shape.schema.shape)).toEqual(["blockId"]);
  });

  test("a server-only key never survives a parse", () => {
    const shape = defineExtensionShape({
      key: "songId",
      fields: { semitones: intField() },
    });
    expect(
      shape.schema.parse({ songId: "s1", semitones: 0, createdAt: new Date() }),
    ).toEqual({ songId: "s1", semitones: 0 });
  });

  test("the shape is frozen", () => {
    const shape = defineExtensionShape({ key: "songId", fields: {} });
    expect(Object.isFrozen(shape)).toBe(true);
    expect(Object.isFrozen(shape.fields)).toBe(true);
    expect(Object.isFrozen(shape.serverOnly)).toBe(true);
  });

  describe("reserved keys", () => {
    test.each(["songId", "createdAt", "updatedAt"])(
      "throws when the fields declare %s",
      (reserved) => {
        expect(() =>
          defineExtensionShape({
            key: "songId",
            fields: { [reserved]: textField() },
          }),
        ).toThrow(
          new RegExp(
            `defineExtensionShape\\(\\{ key: "songId" \\}\\): field "${reserved}" is reserved`,
          ),
        );
      },
    );

    test.each(["createdAt", "updatedAt"])(
      "throws when the key itself is named %s",
      (key) => {
        expect(() => defineExtensionShape({ key, fields: {} })).toThrow(
          new RegExp(`the key cannot be named "${key}"`),
        );
      },
    );
  });
});

// ── Compile-time: the wire row type follows serverOnly / wireTimestamps ──────
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

const typedShape = defineExtensionShape({
  key: "songId",
  fields: { semitones: intField(), contentHash: textField() },
  serverOnly: ["contentHash"],
  wireTimestamps: ["updatedAt"],
});
// Exported so noUnusedLocals keeps the assertion (a type-test alias).
export type _WireRow = Expect<
  Equal<
    z.infer<typeof typedShape.schema>,
    { songId: string; semitones: number; updatedAt: Date }
  >
>;
export type _Key = Expect<Equal<typeof typedShape.key, "songId">>;

// ── exposes: the fields an extension shows in every list of its parent ───────
describe("defineExtensionShape — exposes", () => {
  const tasks = entityRef("tasks");
  const STORED = ["sidequest"] as const;

  test("an absent outside the stored schema widens the wire schema", () => {
    const shape = defineExtensionShape({
      key: "taskId",
      fields: { track: enumTextField(STORED) },
      exposes: {
        parent: tasks,
        name: "track",
        fields: {
          track: {
            label: "Track",
            absent: "main",
            options: {
              main: { label: "Main", variant: "primary" },
              sidequest: { label: "Sidequest", variant: "info" },
            },
          },
        },
      },
    });
    const exposure = shape.exposure;
    expect(exposure.slice).toBe("tasks_ext_track");
    expect(exposure.parent).toBe(tasks);
    expect(exposure.fields.track.typeId).toBe("text");
    expect(exposure.fields.track.absent).toBe("main");
    expect(exposure.fields.track.options).toEqual({
      main: { label: "Main", variant: "primary" },
      sidequest: { label: "Sidequest", variant: "info" },
    });
    // The stored schema refuses "main"; the wire schema takes both.
    expect(shape.fields.track.schema.safeParse("main").success).toBe(false);
    expect(exposure.fields.track.wire.parse("main")).toBe("main");
    expect(exposure.fields.track.wire.parse("sidequest")).toBe("sidequest");
    expect(exposure.fields.track.wire.safeParse("other").success).toBe(false);
    expect(exposure.row.parse({ track: "main" })).toEqual({ track: "main" });
  });

  test("an absent the field already holds keeps its schema; null makes it nullable", () => {
    const shape = defineExtensionShape({
      key: "conversationId",
      fields: { cost: intField(), note: textField() },
      exposes: {
        parent: entityRef("conversations"),
        name: "usage",
        fields: {
          cost: { label: "Cost", absent: 0 },
          note: { label: "Note", absent: null },
        },
      },
    });
    const { fields } = shape.exposure;
    expect(fields.cost.wire).toBe(shape.fields.cost.schema);
    expect(fields.note.wire.parse(null)).toBeNull();
    expect(fields.cost.options).toBeNull();
  });

  test("a shape without exposes has a null exposure", () => {
    expect(
      defineExtensionShape({ key: "songId", fields: {} }).exposure,
    ).toBeNull();
  });

  test("an untyped caller exposing a server-only field throws", () => {
    expect(() =>
      defineExtensionShape({
        key: "songId",
        fields: { hash: textField() },
        serverOnly: ["hash"],
        exposes: {
          parent: entityRef("songs"),
          name: "x",
          fields: { hash: { label: "Hash", absent: null } },
        } as never,
      }),
    ).toThrow(/"hash" is server-only/);
  });

  test("an untyped caller exposing an unknown field throws", () => {
    expect(() =>
      defineExtensionShape({
        key: "songId",
        fields: {},
        exposes: {
          parent: entityRef("songs"),
          name: "x",
          fields: { nope: { label: "Nope", absent: null } },
        } as never,
      }),
    ).toThrow(/"nope" is not one of the extension's own fields/);
  });
});

// ── Compile-time: what `exposes` may name ──────────────────────────────────
const exposedShape = defineExtensionShape({
  key: "taskId",
  fields: { track: enumTextField(["sidequest"] as const), hash: textField() },
  serverOnly: ["hash"],
  exposes: {
    parent: entityRef("tasks"),
    name: "track",
    fields: { track: { label: "Track", absent: "main" } },
  },
});
// The exposed row is the stored value widened by `absent`.
export type _ExposedRow = Expect<
  Equal<
    z.infer<typeof exposedShape.exposure.row>,
    { track: "sidequest" | "main" }
  >
>;
// Type-only: refused declarations, never called (each would throw at runtime).
export const _refusedExposes = (): void => {
  // A server-only field cannot be exposed.
  // @ts-expect-error — `hash` is server-only.
  defineExtensionShape({
    key: "taskId",
    fields: { track: enumTextField(["sidequest"] as const), hash: textField() },
    serverOnly: ["hash"],
    exposes: {
      parent: entityRef("tasks"),
      name: "track",
      fields: { hash: { label: "Hash", absent: null } },
    },
  });
  // Options name every wire value.
  // @ts-expect-error — "main" (the absent value) has no option.
  defineExtensionShape({
    key: "taskId",
    fields: { track: enumTextField(["sidequest"] as const) },
    exposes: {
      parent: entityRef("tasks"),
      name: "track",
      fields: {
        track: {
          label: "Track",
          absent: "main",
          options: { sidequest: { label: "Sidequest" } },
        },
      },
    },
  });
};
