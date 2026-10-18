/**
 * A collection declaring `exposes` — the entities its rows reach — folds every
 * served exposure (`LiveColumns.Expose(ext)`) of those entities, without a
 * database: the recording `QueryDb` renders every statement.
 *
 * - a base exposure joins onto the host's id (alias route, COALESCE to its
 *   field's declared default); a related one joins onto the lookup's `on`
 *   (LEFT, routed `reverse` through the lookup's chain);
 * - a presence field reads the side row's existence (`IS NOT NULL`, or a
 *   `CASE` to its two literals), filtered and grouped on the server;
 * - the values fold into `$columns[<slice>]`; the window filters, sorts,
 *   groups and counts by them;
 * - an `all` set folds them too, and its definition moves with the fold;
 * - boot: both forms are deferred and bound with the contributions;
 * - the bind's refusals.
 *
 * Run: `./singularity test plugins/network/plugins/live`.
 */

import { describe, expect, test } from "bun:test";
import { pgTable, text } from "drizzle-orm/pg-core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { defineEntity } from "@plugins/infra/plugins/entities/server";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import {
  bindDeferredResources,
  collectContributions,
  unboundedWindowKeys,
} from "@plugins/framework/plugins/server-core/core";
import type { ResourceParams } from "@plugins/framework/plugins/resource-runtime/core";
import type { LookupJoin } from "@plugins/infra/plugins/query-resource/core";
import {
  compileWindowQuery,
  recordingQueryDb,
  type RecordedQuery,
} from "@plugins/infra/plugins/query-resource/server/testing";
import {
  exposedColumns,
  liveCollection,
  LIVE_COLUMNS_KEY,
  LIVE_ROW_KEY,
} from "@plugins/network/plugins/live/core";
import { compileCollection, serveCollection } from "./serve-collection";
import { LiveColumns } from "./serve-columns";

const tasks = pgTable("xp_tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
});
const attempts = pgTable("xp_attempts", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
});
const tasksRef = entityRef("xp_tasks", {});
const conversationsRef = entityRef("xp_conversations", {
  id: textField({ label: "Id", filterable: false }),
  title: textField({ label: "Title" }),
  createdAt: dateField({ label: "Created", filterable: false }),
});
// The served entity; `attemptId` is a server-only column (the owner joins read it).
const conversationsEntity = defineEntity(
  conversationsRef,
  { attemptId: textField({ label: "Attempt" }) },
  { primaryKey: "id" },
);
const conversations = conversationsEntity.table;

const track = defineExtension(
  tasks,
  "track",
  defineExtensionShape({
    key: "taskId",
    fields: {
      track: enumTextField(["main", "sidequest"] as const, {
        label: "Track",
        default: "main",
      }),
    },
    exposes: { parent: tasksRef, name: "track", fields: { track: {} } },
  }),
  { columns: { track: { default: "main" } } },
);
const usage = defineExtension(
  conversations,
  "usage",
  defineExtensionShape({
    key: "conversationId",
    fields: { cost: intField({ label: "Cost", default: 0 }) },
    exposes: { parent: conversationsRef, name: "usage", fields: { cost: {} } },
  }),
  { columns: { cost: { default: 0 } } },
);
// Presence: a boolean on the related task, two literals on the base.
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
  conversations,
  "origin",
  defineExtensionShape({
    key: "conversationId",
    fields: {},
    exposes: {
      parent: conversationsRef,
      name: "origin",
      presence: {
        id: "origin",
        label: "Origin",
        values: { present: "agent", absent: "user" },
      },
    },
  }),
);

const ownerJoins = [
  {
    kind: "lookup",
    alias: "attempt",
    table: attempts,
    pk: attempts.id,
    on: { from: "base", col: conversations.attemptId },
    required: true,
  } satisfies LookupJoin<"attempt", typeof attempts>,
  {
    kind: "lookup",
    alias: "task",
    table: tasks,
    pk: tasks.id,
    on: { from: "attempt", col: attempts.taskId },
    required: true,
  } satisfies LookupJoin<"task", typeof tasks>,
] as const;

const trackCols = exposedColumns(track.exposure);
const usageCols = exposedColumns(usage.exposure);
const TRACK = "xp_tasks_ext_track.track";
const COST = "xp_conversations_ext_usage.cost";

