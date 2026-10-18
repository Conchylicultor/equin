/**
 * A Meta-DataView over sources of DIFFERENT entities (fields declared once,
 * phase 3): a union whose arms are declared FROM their entities
 * (`liveArm({ from, pick })`) — the picked fields listed with the entity's own
 * labels, and bound by name on the server (`served.arm`), so an arm's binding
 * names only the fields it computes itself. Compiled exactly as
 * `serveUnionCollection` compiles it, over a recording `db`: each arm's routes
 * gate on the columns its SQL reads — the picked ones included.
 *
 * Phase 4: an arm declared from an ENTITY also folds the entity's exposed
 * extension fields (`reaches`) — LEFT-joined onto that arm only, routed as an
 * alias of it, carried under `$columns[<slice>]` on its rows alone, a typed
 * NULL on the other arms' (so a filter on one prunes them), groupable.
 */

import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { nullable } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { defineEntity } from "@plugins/infra/plugins/entities/server";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { expr } from "@plugins/infra/plugins/query-resource/core";
import {
  recordingQueryDb,
  type RecordedQuery,
} from "@plugins/infra/plugins/query-resource/server/testing";
import {
  exposedColumns,
  liveArm,
  liveCollection,
  LIVE_COLUMNS_KEY,
} from "@plugins/network/plugins/live/core";
import { compileUnion, serveUnionCollection } from "./serve-union";

// Two entities, declared once — their tables bind their fields by name.
const noteFields = {
  id: textField(),
  title: textField({ label: "Title" }),
  mood: enumTextField(["calm", "busy"] as const, { label: "Mood" }),
  updatedAt: dateField({ label: "Updated" }),
};
const notesEntity = entityRef("ea_notes", noteFields);
const notes = defineEntity(notesEntity, {
  primaryKey: "id",
  updatedAt: { touchedBy: { id: false, title: true, mood: true } },
}).table;

const linkFields = {
  id: textField(),
  name: textField({ label: "Name" }),
  url: textField({ label: "URL" }),
  editedAt: dateField({ label: "Edited" }),
};
const linksEntity = entityRef("ea_links", linkFields);
const links = defineEntity(linksEntity, { primaryKey: "id" }).table;

// A note's extension, exposing one field (every list of notes shows it).
const notePriority = defineExtension(
  notes,
  "priority",
  defineExtensionShape({
    key: "noteId",
    fields: {
      priority: enumTextField(["normal", "high"] as const, {
        label: "Priority",
        default: "normal",
      }),
    },
    exposes: {
      parent: notesEntity,
      name: "priority",
      fields: { priority: {} },
    },
  }),
  { columns: { priority: { default: "normal" } } },
);
const priorityCols = exposedColumns(notePriority.exposure);
const PRIORITY = "ea_notes_ext_priority.priority";

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

