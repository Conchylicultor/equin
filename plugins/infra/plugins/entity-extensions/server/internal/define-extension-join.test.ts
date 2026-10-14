import { describe, expect, test } from "bun:test";
import { is, SQL } from "drizzle-orm";
import { PgDialect, pgTable, text } from "drizzle-orm/pg-core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { enumTextField } from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import {
  compileJoins,
  presenceExpr,
} from "@plugins/infra/plugins/query-resource/server";
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
// join reads each exposed field's DERIVED missing-row value (its declared
// default, else NULL) and its presence, and reaches a RELATED host by `on`.
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
  const tasksRef = entityRef("tasks", {});
  const trackShape = defineExtensionShape({
    key: "taskId",
    fields: {
      track: enumTextField(["main", "sidequest"] as const, {
        label: "Track",
        default: "main",
      }),
    },
    exposes: { parent: tasksRef, name: "track", fields: { track: {} } },
  });
  const track = defineExtension(tasks, "track", trackShape, {
    columns: { track: { default: "main" } },
  });
  const dialect = new PgDialect();

  test("the handle carries the shape's exposure, and its join the derived absents", () => {
    expect(track.exposure).toBe(trackShape.exposure);
    expect(track.join("t").absent).toEqual({ track: "main" });
    expect(track.join("t").presence).toBeUndefined();
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
      fields: { n: intField({ label: "N", default: 0 }) },
      exposes: { parent: tasksRef, name: "counted", fields: { n: {} } },
    });
    expect(() =>
      defineExtension(tasks, "counted", counted, {
        columns: { n: { default: 1 } },
      }),
    ).toThrow(
      /reads its default 0 where the side row is missing, but its column defaults to 1/,
    );
    expect(() =>
      defineExtension(tasks, "counted", counted, {
        columns: { n: { default: 0 } },
      }),
    ).not.toThrow();
    // No declared default: a missing row reads NULL, which a DB default
    // would contradict — the default belongs on the field.
    const undeclared = defineExtensionShape({
      key: "taskId",
      fields: { n: intField({ label: "N" }) },
      exposes: { parent: tasksRef, name: "undeclared", fields: { n: {} } },
    });
    expect(() =>
      defineExtension(tasks, "undeclared", undeclared, {
        columns: { n: { default: 0 } },
      }),
    ).toThrow(/declares no default, so a missing side row reads NULL/);
  });

  test("a declared default is COALESCEd as a plain param; no default reads the raw column", () => {
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

    const countsShape = defineExtensionShape({
      key: "taskId",
      fields: { n: intField({ label: "N" }) },
      exposes: { parent: tasksRef, name: "counts", fields: { n: {} } },
    });
    const counts = defineExtension(tasks, "counts", countsShape);
    expect(counts.join("c").absent).toEqual({ n: null });
    const raw = compileJoins(
      { table: tasks, name: "tasks" },
      [counts.join("c")],
      tasks.id,
      "test",
    ).render({ from: "c", col: counts.table.n });
    expect(is(raw, SQL)).toBe(false);
  });

  test("a presence field rides the join and renders IS NOT NULL, or a CASE to its literals", () => {
    const starred = defineExtension(
      tasks,
      "starred",
      defineExtensionShape({
        key: "taskId",
        fields: {},
        exposes: {
          parent: tasksRef,
          name: "starred",
          presence: { id: "starred", label: "Starred" },
        },
      }),
    );
    const origin = defineExtension(
      tasks,
      "origin",
      defineExtensionShape({
        key: "taskId",
        fields: {},
        exposes: {
          parent: tasksRef,
          name: "origin",
          presence: {
            id: "origin",
            label: "Origin",
            values: { present: "agent", absent: "user" },
          },
        },
      }),
    );
    const s = starred.join("s");
    const o = origin.join("o");
    expect(s.presence).toEqual({ starred: { values: null } });
    expect(s.absent).toEqual({});
    expect(o.presence).toEqual({
      origin: { values: { present: "agent", absent: "user" } },
    });
    const plan = compileJoins(
      { table: tasks, name: "tasks" },
      [s, o],
      tasks.id,
      "test",
    );
    const bool = presenceExpr(
      s,
      "starred",
      plan.render({ from: "s", col: s.key }),
    );
    expect(bool.sqlType).toBe("boolean");
    expect(bool.notNull).toBe(true);
    expect(dialect.sqlToQuery(bool.sql).sql).toBe(
      `"s"."parent_id" IS NOT NULL`,
    );
    const lit = presenceExpr(
      o,
      "origin",
      plan.render({ from: "o", col: o.key }),
    );
    expect(lit.sqlType).toBe("text");
    const q = dialect.sqlToQuery(lit.sql);
    expect(q.sql).toBe(
      `CASE WHEN "o"."parent_id" IS NOT NULL THEN $1::text ELSE $2::text END`,
    );
    expect(q.params).toEqual(["agent", "user"]);
    expect(() => presenceExpr(s, "origin", s.key)).toThrow(
      /declares no presence field "origin"/,
    );
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