let n = 0;
const listOf = () =>
  liveCollection(`test.live.exposed-${n++}`, {
    from: conversationsRef,
    pick: ["id", "title", "createdAt"],
    related: { task: tasksRef },
    id: "id",
    sortable: ["createdAt"],
    default: { orderBy: [["createdAt", "desc"]], limit: 10 },
    maxLimit: 30,
    count: true,
  });
const allOf = (preload?: "boot") =>
  liveCollection(`test.live.exposed-all-${n++}`, {
    from: conversationsRef,
    pick: ["id", "title", "createdAt"],
    baseExposures: false,
    related: { task: tasksRef },
    id: "id",
    all: { orderBy: [["createdAt", "desc"]], unbounded: { reason: "test" } },
    ...(preload ? { preload } : {}),
  });

function compile(script?: (q: RecordedQuery) => unknown[]) {
  const c = listOf();
  const recording = recordingQueryDb(script);
  const specs = compileCollection(
    c,
    { from: conversations, joins: ownerJoins, db: recording.db },
    [],
    [track, usage],
  );
  return {
    c,
    specs,
    window: compileWindowQuery(c.window, specs.window).serverOpts,
    rows: compileWindowQuery(c.rows, specs.rows).serverOpts,
    ...recording,
  };
}

const roles = (
  plan: { usesOf(p: ResourceParams): ReadonlyMap<string, { role: string }> },
  params: ResourceParams,
) =>
  Object.fromEntries([...plan.usesOf(params)].map(([id, u]) => [id, u.role]));