describe("an entity arm folds its entity's exposed fields", () => {
  /** The note row as Postgres answers it: each `__c<i>` read off its SQL. */
  const noteRow = (q: RecordedQuery): Record<string, unknown> => {
    const cols = [...q.sql.matchAll(/AS "(__c\d+)"/g)].map((m) => m[1]!);
    const row: Record<string, unknown> = { __kind: "note", __key: "note:n1" };
    for (const c of cols) row[c] = null;
    // The row key's parts (`__p<i>`), as Postgres would project them.
    for (const m of q.sql.matchAll(/AS "(__p\d+)"/g)) row[m[1]!] = m[1]!;
    const at = (re: RegExp): string => re.exec(q.sql)![1]!;
    row[at(/"ea_notes"\."id" AS "(__c\d+)"/)] = "n1";
    row[at(/"ea_notes"\."title" AS "(__c\d+)"/)] = "a note";
    row[at(/"ea_notes"\."updated_at" AS "(__c\d+)"/)] =
      "2026-10-17 10:00:00+00";
    row[at(/"ea_notes"\."mood" AS "(__c\d+)"/)] = "calm";
    row[
      at(/COALESCE\("ea_notes_ext_priority"\."priority", \$\d+\) AS "(__c\d+)"/)
    ] = "high";
    return row;
  };
  const compile = (exposed = [notePriority]) => {
    const recording = recordingQueryDb((q) =>
      q.sql.includes(`'note'::text AS "__kind"`) ? [noteRow(q)] : [],
    );
    const compiled = compileUnion(activity, {
      arms: () => [noteServed.binding, linkServed.binding],
      exposed,
      db: recording.db,
    });
    return { compiled, ...recording };
  };

  test("the arm declared from an entity reaches it; one from a raw table would not", () => {
    expect(noteArm.reaches).toBe(notesEntity);
    expect(linkArm.reaches).toBe(linksEntity);
  });

  test("its exposure joins onto that arm only, routed as an alias of it", () => {
    const { compiled } = compile();
    const routes = compiled.window.routes!.routes;
    const priority = routes.find((r) => r.id === "note.ea_notes_ext_priority")!;
    expect(priority.table).toBe("ea_notes_ext_priority");
    expect(priority.map.kind).toBe("alias");
    expect(routes.some((r) => r.id === "link.ea_notes_ext_priority")).toBe(
      false,
    );
  });

  test("its rows carry the slice; the other arm's rows read a typed NULL", async () => {
    const { compiled, calls } = compile();
    const rows = (await compiled.window.loader(
      activity.window.window.encode(),
    )) as Record<string, unknown>[];
    const sqlText = calls[0]!.sql;
    expect(sqlText).toContain(
      'LEFT JOIN "ea_notes_ext_priority" "ea_notes_ext_priority" ON "ea_notes_ext_priority"."parent_id" = "ea_notes"."id"',
    );
    expect(sqlText).toContain('COALESCE("ea_notes_ext_priority"."priority", $');
    expect(rows).toHaveLength(1);
    expect(rows[0]![LIVE_COLUMNS_KEY]).toEqual({
      note: { mood: "calm" },
      ea_notes_ext_priority: { priority: "high" },
    });
    expect(rows[0]![PRIORITY]).toBeUndefined();
  });

  test("a filter on it prunes the arm that cannot hold it; a grouping by it is accepted", () => {
    const { compiled } = compile();
    const filtered = activity.window.window.encode({
      where: { [PRIORITY]: "high" } as never,
      columns: [priorityCols],
    });
    compiled.window.validateParams!(filtered);
    const uses = [...compiled.window.routes!.usesOf(filtered).keys()];
    expect(uses).toContain("note.ea_notes_ext_priority");
    expect(uses.some((id) => id.startsWith("link"))).toBe(false);
    const grouped = activity.groups.groups.encode({
      groupBy: PRIORITY as never,
      columns: [priorityCols],
    } as never);
    expect(() => compiled.groups.validateParams!(grouped)).not.toThrow();
    // …and by an arm's own field, which the descriptor's own decode refuses.
    const byMood = activity.groups.groups.encode({
      groupBy: "note.mood" as never,
      columns: [noteArm],
    } as never);
    expect(() => compiled.groups.validateParams!(byMood)).not.toThrow();
  });

  test("an exposure no arm folds is refused by the server's decode", () => {
    const { compiled } = compile([]);
    const filtered = activity.window.window.encode({
      where: { [PRIORITY]: "high" } as never,
      columns: [priorityCols],
    });
    expect(() => compiled.window.validateParams!(filtered)).toThrow();
  });

  test("an arm declared by its own fields only is refused over a table", () => {
    const bare = liveArm(activity, "bare", {
      label: "Bare",
      order: 40,
      fields: { host: textField({ label: "Host" }) },
    });
    expect(() =>
      served.arm(bare, {
        from: notes,
        id: notes.id,
        base: (j) => ({
          title: j.base.title,
          updatedAt: j.base.updatedAt,
          note: null,
        }),
        extra: () => ({
          host: expr(sql`'x'`, {
            decoder: String,
            sqlType: "text",
            notNull: true,
          }),
        }),
      }),
    ).toThrow(/declared by its own fields/);
  });

  test("two arms reaching one entity are refused", () => {
    const twin = liveArm(activity, "note2", {
      label: "Notes again",
      order: 30,
      from: notesEntity,
    });
    const twinServed = served.arm(twin, {
      from: notes,
      id: notes.id,
      base: (j) => ({
        title: j.base.title,
        updatedAt: j.base.updatedAt,
        note: null,
      }),
      extra: () => ({}),
    });
    const { db } = recordingQueryDb();
    expect(() =>
      compileUnion(activity, {
        arms: () => [noteServed.binding, twinServed.binding],
        exposed: [notePriority],
        db,
      }),
    ).toThrow(/both reach entity "ea_notes"/);
  });
});
