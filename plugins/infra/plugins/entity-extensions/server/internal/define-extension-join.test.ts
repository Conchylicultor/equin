import { describe, expect, test } from "bun:test";
import { is, SQL } from "drizzle-orm";
import { PgDialect, pgTable, text } from "drizzle-orm/pg-core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { enumTextField } from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { compileJoins } from "@plugins/infra/plugins/query-resource/server";
import { defineExtension } from "./define-extension";

// `ext.join(alias)`: an extension handle as a join of its parent's collection
// (research/2026-09-29-global-scoped-change-routing.md, P2). Kept apart from
// `define-extension.test.ts`, which swaps the database module for a recording
// proxy: nothing here touches a database.

const parent = pgTable("ext_join_probe", { id: text("id").primaryKey() });
const shape = defineExtensionShape({
  key: "songId",
  fields: { plays: intField(), lastPlayedAt: dateField() },
});
const playback = defineExtension(parent, "playback", shape, {
  columns: { plays: { default: 0 } },
});

describe("defineExtension join", () => {
  test("the handle joins its parent's collection as data: LEFT, 1:1 on the parent's id", () => {
    const spec = playback.join("playback");
    expect(spec.kind).toBe("extension");
    expect(spec.alias).toBe("playback");
    expect(spec.table).toBe(playback.table);
    expect(spec.key).toBe(playback.table.songId);
    expect(spec.parentKey).toBe(parent.id);
  });

  test("it offers only the wire columns: the server-only timestamps are not bindable", () => {
    const spec = playback.join("playback");
    expect(Object.keys(spec.wireColumns).sort()).toEqual([
      "lastPlayedAt",
      "plays",
      "songId",
    ]);
    expect(spec.wireColumns).toBe(playback.wireColumns);
  });

  test("the query compiler accepts it (A4) and renders it on its alias", () => {
    const plan = compileJoins(
      { table: parent, name: "ext_join_probe" },
      [playback.join("playback")],
      parent.id,
      "test",
    );
    const plays = plan.render({ from: "playback", col: playback.table.plays });
    expect(plan.relationOf(plays)).toBe("playback");
    expect(plan.joins[0]!.inner).toBe(false);
  });
});

describe("defineExtension join — a missing side row reads its defaults", () => {
  const plan = () =>
    compileJoins(
      { table: parent, name: "ext_join_probe" },
      [playback.join("playback")],
      parent.id,
      "test",
    );
  const dialect = new PgDialect();

  test("a column with a literal default renders COALESCE(alias.col, default): never NULL, in a filter, sort or projection", () => {
    const p = plan();
    const plays = p.render({ from: "playback", col: playback.table.plays });
    expect(is(plays, SQL)).toBe(true);
    const q = dialect.sqlToQuery(plays as SQL);
    expect(q.sql).toBe(`COALESCE("playback"."plays", $1)`);
    expect(q.params).toEqual([0]);
    // Its provenance is still the join, and it is non-nullable (keyset keys and
    // the LEFT-join nullable-field rule read this).
    expect(p.relationOf(plays)).toBe("playback");
    expect(p.columnOf(plays).name).toBe("plays");
    expect(p.canBeNull(plays)).toBe(false);
    // One expression per (relation, column): identity is stable across renders.
    expect(p.render({ from: "playback", col: playback.table.plays })).toBe(
      plays,
    );
  });

  test("an undefaulted column stays the raw alias column, and nullable through the LEFT join", () => {
    const p = plan();
    const last = p.render({
      from: "playback",
      col: playback.table.lastPlayedAt,
    });
    expect(is(last, SQL)).toBe(false);
    expect(p.canBeNull(last)).toBe(true);
  });

  test("the join condition compares the stored key, never a default", () => {
    const [join] = plan().joins;
    expect(dialect.sqlToQuery(join!.on).sql).toBe(
      `"playback"."parent_id" = "ext_join_probe"."id"`,
    );
  });
});