describe("exposed columns — the window", () => {
  test("each reached exposure is projected under its wire names and folded into $columns", async () => {
    const created = new Date("2026-10-12T10:00:00.000Z");
    // The row as the database answers it — its row key's parts (the order
    // key's text, then the id) included.
    const { c, window, rows, calls } = compile(() => [
      {
        id: "c1",
        title: "t",
        createdAt: created,
        [TRACK]: "main",
        [COST]: 0,
        __row_key_0: "2026-10-12 10:00:00+00",
        __row_key_1: "c1",
      },
    ]);
    const [row] = (await window.loader(c.window.window.encode())) as Record<
      string,
      unknown
    >[];
    expect(calls[0]!.sql).toContain(
      'COALESCE("xp_tasks_ext_track"."track", $1)',
    );
    // The alias is the slice — the table's own name, which drizzle then
    // leaves unaliased.
    expect(calls[0]!.sql).toContain(
      'left join "xp_tasks_ext_track" on "xp_tasks_ext_track"."parent_id" = "attempt"."task_id"',
    );
    expect(calls[0]!.sql).toContain(
      'left join "xp_conversations_ext_usage" on "xp_conversations_ext_usage"."parent_id" = "xp_conversations"."id"',
    );
    expect(calls[0]!.params).toContain("main");
    expect(row).toEqual({
      id: "c1",
      title: "t",
      createdAt: created,
      [LIVE_COLUMNS_KEY]: {
        xp_tasks_ext_track: { track: "main" },
        xp_conversations_ext_usage: { cost: 0 },
      },
      [LIVE_ROW_KEY]: '["2026-10-12 10:00:00+00","c1"]',
    });
    const [point] = (await rows.loader(c.rows.point.encode(["c1"]))) as Record<
      string,
      unknown
    >[];
    expect(point![LIVE_COLUMNS_KEY]).toEqual(row![LIVE_COLUMNS_KEY]);
  });

  test("a base exposure routes as an alias; a related one `reverse`, probed through the lookup's chain", async () => {
    const { window, calls } = compile(() => [{ id: "c1" }, { id: "c2" }]);
    const route = (id: string) =>
      window.routes!.routes.find((r) => r.id === id)!;
    expect(route("xp_conversations_ext_usage").map).toEqual({ kind: "alias" });
    const reverse = route("xp_tasks_ext_track").map;
    expect(reverse.kind).toBe("reverse");
    const hosts = await (
      reverse as {
        resolve: (
          changed: readonly string[],
          within: ReadonlySet<string> | null,
          cap: number,
        ) => Promise<readonly string[] | "over-cap">;
      }
    ).resolve(["t1"], null, 10);
    expect(hosts).toEqual(["c1", "c2"]);
    expect(calls.at(-1)!.sql).toBe(
      'select distinct "xp_conversations"."id" from "xp_conversations" inner join "xp_attempts" "attempt" on "attempt"."id" = "xp_conversations"."attempt_id" where "attempt"."task_id" = ANY($1::text[]) limit $2',
    );
  });

  test("its join is value while only projected, membership when the tuple filters by it", () => {
    const { c, window } = compile();
    const codec = c.window.window;
    expect(roles(window.routes!, codec.encode())).toMatchObject({
      xp_tasks_ext_track: "value",
      xp_conversations_ext_usage: "value",
    });
    const filtered = codec.encode({
      where: { [TRACK]: "sidequest" } as never,
      columns: [trackCols, usageCols],
    });
    expect(roles(window.routes!, filtered)).toMatchObject({
      attempt: "membership",
      xp_tasks_ext_track: "membership",
      xp_conversations_ext_usage: "value",
    });
    // The params gate decodes against the exposures it serves.
    expect(() => c.window.validateParams(filtered)).toThrow();
    expect(() => window.validateParams!(filtered)).not.toThrow();
  });

  test("a filter on the declared default reads the COALESCE", async () => {
    const { c, window, calls } = compile();
    await window.loader(
      c.window.window.encode({
        where: { [TRACK]: "main" } as never,
        columns: [trackCols],
      }),
    );
    expect(calls[0]!.sql).toMatch(
      /where .*COALESCE\("xp_tasks_ext_track"\."track", \$\d+\) = \$\d+/,
    );
  });

  test("a grouping and a count read an exposed column on the server", async () => {
    const { c, specs, calls } = compile(() => [{ value: "main", count: 3 }]);
    const params = c.groups.groups.encode({
      groupBy: TRACK as never,
      columns: [trackCols],
    });
    expect(() => c.groups.validateParams(params)).toThrow();
    expect(() => specs.groups.validateParams!(params)).not.toThrow();
    expect(await specs.groups.loader(params)).toEqual([
      { value: "main", count: 3 },
    ]);
    // The COALESCE (its default bound once) is selected and named by its
    // ordinal — a second rendering would bind a second `$n`.
    expect(calls[0]!.sql).toContain(
      'select COALESCE("xp_tasks_ext_track"."track", $1), count(*)',
    );
    expect(calls[0]!.sql).toContain(
      "group by 1 order by count(*) DESC, 1 ASC NULLS LAST",
    );
    const count = c.count.count.encode({
      where: { [COST]: { gt: 0 } },
      columns: [usageCols],
    });
    expect(() => specs.count!.validateParams!(count)).not.toThrow();
  });

  test("a presence field projects, filters and groups by the side row's existence", async () => {
    const STARRED = "xp_tasks_ext_starred.starred";
    const ORIGIN = "xp_conversations_ext_origin.origin";
    const created = new Date("2026-10-12T10:00:00.000Z");
    const c = listOf();
    const recording = recordingQueryDb((q) =>
      q.sql.includes("group by")
        ? [{ value: "agent", count: 2 }]
        : [
            {
              id: "c1",
              title: "t",
              createdAt: created,
              [STARRED]: true,
              [ORIGIN]: "user",
              __row_key_0: "2026-10-12 10:00:00+00",
              __row_key_1: "c1",
            },
          ],
    );
    const specs = compileCollection(
      c,
      { from: conversations, joins: ownerJoins, db: recording.db },
      [],
      [starred, origin],
    );
    const window = compileWindowQuery(c.window, specs.window).serverOpts;
    const columns = [
      exposedColumns(starred.exposure),
      exposedColumns(origin.exposure),
    ];
    const [row] = (await window.loader(
      c.window.window.encode({
        where: { [STARRED]: true, [ORIGIN]: "agent" } as never,
        columns,
      }),
    )) as Record<string, unknown>[];
    const { sql } = recording.calls[0]!;
    expect(sql).toContain('("xp_tasks_ext_starred"."parent_id" IS NOT NULL)');
    expect(sql).toContain(
      '(CASE WHEN "xp_conversations_ext_origin"."parent_id" IS NOT NULL THEN $',
    );
    expect(sql).toMatch(
      /where .*\("xp_tasks_ext_starred"\."parent_id" IS NOT NULL\) = \$\d+/,
    );
    expect(row![LIVE_COLUMNS_KEY]).toEqual({
      xp_tasks_ext_starred: { starred: true },
      xp_conversations_ext_origin: { origin: "user" },
    });
    // The filter makes the join membership; the routes stay the side tables'.
    expect(
      roles(
        window.routes!,
        c.window.window.encode({
          where: { [STARRED]: true } as never,
          columns,
        }),
      ),
    ).toMatchObject({
      xp_tasks_ext_starred: "membership",
      xp_conversations_ext_origin: "value",
    });
    const groups = c.groups.groups.encode({
      groupBy: ORIGIN as never,
      columns,
    });
    expect(await specs.groups.loader(groups)).toEqual([
      { value: "agent", count: 2 },
    ]);
    expect(recording.calls.at(-1)!.sql).toContain(
      'select (CASE WHEN "xp_conversations_ext_origin"."parent_id" IS NOT NULL THEN $1::text ELSE $2::text END), count(*)',
    );
  });

  test("`as` names the field in lists, so it collides by that id", () => {
    const renamed = defineExtension(
      tasks,
      "renamed",
      defineExtensionShape({
        key: "taskId",
        fields: { n: intField({ label: "N" }) },
        exposes: {
          parent: tasksRef,
          name: "renamed",
          fields: { n: { as: "title" } },
        },
      }),
    );
    expect(() =>
      compileCollection(
        listOf(),
        { from: conversations, joins: ownerJoins },
        [],
        [renamed],
      ),
    ).toThrow(
      /exposed field "title" of "xp_tasks_ext_renamed" collides with the collection's row's/,
    );
  });

  test("an exposure of an entity the collection does not reach is not folded", () => {
    const c = liveCollection(`test.live.exposed-narrow-${n++}`, {
      from: conversationsRef,
      pick: ["id", "title", "createdAt"],
      id: "id",
      sortable: ["createdAt"],
      default: { orderBy: [["createdAt", "desc"]], limit: 10 },
      maxLimit: 30,
    });
    const specs = compileCollection(
      c,
      { from: conversations, joins: ownerJoins },
      [],
      [track, usage],
    );
    expect(Object.keys(specs.select)).toEqual([
      "id",
      "title",
      "createdAt",
      COST,
    ]);
  });
});

