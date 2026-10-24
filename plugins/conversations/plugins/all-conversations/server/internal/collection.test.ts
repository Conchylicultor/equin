/**
 * The two conversation-list collections, compiled from their REAL declarations
 * and options against a recording `QueryDb` (no database):
 *
 * - the All list's `unless: "kind"` default — ANDed into a window tuple whose
 *   filter does not name `kind`, dropped when it does (any op), never in the
 *   `:rows` point read; History has no default at all;
 * - the routes each list registers, and their gates: `conversations` identity
 *   (no poller column), `attempts` and `tasks` reverse on their pk, the
 *   `tasks` probe reading `attempts` (A10), never `tasks`;
 * - the task relation's role: membership (a required lookup), moving on `id`
 *   alone — a rename is a VALUE change for the tuple — unless the tuple
 *   searches or filters `taskTitle`.
 *
 * Run: `./equin test plugins/conversations/plugins/all-conversations`.
 */

import { describe, expect, test } from "bun:test";
import type { LiveWindowParams } from "@plugins/network/plugins/live/core";
import { compileCollection } from "@plugins/network/plugins/live/server/testing";
import {
  compileWindowQuery,
  recordingQueryDb,
} from "@plugins/infra/plugins/query-resource/server/testing";
import {
  _conversations,
  conversationOwnerColumns,
  conversationOwnerJoins,
} from "@plugins/tasks/plugins/tasks-core/server";
import { clause } from "@plugins/network/plugins/live/plugins/filter/core";
import {
  allConversations,
  CONVERSATION_SEARCHABLE,
  conversationHistory,
} from "../../core";
import { allConversationsDefaults } from "./defaults";

function compileAll() {
  const recording = recordingQueryDb();
  const specs = compileCollection(allConversations, {
    from: _conversations,
    joins: conversationOwnerJoins,
    columns: conversationOwnerColumns,
    defaults: allConversationsDefaults,
    db: recording.db,
  });
  return {
    window: compileWindowQuery(allConversations.window, specs.window)
      .serverOpts,
    rows: compileWindowQuery(allConversations.rows, specs.rows).serverOpts,
    specs,
    ...recording,
  };
}

function compileHistory() {
  const recording = recordingQueryDb();
  const specs = compileCollection(conversationHistory, {
    from: _conversations,
    joins: conversationOwnerJoins,
    columns: conversationOwnerColumns,
    db: recording.db,
  });
  return {
    window: compileWindowQuery(conversationHistory.window, specs.window)
      .serverOpts,
    ...recording,
  };
}

const KIND_DEFAULT = `"conversations"."kind" <> `;
const w = allConversations.window.window;

describe("conversations.all — the `unless: kind` default", () => {
  test("ANDed into a tuple whose filter does not name kind", async () => {
    const { window, calls } = compileAll();
    await window.loader(w.encode());
    expect(calls.at(-1)!.sql).toContain(KIND_DEFAULT);
    expect(calls.at(-1)!.params).toContain("system");
    await window.loader(w.encode({ where: { status: { eq: "working" } } }));
    expect(calls.at(-1)!.sql).toContain(KIND_DEFAULT);
  });

  test("dropped when the tuple's filter names kind, with any op", async () => {
    const { window, calls } = compileAll();
    for (const where of [
      { kind: { eq: "system" as const } },
      { kind: { in: ["user" as const, "agent" as const] } },
      { kind: { notIn: ["system" as const] } },
    ]) {
      await window.loader(w.encode({ where }));
      expect(calls.at(-1)!.sql).not.toContain(KIND_DEFAULT);
    }
  });

  test("never in the point read", async () => {
    const { rows, calls } = compileAll();
    await rows.loader(allConversations.rows.point.encode(["c1"]));
    expect(calls.at(-1)!.sql).not.toContain(KIND_DEFAULT);
  });

  test("History has no default", async () => {
    const { window, calls } = compileHistory();
    await window.loader(conversationHistory.window.window.encode());
    expect(calls.at(-1)!.sql).not.toContain(KIND_DEFAULT);
  });
});

describe("conversation lists — routes", () => {
  test("conversations identity, attempts and tasks reverse on their pk; no poller column gates", () => {
    const { window } = compileAll();
    const routes = window.routes!.routes;
    expect(routes.map((r) => [r.id, r.table, r.map.kind])).toEqual([
      ["base", "conversations", "identity"],
      ["attempt", "attempts", "reverse"],
      ["task", "tasks", "reverse"],
    ]);
    const columns = (id: string) =>
      [...routes.find((r) => r.id === id)!.columns].sort();
    expect(columns("base")).toEqual(
      [
        "attempt_id",
        "created_at",
        "ended_at",
        "id",
        "kind",
        "model",
        "runtime",
        "spawned_by",
        "status",
        "title",
        "updated_at",
      ].sort(),
    );
    expect(columns("attempt")).toEqual(["id", "task_id", "worktree_path"]);
    expect(columns("task")).toEqual(["id", "title"]);
    for (const poller of ["waiting_for", "last_viewed_at"]) {
      expect(columns("base")).not.toContain(poller);
    }
  });

  test("the tasks probe reads attempts, never the changed tasks (A10); the attempts probe reads only the base", async () => {
    const { window, calls } = compileAll();
    const routes = window.routes!.routes;
    const probe = async (id: string) => {
      const map = routes.find((r) => r.id === id)!.map;
      if (map.kind !== "reverse") throw new Error(`${id} is not reverse`);
      await map.resolve(["x"], null, 500);
      return calls.at(-1)!.sql;
    };
    const task = await probe("task");
    expect(task).toContain(`"attempts"`);
    expect(task).not.toContain(`"tasks"`);
    const attempt = await probe("attempt");
    expect(attempt).not.toContain(`"attempts"`);
    expect(attempt).toContain(`"conversations"."attempt_id" = ANY(`);
  });

  test("the task relation is membership moving on id alone, plus title when the tuple searches or filters taskTitle", () => {
    const { window } = compileAll();
    const movesOf = (params: LiveWindowParams) => {
      const use = window.routes!.usesOf(params).get("task")!;
      return use.role === "membership" ? [...(use.moves ?? [])] : "value";
    };
    expect(movesOf(w.encode())).toEqual(["id"]);
    expect(
      movesOf(w.encode({ where: { taskTitle: { contains: "x" } } })),
    ).toEqual(["id", "title"]);
    // The search box, lowered as the DataView lowers it: an OR of `contains`
    // over the searchable columns, taskTitle among them.
    const search = {
      or: CONVERSATION_SEARCHABLE.map((column) =>
        clause(column, "contains", "x"),
      ),
    };
    expect(movesOf(w.encode({ where: search }))).toEqual(["id", "title"]);
  });
});
