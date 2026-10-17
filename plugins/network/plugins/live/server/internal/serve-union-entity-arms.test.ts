/**
 * A Meta-DataView over sources of DIFFERENT entities (fields declared once,
 * phase 3): a union whose arms are declared FROM their entities
 * (`liveArm({ from, pick })`) — the picked fields listed with the entity's own
 * labels, and bound by name on the server (`served.arm`), so an arm's binding
 * names only the fields it computes itself. Compiled exactly as
 * `serveUnionCollection` compiles it, over a recording `db`: each arm's routes
 * gate on the columns its SQL reads — the picked ones included.
 */

import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { nullable } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { expr } from "@plugins/infra/plugins/query-resource/core";
import { recordingQueryDb } from "@plugins/infra/plugins/query-resource/server/testing";
import { liveArm, liveCollection } from "@plugins/network/plugins/live/core";
import { compileUnion, serveUnionCollection } from "./serve-union";

// Two entities, declared once — their tables bind their fields by name.
const noteFields = {
  id: textField(),
  title: textField({ label: "Title" }),
  mood: enumTextField(["calm", "busy"] as const, { label: "Mood" }),
  updatedAt: dateField({ label: "Updated" }),
};
const notesEntity = entityRef("ea_notes", noteFields);
const notes = pgTable("ea_notes", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  mood: text("mood").$type<"calm" | "busy">().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

const linkFields = {
  id: textField(),
  name: textField({ label: "Name" }),
  url: textField({ label: "URL" }),
  editedAt: dateField({ label: "Edited" }),
};
const linksEntity = entityRef("ea_links", linkFields);
const links = pgTable("ea_links", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  editedAt: timestamp("edited_at", { withTimezone: true }).notNull(),
});

// The Meta-DataView: shared fields every source projects, its source field.
const activity = liveCollection("test.live.entity-arms", {
  fields: {
    kind: textField({ label: "Source" }),
    title: textField({ label: "Title", primary: true }),
    updatedAt: dateField({ label: "Updated" }),
    note: nullable(textField({ label: "Note" })),
  },
  carry: { fields: { key: textField(), id: textField() } },
  id: "key",
  arms: { discriminator: "kind" },
  sortable: ["kind", "updatedAt"],
  default: { orderBy: [["updatedAt", "desc"]], limit: 10 },
  maxLimit: 40,
});
const noteArm = liveArm(activity, "note", {
  label: "Notes",
  order: 10,
  from: notesEntity,
  pick: ["mood"],
  sortable: ["mood"],
});
const linkArm = liveArm(activity, "link", {
  label: "Links",
  order: 20,
  from: linksEntity,
  pick: ["url"],
  fields: { host: textField({ label: "Host" }) },
});

const served = serveUnionCollection(activity, {
  derive: { id: { reads: [], bind: (_r, { id }) => id } },
});
const noteServed = served.arm(noteArm, {
  from: notes,
  id: notes.id,
  base: (j) => ({
    title: j.base.title,
    updatedAt: j.base.updatedAt,
    note: null,
  }),
  // `mood` is picked: bound by name.
  extra: () => ({}),
});
const linkServed = served.arm(linkArm, {
  from: links,
  id: links.id,
  base: (j) => ({
    title: j.base.name,
    updatedAt: j.base.editedAt,
    note: j.base.url,
  }),
  // `url` is picked (by name); `host` is the arm's own.
  extra: (j) => ({
    host: expr(sql`split_part(${j.base.url}, '/', 3)`, {
      decoder: String,
      sqlType: "text",
      notNull: true,
    }),
  }),
});

describe("a union over sources of different entities", () => {
  test("an arm declared from its entity lists the picked fields with the entity's labels, then its own", () => {
    expect(Object.values(noteArm.listed).map((f) => [f.id, f.label])).toEqual([
      ["note.mood", "Mood"],
    ]);
    expect(Object.values(linkArm.listed).map((f) => [f.id, f.label])).toEqual([
      ["link.url", "URL"],
      ["link.host", "Host"],
    ]);
    expect(noteArm.picked).toEqual(["mood"]);
    expect(noteArm.wireFilterable).toEqual({ "note.mood": { domain: "text" } });
  });

  test("the picked fields bind by name: each arm's routes read them", () => {
    const { db } = recordingQueryDb();
    const compiled = compileUnion(activity, {
      arms: () => [noteServed.binding, linkServed.binding],
      db,
    });
    const routes = compiled.window.routes!.routes;
    const note = routes.find((r) => r.id === "note")!;
    const link = routes.find((r) => r.id === "link")!;
    expect(note.table).toBe("ea_notes");
    expect([...note.columns].sort()).toEqual(
      ["id", "mood", "title", "updated_at"].sort(),
    );
    expect(link.table).toBe("ea_links");
    expect([...link.columns].sort()).toEqual(
      ["edited_at", "id", "name", "url"].sort(),
    );
  });

  test("an arm binding a field the union derives is refused", () => {
    const bad = served.arm(noteArm, {
      from: notes,
      id: notes.id,
      base: (j) => ({
        title: j.base.title,
        updatedAt: j.base.updatedAt,
        note: null,
        // @ts-expect-error the union derives `id`
        id: j.base.id,
      }),
      extra: () => ({}),
    });
    const { db } = recordingQueryDb();
    expect(() =>
      compileUnion(activity, { arms: () => [bad.binding], db }),
    ).toThrow(/which the union derives/);
  });
});