describe("exposed columns — the bind's refusals", () => {
  const compileWith = (reach: {
    from?: ReturnType<typeof entityRef>;
    related?: Record<string, ReturnType<typeof entityRef>>;
  }) =>
    compileCollection(
      liveCollection(`test.live.exposed-bad-${n++}`, {
        ...reach,
        carry: {
          fields: {
            id: textField(),
            title: textField(),
            createdAt: dateField(),
          },
        },
        id: "id",
        sortable: ["createdAt"],
        default: { orderBy: [["createdAt", "desc"]], limit: 10 },
        maxLimit: 30,
      }),
      { from: conversations, joins: ownerJoins },
      [],
      [track],
    );

  test("`base` must be the collection's own entity", () => {
    expect(() => compileWith({ from: tasksRef })).toThrow(
      /`exposes.base` names entity "xp_tasks", but the collection reads table "xp_conversations"/,
    );
  });

  test("a relation must be a declared lookup over the entity", () => {
    expect(() => compileWith({ related: { owner: tasksRef } })).toThrow(
      /names relation "owner", which is neither `base` nor a join/,
    );
    expect(() => compileWith({ related: { attempt: tasksRef } })).toThrow(
      /`exposes.attempt` names entity "xp_tasks", but join "attempt" reads table "xp_attempts"/,
    );
  });

  test("an exposed field colliding with a row field is refused", () => {
    const clash = defineExtension(
      tasks,
      "clash",
      defineExtensionShape({
        key: "taskId",
        fields: { title: enumTextField(["x"] as const) },
        exposes: {
          parent: tasksRef,
          name: "clash",
          fields: { title: { label: "Title" } },
        },
      }),
    );
    expect(() =>
      compileCollection(
        listOf(),
        { from: conversations, joins: ownerJoins },
        [],
        [clash],
      ),
    ).toThrow(
      /exposed field "title" of "xp_tasks_ext_clash" collides with the collection's row's/,
    );
  });
});