// ── An exposing extension: its exposure, asserted against its table; its
// join reads each exposed field's `absent`, and reaches a RELATED host by `on`.
describe("defineExtension — exposes", () => {
  const tasks = pgTable("tasks", { id: text("id").primaryKey() });
  const attempts = pgTable("expose_attempts", {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
  });
  const conversations = pgTable("expose_conversations", {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id").notNull(),
  });
  const trackShape = defineExtensionShape({
    key: "taskId",
    fields: { track: enumTextField(["sidequest"] as const) },
    exposes: {
      parent: entityRef("tasks"),
      name: "track",
      fields: { track: { label: "Track", absent: "main" } },
    },
  });
  const track = defineExtension(tasks, "track", trackShape);
  const dialect = new PgDialect();

  test("the handle carries the shape's exposure, and its join the absents", () => {
    expect(track.exposure).toBe(trackShape.exposure);
    expect(track.join("t").absent).toEqual({ track: "main" });
  });

  test("an exposure that names another parent, name or a disagreeing default throws", () => {
    const other = pgTable("not_tasks", { id: text("id").primaryKey() });
    expect(() => defineExtension(other, "track", trackShape)).toThrow(
      /exposes to entity "tasks", but its parent table is "not_tasks"/,
    );
    expect(() => defineExtension(tasks, "lane", trackShape)).toThrow(
      /`exposes.name` is "track", but it is defined as "lane"/,
    );
    const counted = defineExtensionShape({
      key: "taskId",
      fields: { n: intField() },
      exposes: {
        parent: entityRef("tasks"),
        name: "counted",
        fields: { n: { label: "N", absent: 0 } },
      },
    });
    expect(() =>
      defineExtension(tasks, "counted", counted, {
        columns: { n: { default: 1 } },
      }),
    ).toThrow(
      /reads 0 where the side row is missing, but its column defaults to 1/,
    );
    expect(() =>
      defineExtension(tasks, "counted", counted, {
        columns: { n: { default: 0 } },
      }),
    ).not.toThrow();
  });

  test("absent is a plain param, decoded through the column's schema widened by it", () => {
    const plan = compileJoins(
      { table: tasks, name: "tasks" },
      [track.join("tasks_ext_track")],
      tasks.id,
      "test",
    );
    const read = plan.render({
      from: "tasks_ext_track",
      col: track.table.track,
    });
    const q = dialect.sqlToQuery(read as SQL);
    expect(q.sql).toBe(`COALESCE("tasks_ext_track"."track", $1)`);
    expect(q.params).toEqual(["main"]);
    expect(plan.canBeNull(read)).toBe(false);
    // The read decodes "main", which the stored column itself refuses.
    const { decoder } = read as unknown as {
      decoder: { mapFromDriverValue: (v: unknown) => unknown };
    };
    expect(decoder.mapFromDriverValue("main")).toBe("main");
    expect(decoder.mapFromDriverValue("sidequest")).toBe("sidequest");
    expect(() => decoder.mapFromDriverValue("other")).toThrow();
  });

  test("`on` joins a related host's extension: LEFT on that column, routed through its chain", () => {
    const plan = compileJoins(
      { table: conversations, name: "expose_conversations" },
      [
        {
          kind: "lookup",
          alias: "attempt",
          table: attempts,
          pk: attempts.id,
          on: { from: "base", col: conversations.attemptId },
          required: true,
        },
        track.join("tasks_ext_track", {
          on: { from: "attempt", col: attempts.taskId },
        }),
      ],
      conversations.id,
      "test",
    );
    const join = plan.joins[1]!;
    expect(join.inner).toBe(false);
    expect(join.parent).toBe("attempt");
    expect(dialect.sqlToQuery(join.on).sql).toBe(
      `"tasks_ext_track"."parent_id" = "attempt"."task_id"`,
    );
    expect([...plan.closure(["tasks_ext_track"])].sort()).toEqual([
      "attempt",
      "tasks_ext_track",
    ]);
  });

  test("an `on` naming no earlier relation, or of another type, throws", () => {
    expect(() =>
      compileJoins(
        { table: conversations, name: "expose_conversations" },
        [
          track.join("tasks_ext_track", {
            on: { from: "attempt", col: attempts.taskId },
          }),
        ],
        conversations.id,
        "test",
      ),
    ).toThrow(
      /its `on` names "attempt", which is not the base or a join declared before it/,
    );
  });
});
