import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { nullable } from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
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
  const tasks = entityRef("tasks", {});
  const TRACKS = ["main", "sidequest"] as const;

  test("a declared default is what a missing row reads; the wire schema is the field's", () => {
    const shape = defineExtensionShape({
      key: "taskId",
      fields: {
        track: enumTextField(TRACKS, {
          label: "Track",
          default: "main",
          options: {
            main: { label: "Main", variant: "primary" },
            sidequest: { label: "Sidequest", variant: "info" },
          },
        }),
      },
      exposes: { parent: tasks, name: "track", fields: { track: {} } },
    });
    const exposure = shape.exposure;
    expect(exposure.slice).toBe("tasks_ext_track");
    expect(exposure.parent).toBe(tasks);
    const track = exposure.fields.track;
    expect(track.id).toBe("track");
    expect(track.label).toBe("Track");
    expect(track.typeId).toBe("text");
    expect(track.absent).toBe("main");
    expect(track.presence).toBeNull();
    // The options come from the field's own meta.
    expect(track.options).toEqual({
      main: { label: "Main", variant: "primary" },
      sidequest: { label: "Sidequest", variant: "info" },
    });
    expect(track.wire).toBe(shape.fields.track.schema);
    expect(track.wire.safeParse(null).success).toBe(false);
    expect(exposure.row.parse({ track: "main" })).toEqual({ track: "main" });
  });

  test("no declared default reads NULL: the wire schema becomes nullable", () => {
    const shape = defineExtensionShape({
      key: "conversationId",
      fields: {
        cost: intField({ label: "Cost", default: 0 }),
        count: intField(),
        note: textField(),
      },
      exposes: {
        parent: entityRef("conversations", {}),
        name: "usage",
        fields: {
          cost: {},
          count: { label: "Count" },
          note: { label: "Note" },
        },
      },
    });
    const { fields } = shape.exposure;
    expect(fields.cost.absent).toBe(0);
    expect(fields.cost.wire).toBe(shape.fields.cost.schema);
    // `intField()`'s implicit 0 is a backfill, not a declaration.
    expect(fields.count.absent).toBeNull();
    expect(fields.count.wire.parse(null)).toBeNull();
    expect(fields.count.wire.parse(3)).toBe(3);
    expect(fields.note.absent).toBeNull();
    expect(fields.note.wire.parse(null)).toBeNull();
    expect(fields.cost.options).toBeNull();
  });

  test("`as` names the field in lists; the exposure keeps it under its key", () => {
    const shape = defineExtensionShape({
      key: "serverId",
      fields: { ok: nullable(boolField()) },
      exposes: {
        parent: entityRef("servers", {}),
        name: "health",
        fields: { ok: { label: "Status", as: "status" } },
      },
    });
    const ok = shape.exposure.fields.ok;
    expect(ok.id).toBe("status");
    expect(ok.label).toBe("Status");
    expect(Object.keys(shape.exposure.fields)).toEqual(["ok"]);
    expect(shape.exposure.row.parse({ ok: null })).toEqual({ ok: null });
  });

  test("presence: a boolean, or one of two literals", () => {
    const starred = defineExtensionShape({
      key: "blockId",
      fields: {},
      exposes: {
        parent: entityRef("blocks", {}),
        name: "starred",
        presence: { id: "starred", label: "Starred" },
      },
    }).exposure.fields.starred;
    expect(starred.typeId).toBe("bool");
    expect(starred.absent).toBe(false);
    expect(starred.presence).toEqual({ values: null });
    expect(starred.wire.parse(true)).toBe(true);
    expect(starred.wire.safeParse(null).success).toBe(false);

    const origin = defineExtensionShape({
      key: "blockId",
      fields: { automationId: textField() },
      exposes: {
        parent: entityRef("blocks", {}),
        name: "origin",
        presence: {
          id: "origin",
          label: "Origin",
          values: { present: "agent", absent: "user" },
          options: { agent: { label: "Agent" }, user: { label: "You" } },
        },
      },
    }).exposure.fields.origin;
    expect(origin.typeId).toBe("text");
    expect(origin.absent).toBe("user");
    expect(origin.presence).toEqual({
      values: { present: "agent", absent: "user" },
    });
    expect(origin.options).toEqual({
      agent: { label: "Agent" },
      user: { label: "You" },
    });
    expect(origin.wire.parse("agent")).toBe("agent");
    expect(origin.wire.safeParse("other").success).toBe(false);
  });

  test("a shape without exposes has a null exposure", () => {
    expect(
      defineExtensionShape({ key: "songId", fields: {} }).exposure,
    ).toBeNull();
  });

  test("an untyped caller authoring `absent` throws", () => {
    expect(() =>
      defineExtensionShape({
        key: "taskId",
        fields: { track: enumTextField(TRACKS, { label: "Track" }) },
        exposes: {
          parent: tasks,
          name: "track",
          fields: { track: { absent: "main" } },
        } as never,
      }),
    ).toThrow(/"track" declares `absent`/);
  });

  test("an untyped caller exposing a server-only, unknown or unlabelled field throws", () => {
    expect(() =>
      defineExtensionShape({
        key: "songId",
        fields: { hash: textField() },
        serverOnly: ["hash"],
        exposes: {
          parent: entityRef("songs", {}),
          name: "x",
          fields: { hash: { label: "Hash" } },
        } as never,
      }),
    ).toThrow(/"hash" is server-only/);
    expect(() =>
      defineExtensionShape({
        key: "songId",
        fields: {},
        exposes: {
          parent: entityRef("songs", {}),
          name: "x",
          fields: { nope: { label: "Nope" } },
        } as never,
      }),
    ).toThrow(/"nope" is not one of the extension's own fields/);
    expect(() =>
      defineExtensionShape({
        key: "songId",
        fields: { plays: intField() },
        exposes: {
          parent: entityRef("songs", {}),
          name: "x",
          fields: { plays: {} },
        },
      }),
    ).toThrow(/"plays" has no label/);
  });

  test("two fields of one id, or a presence named like a field, throw", () => {
    expect(() =>
      defineExtensionShape({
        key: "songId",
        fields: { a: intField({ label: "A" }), b: intField({ label: "B" }) },
        exposes: {
          parent: entityRef("songs", {}),
          name: "x",
          fields: { a: { as: "b" }, b: {} },
        },
      }),
    ).toThrow(/share the id "b"/);
    expect(() =>
      defineExtensionShape({
        key: "songId",
        fields: { starred: intField() },
        exposes: {
          parent: entityRef("songs", {}),
          name: "x",
          presence: { id: "starred", label: "Starred" },
        },
      }),
    ).toThrow(/is named like one of the extension's fields/);
    expect(() =>
      defineExtensionShape({
        key: "songId",
        fields: {},
        exposes: { parent: entityRef("songs", {}), name: "x" },
      }),
    ).toThrow(/it exposes nothing/);
  });

  test("a declared default no missing row can read (a date) throws", () => {
    expect(() =>
      defineExtensionShape({
        key: "songId",
        fields: { at: dateField({ label: "At", default: new Date(0) }) },
        exposes: {
          parent: entityRef("songs", {}),
          name: "x",
          fields: { at: {} },
        },
      }),
    ).toThrow(/which a missing side row cannot read/);
  });
});