describe("exposed columns — the `all` form", () => {
  const sample = (q: RecordedQuery): unknown[] =>
    q.sql.includes("__id")
      ? []
      : [
          {
            id: "c1",
            title: "t",
            createdAt: "2026-10-12T10:00:00.000Z",
            [TRACK]: "sidequest",
          },
        ];

  test("folds its exposures into $columns, and its definition moves with the fold", async () => {
    const c = allOf();
    const opts = { from: conversations, joins: ownerJoins } as const;
    const bare = compileCollection(c, opts);
    const recording = recordingQueryDb(sample);
    const folded = compileCollection(
      c,
      { ...opts, db: recording.db },
      [],
      [track],
    );
    expect(folded.definition).not.toBe(bare.definition);
    const rows = (await folded.all.loader({})) as Record<string, unknown>[];
    expect(rows[0]![LIVE_COLUMNS_KEY]).toEqual({
      xp_tasks_ext_track: { track: "sidequest" },
    });
    expect(rows[0]).not.toHaveProperty(TRACK);
    expect(recording.calls[0]!.sql).toContain(
      'LEFT JOIN "xp_tasks_ext_track" "xp_tasks_ext_track" ON "xp_tasks_ext_track"."parent_id" = "attempt"."task_id"',
    );
    const route = folded.all.routes.routes.find(
      (r) => r.id === "xp_tasks_ext_track",
    )!;
    expect(route.map.kind).toBe("reverse");
  });

  test("with no exposure reached, rows still carry an empty $columns", async () => {
    const c = allOf();
    const recording = recordingQueryDb((q) =>
      q.sql.includes("__id")
        ? []
        : [{ id: "c1", title: "t", createdAt: "2026-10-12T10:00:00.000Z" }],
    );
    const specs = compileCollection(
      c,
      { from: conversations, joins: ownerJoins, db: recording.db },
      [],
      [usage],
    );
    const rows = (await specs.all.loader({})) as Record<string, unknown>[];
    expect(rows[0]![LIVE_COLUMNS_KEY]).toEqual({});
  });
});

describe("exposed columns — the deferred bind", () => {
  test("a window and an `all` set reaching exposures bind at boot with every LiveColumns.Expose", async () => {
    const created = new Date("2026-10-12T10:00:00.000Z");
    const recording = recordingQueryDb((q) =>
      q.sql.includes("__id")
        ? []
        : q.sql.startsWith("WITH") || q.sql.startsWith("SELECT")
          ? [
              {
                id: "c1",
                title: "t",
                createdAt: "2026-10-12T10:00:00.000Z",
                [TRACK]: "main",
              },
            ]
          : [
              {
                id: "c1",
                title: "t",
                createdAt: created,
                [TRACK]: "main",
                __row_key_0: "2026-10-12 10:00:00+00",
                __row_key_1: "c1",
              },
            ],
    );
    const list = liveCollection(`test.live.exposed-boot-${n++}`, {
      from: conversationsRef,
      pick: ["id", "title", "createdAt"],
      baseExposures: false,
      related: { task: tasksRef },
      id: "id",
      sortable: ["createdAt"],
      default: { orderBy: [["createdAt", "desc"]], limit: 10 },
      maxLimit: 30,
    });
    // Preloaded: the boot snapshot and L2 see its key from module eval.
    const set = allOf("boot");
    const servedList = serveCollection(list, {
      from: conversations,
      joins: ownerJoins,
      db: recording.db,
    });
    const servedSet = serveCollection(set, {
      from: conversations,
      joins: ownerJoins,
      db: recording.db,
    });
    // Declared at module eval: every minted key, and its Declare.
    expect(servedList.keys).toEqual([
      list.key,
      `${list.key}:rows`,
      `${list.key}:groups`,
    ]);
    expect(servedList.declare).toHaveLength(3);
    expect(servedSet.keys).toEqual([set.key, `${set.key}:rows`]);
    // `expect(p).rejects` is typed `void` by bun's matchers: capture instead.
    for (const load of [
      () => servedSet.all.load({}),
      () => servedList.window.load(list.window.window.encode()),
    ]) {
      let early: unknown;
      try {
        await load();
      } catch (err) {
        early = err;
      }
      expect((early as Error).message).toMatch(/is deferred and not bound yet/);
    }

    collectContributions([
      { id: "test.track", contributions: [LiveColumns.Expose(track)] },
    ]);
    bindDeferredResources();
    // Bound as the routed `scopedMembership` alias an `all` set is.
    expect(unboundedWindowKeys()).toContain(set.key);

    const [row] = (await servedList.window.load(
      list.window.window.encode(),
    )) as Record<string, unknown>[];
    expect(row![LIVE_COLUMNS_KEY]).toEqual({
      xp_tasks_ext_track: { track: "main" },
    });
    const [setRow] = (await servedSet.all.load({})) as Record<
      string,
      unknown
    >[];
    expect(setRow![LIVE_COLUMNS_KEY]).toEqual({
      xp_tasks_ext_track: { track: "main" },
    });
  });
});
