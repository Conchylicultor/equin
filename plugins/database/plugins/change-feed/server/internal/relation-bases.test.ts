/**
 * Relation bases (`./relation-bases`, C30): a view expands to the tables it
 * reads, transitively, with each rollup replaced by its sources. Pure — the
 * graph is the one `tasks_v` has at HEAD. Run with
 * `./singularity test plugins/database/plugins/change-feed`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  defineResource,
  notificationsWsHandler,
  notifyStatsFor,
  routeTableChange,
  type TableChange,
} from "@plugins/framework/plugins/server-core/core";
import { mintReachPlan } from "@plugins/framework/plugins/resource-runtime/core";
import { clearRelationBases } from "@plugins/framework/plugins/server-core/core/testing";
import {
  assertRelationBasesSourced,
  createRelationBases,
  installRelationGraph,
  relationBases,
  type RelationGraph,
} from "./relation-bases";

// `view_table_usage` and `rollupSources()` as main has them.
const TREE: RelationGraph = {
  views: new Map([
    [
      "tasks_v",
      [
        "attempt_conv_agg",
        "attempt_push_agg",
        "attempts",
        "task_blocking_v",
        "task_dependencies",
        "tasks",
      ],
    ],
    ["attempts_v", ["attempt_conv_agg", "attempt_push_agg", "attempts"]],
    ["task_blocking_v", ["attempts_v", "task_dependencies", "tasks"]],
    ["conversations_v", ["attempts", "conversations", "tasks"]],
    ["agents_v", ["agents"]],
  ]),
  rollups: new Map([
    ["attempt_conv_agg", ["conversations"]],
    ["attempt_push_agg", ["pushes"]],
    ["task_latest_conversation", ["conversations", "attempts"]],
  ]),
};

describe("createRelationBases", () => {
  const bases = createRelationBases(TREE);

  test("a base table is its own base; an unknown relation too", () => {
    expect(bases("tasks")).toEqual(["tasks"]);
    expect(bases("nowhere")).toEqual(["nowhere"]);
  });

  test("transitive: tasks_v → task_blocking_v → attempts_v → rollups → sources", () => {
    expect(bases("tasks_v")).toEqual([
      "attempts",
      "conversations",
      "pushes",
      "task_dependencies",
      "tasks",
    ]);
    expect(bases("task_blocking_v")).toEqual([
      "attempts",
      "conversations",
      "pushes",
      "task_dependencies",
      "tasks",
    ]);
    expect(bases("agents_v")).toEqual(["agents"]);
    expect(bases("conversations_v")).toEqual([
      "attempts",
      "conversations",
      "tasks",
    ]);
  });

  test("a rollup expands to its sources", () => {
    expect(bases("attempt_push_agg")).toEqual(["pushes"]);
    expect(bases("task_latest_conversation")).toEqual([
      "attempts",
      "conversations",
    ]);
  });

  test("memoized: the same relation answers the same array", () => {
    expect(bases("tasks_v")).toBe(bases("tasks_v"));
    expect(bases("attempts_v")).toBe(bases("attempts_v"));
  });

  test("a cycle throws, naming it", () => {
    const cyclic = createRelationBases({
      views: new Map([
        ["a_v", ["b_v", "t"]],
        ["b_v", ["c_r"]],
      ]),
      rollups: new Map([["c_r", ["a_v"]]]),
    });
    expect(() => cyclic("a_v")).toThrow("cycle a_v → b_v → c_r → a_v");
    // A relation off the cycle still answers.
    expect(cyclic("t")).toEqual(["t"]);
  });

  test("a relation named both a view and a rollup throws", () => {
    expect(() =>
      createRelationBases({
        views: new Map([["x", ["t"]]]),
        rollups: new Map([["x", ["u"]]]),
      }),
    ).toThrow('"x" is both a view and a rollup');
  });
});

describe("relationBases (the boot graph)", () => {
  // `installRelationGraph` also sets server-core's process-global holder.
  afterAll(clearRelationBases);

  test("a read before the graph is set throws; after, it answers", () => {
    // Module state: this suite is the only one in the process that sets it.
    expect(() => relationBases("tasks_v")).toThrow(
      "read before the boot graph was set",
    );
    installRelationGraph(TREE);
    expect(relationBases("attempts_v")).toEqual([
      "attempts",
      "conversations",
      "pushes",
    ]);
  });

  test("the boot install reaches server-core's router: a reader of tasks_v is reached by a conversations write, and not by an unrelated one", async () => {
    // The production wiring (D34): change-feed's `onReadyBlocking` calls
    // `installRelationGraph`, which installs the bases in server-core's
    // runtime and indexes every reach plan's relation reads through them.
    installRelationGraph(TREE);
    const key = "test.relation-bases.wiring";
    defineResource(
      { key, schema: z.number(), validateParams: () => {} },
      {
        mode: "push",
        reach: mintReachPlan({
          routes: [],
          usesOf: () => new Map(),
          relations: [{ relation: "tasks_v", reason: "reads tasks_v whole" }],
        }),
        loader: () => 0,
      },
    );
    // A subscriber: a change reaches the tuples someone holds.
    const handler = notificationsWsHandler as unknown as {
      open(ws: unknown): void;
      message(ws: unknown, raw: string): void;
      close(ws: unknown, code: number, reason: string): void;
    };
    // Resolved by the socket itself when the sub-ack frame is sent.
    let ack!: () => void;
    const acked = new Promise<void>((resolve) => (ack = resolve));
    const ws = {
      send(raw: string) {
        const frame = JSON.parse(raw) as { kind: string; key?: string };
        if (frame.kind === "sub-ack" && frame.key === key) ack();
      },
    };
    handler.open(ws);
    handler.message(ws, JSON.stringify({ op: "sub", key, params: {} }));
    await acked;
    const change = (table: string): TableChange => ({
      source: "feed",
      table,
      op: "U",
      ids: null,
      keys: null,
      unchanged: null,
    });
    routeTableChange(change("lf_unrelated"));
    expect(notifyStatsFor(key).feed).toBe(0);
    // `conversations` reaches `tasks_v` only through the attempt_conv_agg
    // rollup (tasks_v → attempt_conv_agg → conversations).
    routeTableChange(change("conversations"));
    expect(notifyStatsFor(key).feed).toBe(1);
    handler.close(ws, 1000, "test");
  });
});

describe("assertRelationBasesSourced (D35)", () => {
  const sourced = new Set([
    "agents",
    "attempts",
    "conversations",
    "pushes",
    "task_dependencies",
    "tasks",
  ]);

  test("every base sourced: passes", () => {
    expect(() => assertRelationBasesSourced(TREE, sourced)).not.toThrow();
  });

  test("an unsourced base throws, naming every relation that reaches it", () => {
    const withoutPushes = new Set([...sourced].filter((t) => t !== "pushes"));
    let message = "";
    try {
      assertRelationBasesSourced(TREE, withoutPushes);
    } catch (err) {
      message = String(err);
    }
    expect(message).toContain("D35");
    for (const line of [
      'rollup "attempt_push_agg" → "pushes"',
      'view "attempts_v" → "pushes"',
      'view "task_blocking_v" → "pushes"',
      'view "tasks_v" → "pushes"',
    ]) {
      expect(message).toContain(line);
    }
    expect(message).not.toContain("agents_v");
    expect(message).not.toContain("conversations_v");
  });
});