// ── Compile-time: what `exposes` may name ──────────────────────────────────
const exposedShape = defineExtensionShape({
  key: "taskId",
  fields: {
    track: enumTextField(["main", "sidequest"] as const, {
      label: "Track",
      default: "main",
    }),
    plays: intField({ label: "Plays" }),
    hash: textField(),
  },
  serverOnly: ["hash"],
  exposes: {
    parent: entityRef("tasks", {}),
    name: "track",
    fields: { track: {}, plays: {} },
    presence: {
      id: "origin",
      label: "Origin",
      values: { present: "agent", absent: "user" },
    },
  },
});
// A declared default keeps the value; none adds `| null`; the presence reads
// one of its literals.
export type _ExposedRow = Expect<
  Equal<
    z.infer<typeof exposedShape.exposure.row>,
    {
      track: "main" | "sidequest";
      plays: number | null;
      origin: "agent" | "user";
    }
  >
>;
const boolPresence = defineExtensionShape({
  key: "taskId",
  fields: {},
  exposes: {
    parent: entityRef("tasks", {}),
    name: "starred",
    presence: { id: "starred", label: "Starred" },
  },
});
export type _PresenceRow = Expect<
  Equal<z.infer<typeof boolPresence.exposure.row>, { starred: boolean }>
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
      parent: entityRef("tasks", {}),
      name: "track",
      fields: { hash: { label: "Hash" } },
    },
  });
  // What a missing row reads is derived — `absent` no longer exists.
  defineExtensionShape({
    key: "taskId",
    fields: { track: enumTextField(["main", "sidequest"] as const) },
    // @ts-expect-error — `absent` is not authored.
    exposes: {
      parent: entityRef("tasks", {}),
      name: "track",
      fields: { track: { label: "Track", absent: "main" } },
    },
  });
  // Options name every value of the field.
  // @ts-expect-error — "main" has no option.
  defineExtensionShape({
    key: "taskId",
    fields: { track: enumTextField(["main", "sidequest"] as const) },
    exposes: {
      parent: entityRef("tasks", {}),
      name: "track",
      fields: {
        track: {
          label: "Track",
          options: { sidequest: { label: "Sidequest" } },
        },
      },
    },
  });
  // A boolean presence's options name "true" and "false".
  // @ts-expect-error — "false" has no option.
  defineExtensionShape({
    key: "taskId",
    fields: {},
    exposes: {
      parent: entityRef("tasks", {}),
      name: "starred",
      presence: {
        id: "starred",
        label: "Starred",
        options: { true: { label: "Starred" } },
      },
    },
  });
  // A field a missing row reads as NULL labels "null" too.
  // @ts-expect-error — "null" has no option.
  defineExtensionShape({
    key: "taskId",
    fields: { ok: boolField({ label: "Status" }) },
    exposes: {
      parent: entityRef("tasks", {}),
      name: "health",
      fields: {
        ok: {
          options: { true: { label: "Online" }, false: { label: "Offline" } },
        },
      },
    },
  });
};
// Options over a nullable boolean: every value by its canonical spelling.
const labelledVerdict = defineExtensionShape({
  key: "taskId",
  fields: { ok: boolField({ label: "Status" }) },
  exposes: {
    parent: entityRef("tasks", {}),
    name: "health",
    fields: {
      ok: {
        as: "status",
        options: {
          true: { label: "Online" },
          false: { label: "Offline" },
          null: { label: "Unknown" },
        },
      },
    },
  },
});
test("an exposed field's options label its non-string values by their spelling", () => {
  expect(
    Object.keys(labelledVerdict.exposure!.fields.ok.options ?? {}),
  ).toEqual(["true", "false", "null"]);
});
test("a boolean presence's options name only true / false", () => {
  expect(() =>
    defineExtensionShape({
      key: "taskId",
      fields: {},
      exposes: {
        parent: entityRef("tasks", {}),
        name: "starred",
        presence: {
          id: "starred",
          label: "Starred",
          options: { yes: { label: "Starred" } } as never,
        },
      },
    }),
  ).toThrow(/name yes — it reads only true \/ false/);
});
