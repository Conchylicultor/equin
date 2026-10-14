// The compile-SQL golden matrix: a fixed set of window / point / grouping
// declarations — direct `compileWindowQuery` specs and `serveCollection`
// collections — compiled against the recording `QueryDb` and driven through
// every shape (full, scoped, `windowIdsOf`, point, reverse `resolve`, groups),
// recording the SQL and params each renders plus the routes, `usesOf`, order
// signatures, folded output, and how many times each tuple's `where` /
// `orderBy` was resolved.
//
// `gen-compile-golden.ts` (beside this file) writes the record to
// `plugins/network/plugins/live/server/testing/compile-sql-golden.json`;
// `server/internal/compile-sql-golden.test.ts` recomputes it and compares. It
// pins a refactor of the bounded / grouping compilers byte for byte (step 9 of
// research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md). A deliberate
// change to the SQL regenerates the fixture and reviews its diff.

import { fileURLToPath } from "node:url";
import { z } from "zod";
import { eq, gt, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { defineRollup } from "@plugins/database/plugins/derived-tables/core";
import { parsed } from "@plugins/database/plugins/sql-projection/server";
import {
  ATTEMPT_CONV_AGG_TABLE,
  TASK_LATEST_CONVERSATION_TABLE,
} from "@plugins/database/plugins/derived-views/core";
import {
  aggregate,
  BASE_RELATION,
  childrenJoin,
  closureJoin,
  expr,
  jsonAgg,
  type ExtensionJoin,
  type KeyedSideJoin,
  type LookupJoin,
  type WindowQueryResourceContract,
} from "@plugins/infra/plugins/query-resource/core";
import type {
  PointQueryResourceSpec,
  WindowQueryResourceSpec,
} from "@plugins/infra/plugins/query-resource/server";
import {
  compileAllCollection,
  compileWindowQuery,
  recordingQueryDb,
  type RecordedQuery,
} from "@plugins/infra/plugins/query-resource/server/testing";
import type { ResourceParams } from "@plugins/framework/plugins/resource-runtime/core";
import type {
  PointParams,
  WindowParams,
} from "@plugins/primitives/plugins/live-state/core";
import { nullable } from "@plugins/fields/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { enumTextField } from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import {
  liveNumber,
  liveText,
} from "@plugins/network/plugins/live/plugins/filter/core";
import {
  exposedColumns,
  liveCollection,
  scopedLiveColumns,
  type LiveColumnsDeclaration,
} from "../../core";
import {
  pointQueryResourceDescriptor,
  windowQueryResourceDescriptor,
} from "../../core/internal/window-descriptor";
import {
  compileCollection,
  type CollectionSpecs,
} from "../internal/serve-collection";
import {
  serveScopedColumns,
  type ScopedMemberRead,
} from "../internal/serve-columns";

/** The fixture's absolute path (`plugins/network/plugins/live/server/testing/compile-sql-golden.json`). */
export const COMPILE_SQL_GOLDEN_FILE = fileURLToPath(
  new URL("./compile-sql-golden.json", import.meta.url),
);

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };

/** A JSON spelling of anything a compile hands back — functions, Sets, Maps, Dates and errors included. */
export function plain(value: unknown): Json {
  if (value === undefined) return "$undefined";
  if (value === null) return null;
  if (typeof value === "function") return "$function";
  if (typeof value === "bigint") return `$bigint:${value}`;
  if (typeof value !== "object") return value as Json;
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof Error) return { $error: value.message };
  if (value instanceof Set) {
    return { $set: [...value].map(plain).sort(byJson) };
  }
  if (value instanceof Map) {
    return { $map: [...value].map(([k, v]) => [plain(k), plain(v)]) };
  }
  if (Array.isArray(value)) return value.map(plain);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      plain(v),
    ]),
  );
}

function byJson(a: Json, b: Json): number {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Runs one shape, answering its value or the message it threw — a throw is part of the record. */
export async function outcome(run: () => unknown): Promise<Json> {
  try {
    return { value: plain(await run()) };
  } catch (err) {
    if (err instanceof Error) return { threw: err.message };
    throw err;
  }
}

/**
 * The recording db's answer: the case's sample rows, each carrying every
 * row-key part and family member the rendered SQL projects (row 1's first
 * key part NULL, row 2's over the 1 KiB row-key bound), a grouping's one NULL group, and a reverse probe's hosts.
 */
function scriptFor(sample: readonly Record<string, unknown>[]) {
  return (q: RecordedQuery): unknown[] => {
    if (q.sql.startsWith("select distinct"))
      return [{ id: "h1" }, { id: "h2" }];
    if (q.sql.includes(`count(*)`)) return [{ value: null, count: 2 }];
    const parts = [...q.sql.matchAll(/as "(__row_key_\d+|__family_\d+)"/g)].map(
      (m) => m[1]!,
    );
    return sample.map((row, r) => ({
      ...row,
      ...Object.fromEntries(
        parts.map((part) => [
          part,
          r === 1 && part === "__row_key_0"
            ? null
            : r === 2 && part === "__row_key_0"
              ? `${part}:${"k".repeat(1100)}`
              : `${part}:${r}`,
        ]),
      ),
    }));
  };
}

/** Counts each call of a spec's per-tuple `where` / `orderBy`. */
interface Counters {
  where: number;
  orderBy: number;
}

function counted<P extends ResourceParams>(
  spec: WindowQueryResourceSpec<P>,
  counters: Counters,
): WindowQueryResourceSpec<P> {
  const { where, orderBy } = spec;
  return {
    ...spec,
    ...(typeof where === "function"
      ? {
          where: (params: P) => {
            counters.where++;
            return where(params);
          },
        }
      : {}),
    ...(typeof orderBy === "function"
      ? {
          orderBy: (params: P) => {
            counters.orderBy++;
            return orderBy(params);
          },
        }
      : {}),
  };
}

export type ServerOpts = ReturnType<typeof compileWindowQuery>["serverOpts"];

/** The compiled options as data: every option, a function as `$function`, the routes apart. */
function optionsOf(opts: ServerOpts): Json {
  const {
    routes,
    loader: _loader,
    ...rest
  } = opts as ServerOpts & {
    routes?: unknown;
  };
  return plain(rest);
}

export interface Harness {
  calls: RecordedQuery[];
  counters: Counters;
}

/** One shape run: its outcome, the SQL it sent, and the per-tuple resolutions it made. */
export async function shape(h: Harness, run: () => unknown): Promise<Json> {
  const from = h.calls.length;
  h.counters.where = 0;
  h.counters.orderBy = 0;
  const result = await outcome(run);
  return {
    result,
    queries: h.calls.slice(from).map((c) => plain(c)),
    resolved: { where: h.counters.where, orderBy: h.counters.orderBy },
  };
}

/**
 * The reverse probes' inputs: the changed looked-up ids, and the `within` set
 * of host keys (a union's are `kind:raw`, so its record passes its own).
 */
export interface ProbeIds {
  within: readonly string[];
}
const DEFAULT_PROBE: ProbeIds = { within: ["h2", "h1"] };
/** The raw ids an encoded identity / alias map is called on. */
const ENCODE_PROBE = ["7", "a1", "x:y"] as const;

async function routesOf(
  h: Harness,
  opts: ServerOpts,
  probe: ProbeIds = DEFAULT_PROBE,
): Promise<Json> {
  const plan = opts.routes;
  if (plan === undefined) return "$none";
  const out: Json[] = [];
  for (const route of plan.routes) {
    const entry: Record<string, Json> = { route: plain(route) };
    // A union's identity / alias maps carry its arm's key encode (a single
    // compile's never do, so its record has no `encoded`): record what it
    // makes of a fixed raw-id list, not just that it is a function.
    if (
      (route.map.kind === "identity" || route.map.kind === "alias") &&
      route.map.encode !== undefined
    ) {
      const { encode } = route.map;
      entry.encoded = plain(ENCODE_PROBE.map((id) => encode(id)));
    }
    if (route.map.kind === "reverse") {
      const { resolve } = route.map;
      entry.resolve = [
        await shape(h, () => resolve(["x1", "x2"], null, 500)),
        await shape(h, () => resolve(["x1"], new Set(probe.within), 500)),
        await shape(h, () => resolve(["x1"], null, 1)),
        await shape(h, () => resolve([], null, 500)),
        await shape(h, () => resolve(["x1"], new Set(), 500)),
      ];
    }
    out.push(entry);
  }
  return out;
}

function usesOf(
  plan: {
    usesOf(params: never): ReadonlyMap<string, unknown>;
  },
  params: ResourceParams,
): Json {
  return plain([...plan.usesOf(params as never)]);
}

/** Every shape of a window resource, per tuple. */
export async function windowRecord(
  h: Harness,
  opts: ServerOpts,
  tuples: Record<string, ResourceParams>,
  affected: readonly string[] = ["r1", "r2"],
  probe: ProbeIds = DEFAULT_PROBE,
): Promise<Json> {
  const membership = opts.membership as {
    kind: string;
    windowIdsOf(p: ResourceParams): Promise<string[]>;
    orderSignatureOf(row: unknown, p: ResourceParams): string;
  };
  const perTuple: Record<string, Json> = {};
  for (const [name, params] of Object.entries(tuples)) {
    let fullRows: unknown[] = [];
    const full = await shape(h, async () => {
      fullRows = (await opts.loader(params as never)) as unknown[];
      return fullRows;
    });
    const scoped = await shape(h, () =>
      opts.loader(params as never, { affectedIds: affected }),
    );
    const ids = await shape(h, () => membership.windowIdsOf(params));
    const signatures = await shape(h, () =>
      fullRows.map((row) => membership.orderSignatureOf(row, params)),
    );
    // A second load of the same params object: memoized resolutions.
    const again = await shape(h, () => opts.loader(params as never));
    perTuple[name] = {
      params: plain(params),
      uses: await outcome(() => usesOf(opts.routes!, params)),
      full,
      scoped,
      ids,
      signatures,
      again,
    };
  }
  return {
    options: optionsOf(opts),
    membership: membership.kind,
    routes: await routesOf(h, opts, probe),
    tuples: perTuple,
  };
}

/** Every shape of a point resource, per id set. */
export async function pointRecord(
  h: Harness,
  opts: ServerOpts,
  tuples: Record<string, PointParams>,
  affected: readonly string[] = ["p9", "p8"],
  probe: ProbeIds = DEFAULT_PROBE,
): Promise<Json> {
  const membership = opts.membership as {
    kind: string;
    idsOf(p: PointParams): readonly string[];
  };
  const perTuple: Record<string, Json> = {};
  for (const [name, params] of Object.entries(tuples)) {
    perTuple[name] = {
      params: plain(params),
      uses: await outcome(() => usesOf(opts.routes!, params)),
      ids: await outcome(() => membership.idsOf(params)),
      full: await shape(h, () => opts.loader(params as never)),
      scoped: await shape(h, () =>
        opts.loader(params as never, { affectedIds: affected }),
      ),
      empty: await shape(h, () =>
        opts.loader(params as never, { affectedIds: [] }),
      ),
    };
  }
  return {
    options: optionsOf(opts),
    membership: membership.kind,
    routes: await routesOf(h, opts, probe),
    tuples: perTuple,
  };
}

/** A collection's `:groups`: its reach routes, and per grouping its uses and SQL. */
export async function groupsRecord(
  h: Harness,
  groups: {
    mode: string;
    loader(p: never): unknown;
    reach: {
      routes: readonly unknown[];
      usesOf(p: never): ReadonlyMap<string, unknown>;
    };
  },
  tuples: Record<string, ResourceParams>,
): Promise<Json> {
  const perTuple: Record<string, Json> = {};
  for (const [name, params] of Object.entries(tuples)) {
    perTuple[name] = {
      params: plain(params),
      uses: await outcome(() => usesOf(groups.reach, params)),
      load: await shape(h, () => groups.loader(params as never)),
    };
  }
  const { loader: _l, reach, ...rest } = groups;
  return {
    options: plain(rest),
    routes: plain(reach.routes),
    tuples: perTuple,
  };
}

function harness(sample: readonly Record<string, unknown>[]) {
  const recording = recordingQueryDb(scriptFor(sample));
  const counters: Counters = { where: 0, orderBy: 0 };
  return { db: recording.db, h: { calls: recording.calls, counters } };
}

// ── The schema ───────────────────────────────────────────────────────────────

const rows = pgTable("golden_rows", {
  id: text("id").primaryKey(),
  parentId: text("parent_id"),
  n: integer("n").notNull(),
  dismissed: integer("dismissed").notNull(),
});
const rowSchema = z.object({ id: z.string(), n: z.number() });
const ROW_SAMPLE = [
  { id: "r1", n: 1, parentId: "p", dismissed: 0 },
  { id: "r2", n: 2, parentId: null, dismissed: 0 },
];

const songs = pgTable("golden_songs", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  artistId: text("artist_id"),
  createdAt: integer("created_at").notNull(),
  secret: text("secret"),
});
const playback = pgTable("golden_songs_ext_playback", {
  parentId: text("parent_id").primaryKey(),
  lastPlayedAt: integer("last_played_at"),
  plays: integer("plays").notNull(),
  note: text("note"),
});
const artists = pgTable("golden_artists", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  labelId: text("label_id"),
});
const labels = pgTable("golden_labels", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});
const custom = pgTable(
  "golden_custom_values",
  {
    dataViewId: text("data_view_id").notNull(),
    rowKey: text("row_key").notNull(),
    columnId: text("column_id").notNull(),
    value: text("value"),
  },
  (t) => [primaryKey({ columns: [t.dataViewId, t.rowKey, t.columnId] })],
);
const playbackJoin: ExtensionJoin<"playback", typeof playback> = {
  kind: "extension",
  alias: "playback",
  table: playback,
  key: playback.parentId,
  parentKey: songs.id,
};
const artistJoin = (
  required: boolean,
): LookupJoin<"artist", typeof artists> => ({
  kind: "lookup",
  alias: "artist",
  table: artists,
  pk: artists.id,
  on: { from: "base", col: songs.artistId },
  required,
});
const labelJoin: LookupJoin<"label", typeof labels> = {
  kind: "lookup",
  alias: "label",
  table: labels,
  pk: labels.id,
  on: { from: "artist", col: artists.labelId },
  required: false,
};
const ccJoin: KeyedSideJoin<"cc", typeof custom> = {
  kind: "keyed-side",
  alias: "cc",
  table: custom,
  selectors: [
    { col: custom.dataViewId, value: "songs" },
    { col: custom.columnId, value: "c1" },
  ],
  hostKey: custom.rowKey,
};
const SongRow = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.number(),
  lastPlayedAt: z.number().nullable(),
  plays: z.number().nullable(),
  artistName: z.string().nullable(),
  labelName: z.string().nullable(),
  c1: z.string().nullable(),
});
const SONG_SAMPLE = [
  {
    id: "s1",
    title: "a",
    createdAt: 1,
    lastPlayedAt: 5,
    plays: 2,
    artistName: "x",
    labelName: "l",
    c1: "v",
  },
  {
    id: "s2",
    title: "b",
    createdAt: 2,
    lastPlayedAt: null,
    plays: null,
    artistName: null,
    labelName: null,
    c1: null,
  },
];

const tracks = pgTable("golden_tracks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  playedAt: timestamp("played_at", { withTimezone: true }),
  durationSec: integer("duration_sec").notNull(),
  owner: text("owner").notNull(),
});
const TrackRow = z.object({
  id: z.string(),
  title: z.string(),
  playedAt: z.date().nullable(),
  durationSec: z.number(),
  owner: z.string(),
});
const TRACK_SAMPLE = [
  {
    id: "t1",
    title: "a",
    playedAt: new Date("2026-09-30T10:00:00.000Z"),
    durationSec: 90,
    owner: "me",
  },
  { id: "t2", title: "b", playedAt: null, durationSec: 30, owner: "me" },
  { id: "t3", title: "c", playedAt: null, durationSec: 60, owner: "me" },
];

const scSongs = pgTable("golden_sc_songs", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  n: integer("n").notNull(),
});
const scValues = pgTable(
  "golden_sc_custom_values",
  {
    dataViewId: text("data_view_id").notNull(),
    rowKey: text("row_key").notNull(),
    columnId: text("column_id").notNull(),
    value: text("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.dataViewId, t.rowKey, t.columnId] })],
);

const playsSongs = pgTable("golden_plays_songs", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
});
const playsSongsRef = entityRef("golden_plays_songs", {});
// A defaulted count and a nullable instant, exposed to every list of songs.
const songPlayback = defineExtension(
  playsSongs,
  "playback",
  defineExtensionShape({
    key: "songId",
    fields: {
      playCount: intField({ label: "Plays", default: 0 }),
      lastPlayedAt: nullable(dateField({ label: "Last played" })),
    },
    exposes: {
      parent: playsSongsRef,
      name: "playback",
      fields: { playCount: {}, lastPlayedAt: {} },
    },
  }),
  { columns: { playCount: { default: 0 } } },
);

// ── The cases ────────────────────────────────────────────────────────────────

async function directWindowCases(): Promise<Record<string, Json>> {
  const out: Record<string, Json> = {};
  const win = (key: string, defaultLimit = 100) =>
    windowQueryResourceDescriptor(`golden.${key}`, rowSchema, "id", {
      defaultLimit,
    });
  type SortParams = { limit: string; order?: string };
  const sortDescriptor = (
    key: string,
  ): WindowQueryResourceContract<z.infer<typeof rowSchema>, SortParams> => {
    const base = win(key, 10);
    return { ...base, window: { ...base.window, maxLimit: 40 } };
  };
  // Every window projects its row key (the declared order keys, then the pk)
  // and takes page cuts; these direct specs read none, under one family.
  const rowKey: WindowQueryResourceSpec["rowKey"] = {
    cutsOf: () => ({}),
    familyOf: () => "golden",
    keyField: "$key",
    maxKeyBytes: 1024,
  };
  const run = async <P extends ResourceParams>(
    name: string,
    contract: Parameters<typeof compileWindowQuery>[0],
    spec: (
      db: ReturnType<typeof harness>["db"],
    ) => Omit<WindowQueryResourceSpec<P>, "rowKey">,
    tuples: Record<string, ResourceParams>,
  ) => {
    const { db, h } = harness(ROW_SAMPLE);
    const compiled = compileWindowQuery(
      contract as never,
      counted({ ...spec(db), rowKey }, h.counters) as never,
    );
    out[name] = {
      keyField: compiled.keyField,
      window: await windowRecord(h, compiled.serverOpts, tuples),
    };
  };

  await run(
    "static-order",
    win("static-order"),
    (db) => ({
      from: rows,
      select: { id: rows.id, n: rows.n },
      where: eq(rows.dismissed, 0),
      orderBy: { col: rows.n, dir: "desc" },
      window: { maxLimit: 500 },
      debounceMs: 25,
      db,
    }),
    { default: { limit: "100" }, clamped: { limit: "9999" } },
  );
  await run(
    "static-order-pk",
    win("static-order-pk", 10),
    (db) => ({
      from: rows,
      select: { id: rows.id, n: rows.n },
      orderBy: [{ col: rows.id, dir: "desc" }],
      window: { maxLimit: 50 },
      db,
    }),
    { default: { limit: "7" } },
  );
  await run(
    "static-order-signature",
    win("static-order-signature"),
    (db) => ({
      from: rows,
      select: { id: rows.id, n: rows.n, parentId: rows.parentId },
      orderBy: [
        { col: rows.parentId, nullable: true },
        { col: rows.n, dir: "desc" },
      ],
      signatureColumns: [rows.n, rows.parentId],
      window: { maxLimit: 500 },
      db,
    }),
    { default: { limit: "10" } },
  );
  await run(
    "function-order",
    sortDescriptor("function-order"),
    (db) => ({
      from: rows,
      select: { id: rows.id, n: rows.n, parentId: rows.parentId },
      orderBy: (p: SortParams) => [
        p.order === "parent"
          ? { col: rows.parentId, nullable: true }
          : { col: rows.n, dir: "desc" as const },
      ],
      signatureColumns: [rows.n, rows.parentId],
      where: (p: SortParams) =>
        p.order === "parent" ? eq(rows.dismissed, 1) : undefined,
      whereReads: [rows.dismissed],
      window: {},
      db,
    }),
    {
      byN: { limit: "10" },
      byParent: { limit: "20", order: "parent" },
      outsideCap: { limit: "41" },
    },
  );
  await run(
    "function-where-open",
    win("function-where-open"),
    (db) => ({
      from: rows,
      select: { id: rows.id, n: rows.n },
      where: (p: WindowParams) => gt(rows.n, Number(p.limit)),
      orderBy: { col: rows.n },
      window: { maxLimit: 500 },
      db,
    }),
    { default: { limit: "3" } },
  );
  await run(
    "select-all",
    win("select-all"),
    (db) => ({
      from: rows,
      where: eq(rows.dismissed, 0),
      orderBy: { col: rows.n, dir: "desc" },
      window: { maxLimit: 500 },
      db,
    }),
    { default: { limit: "5" } },
  );
  return out;
}

async function directPointCases(): Promise<Record<string, Json>> {
  const out: Record<string, Json> = {};
  const pt = (key: string) =>
    pointQueryResourceDescriptor(`golden.${key}`, rowSchema, "id");
  const run = async (
    name: string,
    spec: (
      db: ReturnType<typeof harness>["db"],
    ) => PointQueryResourceSpec<PointParams>,
  ) => {
    const { db, h } = harness(ROW_SAMPLE);
    const contract = pt(name);
    const compiled = compileWindowQuery(contract as never, spec(db) as never);
    out[name] = {
      keyField: compiled.keyField,
      point: await pointRecord(h, compiled.serverOpts, {
        two: contract.point.encode(["r2", "r1"]),
        none: contract.point.encode([]),
      }),
    };
  };
  await run("point-static-where", (db) => ({
    from: rows,
    select: { id: rows.id, n: rows.n },
    where: eq(rows.dismissed, 0),
    point: { by: rows.id },
    db,
  }));
  await run("point-select-all", (db) => ({
    from: rows,
    point: { by: rows.id },
    db,
  }));
  await run("point-non-pk", (db) => ({
    from: rows,
    select: { id: rows.parentId, n: rows.n },
    point: { by: rows.parentId },
    db,
  }));
  return out;
}

/** A collection's three compiled resources, every shape recorded. */
async function collectionRecord(
  h: Harness,
  c: {
    window: Parameters<typeof compileWindowQuery>[0];
    rows: Parameters<typeof compileWindowQuery>[0];
  },
  specs: ReturnType<typeof compileCollection>,
  tuples: {
    window: Record<string, ResourceParams>;
    point: Record<string, PointParams>;
    groups: Record<string, ResourceParams>;
  },
): Promise<Json> {
  const out: Record<string, Json> = {
    select: plain(Object.keys(specs.select)),
  };
  if ("window" in specs) {
    const full = specs as CollectionSpecs;
    const window = compileWindowQuery(
      c.window,
      counted(full.window, h.counters) as never,
    );
    out.window = await windowRecord(
      h,
      window.serverOpts as ServerOpts,
      tuples.window,
    );
    out.groups = await groupsRecord(h, full.groups as never, tuples.groups);
  }
  const point = compileWindowQuery(c.rows, specs.rows as never);
  out.keyField = point.keyField;
  out.point = await pointRecord(
    h,
    point.serverOpts as ServerOpts,
    tuples.point,
  );
  return out;
}

async function collectionCases(): Promise<Record<string, Json>> {
  const out: Record<string, Json> = {};

  // Extension, chained lookups, keyed side — optional and required.
  for (const required of [false, true]) {
    const name = required ? "joins-required" : "joins";
    const c = liveCollection(`golden.${name}`, {
      row: SongRow,
      id: "id",
      filterable: {
        title: liveText(),
        plays: liveNumber(),
        artistName: liveText(),
        labelName: liveText(),
        c1: liveText(),
      },
      sortable: [
        "createdAt",
        "title",
        "lastPlayedAt",
        "plays",
        "labelName",
        "c1",
      ],
      default: { orderBy: [["createdAt", "desc"]], limit: 10 },
      maxLimit: 50,
    });
    const { db, h } = harness(SONG_SAMPLE);
    const specs = compileCollection(c, {
      from: songs,
      joins: [playbackJoin, artistJoin(required), labelJoin, ccJoin],
      columns: {
        lastPlayedAt: (j) => j.playback.lastPlayedAt,
        plays: (j) => j.playback.plays,
        artistName: (j) => j.artist.name,
        labelName: (j) => j.label.name,
        c1: (j) => j.cc.value,
      },
      db,
    });
    const w = c.window.window;
    out[name] = await collectionRecord(h, c, specs, {
      window: {
        default: w.encode(),
        byLabel: w.encode({
          orderBy: [["labelName", "desc"]],
          where: { artistName: "x" },
        }),
        byC1: w.encode({
          orderBy: [["c1", "asc"]],
          where: { plays: { gt: 3 } },
          limit: 20,
        }),
        byPlays: w.encode({
          orderBy: [
            ["plays", "desc"],
            ["title", "asc"],
          ],
          where: { c1: { contains: "q" } },
        }),
      },
      point: { two: c.rows.point.encode(["s1", "s2"]) },
      groups: {
        title: c.groups.groups.encode({ groupBy: "title" }),
        labelName: c.groups.groups.encode({
          groupBy: "labelName",
          where: { plays: { gt: 1 } },
        }),
        c1: c.groups.groups.encode({ groupBy: "c1", limit: 5 }),
      },
    });
  }

  // A base `where` over a join, and a default scope a filter drops.
  {
    const c = liveCollection("golden.defaults", {
      row: SongRow,
      id: "id",
      filterable: {
        title: liveText(),
        artistName: liveText(),
        labelName: liveText(),
      },
      sortable: ["createdAt", "title", "labelName"],
      default: { orderBy: [["createdAt", "desc"]], limit: 10 },
      maxLimit: 50,
    });
    const { db, h } = harness(SONG_SAMPLE);
    const specs = compileCollection(c, {
      from: songs,
      joins: [playbackJoin, artistJoin(true), labelJoin],
      columns: {
        lastPlayedAt: (j) => j.playback.lastPlayedAt,
        plays: (j) => j.playback.plays,
        artistName: (j) => j.artist.name,
        labelName: (j) => j.label.name,
        c1: (j) => j.base.title,
      },
      where: (j) => gt(j.playback.plays, 0),
      defaults: [
        {
          unless: "artistName",
          where: (j) => sql`${j.artist.name} <> 'hidden'`,
        },
      ],
      db,
    });
    const w = c.window.window;
    out.defaults = await collectionRecord(h, c, specs, {
      window: {
        default: w.encode(),
        namesUnless: w.encode({ where: { artistName: { contains: "x" } } }),
        byLabel: w.encode({ orderBy: [["labelName", "asc"]] }),
      },
      point: { one: c.rows.point.encode(["s1"]) },
      groups: {
        title: c.groups.groups.encode({ groupBy: "title" }),
        artistName: c.groups.groups.encode({
          groupBy: "artistName",
          where: { artistName: "x" },
        }),
      },
    });
  }

  // Page cuts — NULL keys, a sortable-but-not-filterable key, a long key.
  {
    const c = liveCollection("golden.cuts", {
      row: TrackRow,
      id: "id",
      filterable: { title: liveText(), owner: liveText() },
      sortable: ["title", "playedAt", "durationSec"],
      default: { orderBy: [["playedAt", "desc"]], limit: 10 },
      maxLimit: 30,
    });
    const { db, h } = harness(TRACK_SAMPLE);
    const specs = compileCollection(c, {
      from: tracks,
      where: eq(tracks.owner, "me"),
      db,
    });
    const w = c.window.window;
    out.cuts = await collectionRecord(h, c, specs, {
      window: {
        default: w.encode(),
        cut: w.encode(
          { limit: 20 },
          {
            after: JSON.stringify(["2026-09-30 10:00:00.123456+00", "t1"]),
            until: JSON.stringify(["2026-09-29 08:00:00.5+00", "t9"]),
          },
        ),
        nullAfter: w.encode(undefined, {
          after: JSON.stringify([null, "t4"]),
        }),
        nullUntil: w.encode(
          { orderBy: [["playedAt", "asc"]] },
          { until: JSON.stringify([null, "t7"]) },
        ),
        byDuration: w.encode(
          { orderBy: [["durationSec", "asc"]], where: { title: "x" } },
          { after: JSON.stringify(["90", "t2"]) },
        ),
        byTitle: w.encode({ orderBy: [["title", "asc"]] }),
      },
      point: { one: c.rows.point.encode(["t1"]) },
      groups: { owner: c.groups.groups.encode({ groupBy: "owner" }) },
    });
  }

  // A `columnScope` family: members joined per tuple, cast, ordered and folded.
  {
    const RECOMPUTE = { resource: { key: "golden.defs" } as never, params: {} };
    const members = new Map<string, ScopedMemberRead>([
      ["c1", { domain: "text" }],
      [
        "cc-2",
        {
          domain: "number",
          cast: { sql: (raw) => sql`(${raw})::numeric`, sqlType: "numeric" },
        },
      ],
    ]);
    const set = serveScopedColumns({
      name: "custom",
      table: scValues,
      scope: scValues.dataViewId,
      hostKey: scValues.rowKey,
      member: scValues.columnId,
      value: scValues.value,
      members: () => members,
      recomputeOn: () => RECOMPUTE,
    });
    const SCOPE = "golden.surface";
    const c = liveCollection("golden.scoped", {
      row: z.object({ id: z.string(), title: z.string(), n: z.number() }),
      id: "id",
      filterable: { title: liveText(), n: liveNumber() },
      sortable: ["title", "n"],
      default: { orderBy: [["n", "asc"]], limit: 10 },
      maxLimit: 50,
      columnScope: SCOPE,
    });
    const { db, h } = harness([
      { id: "a", title: "A", n: 1 },
      { id: "b", title: "B", n: 2 },
    ]);
    const specs = compileCollection(c, { from: scSongs, db }, [set]);
    const handle: LiveColumnsDeclaration = scopedLiveColumns(SCOPE, "custom", {
      c1: { domain: "text", sortable: true },
      "cc-2": { domain: "number", sortable: true },
    });
    const encode = (q: object, cuts?: object) =>
      c.window.window.encode(
        { ...q, columns: [handle] } as never,
        cuts as never,
      );
    out.scoped = await collectionRecord(h, c, specs, {
      window: {
        default: encode({}),
        byMember: encode({ orderBy: [["custom.c1", "desc"]] }),
        castMember: encode({
          orderBy: [["custom.cc-2", "asc"]],
          where: { "custom.c1": "x" },
        }),
        castCut: encode(
          { orderBy: [["custom.cc-2", "asc"]] },
          { after: JSON.stringify(["2.5", "a"]) },
        ),
        filterCast: encode({ where: { "custom.cc-2": { gt: 3 } } }),
      },
      point: { one: c.rows.point.encode(["a"]) },
      groups: { title: c.groups.groups.encode({ groupBy: "title" }) },
    });
  }

  // An exposure sorted, filtered and cut by: a defaulted column (COALESCEd)
  // and a nullable one, folded into `$columns`.
  {
    const c = liveCollection("golden.exposed-sort", {
      row: z.object({ id: z.string(), title: z.string() }),
      id: "id",
      filterable: { title: liveText() },
      sortable: ["title"],
      default: { orderBy: [["title", "asc"]], limit: 10 },
      maxLimit: 30,
      exposes: { base: playsSongsRef },
    });
    const stats = exposedColumns(songPlayback.exposure);
    const PLAYS = stats.wireName("playCount");
    const LAST = stats.wireName("lastPlayedAt");
    const { db, h } = harness([
      {
        id: "s1",
        title: "a",
        [PLAYS]: 3,
        [LAST]: new Date("2026-09-30T10:00:00.000Z"),
      },
      { id: "s2", title: "b", [PLAYS]: 0, [LAST]: null },
    ]);
    const specs = compileCollection(
      c,
      { from: playsSongs, db },
      [],
      [songPlayback],
    );
    const encode = (q: object, cuts?: object) =>
      c.window.window.encode(
        { ...q, columns: [stats] } as never,
        cuts as never,
      );
    out.exposedSort = await collectionRecord(h, c, specs, {
      window: {
        default: encode({}),
        byPlays: encode({
          orderBy: [[PLAYS, "desc"]],
          where: { [PLAYS]: { gt: 3 } },
        }),
        byPlayedCut: encode(
          { orderBy: [[LAST, "desc"]] },
          { after: JSON.stringify([null, "s2"]) },
        ),
      },
      point: { two: c.rows.point.encode(["s1", "s2"]) },
      groups: { title: c.groups.groups.encode({ groupBy: "title" }) },
    });
  }

  // Lookup-only: the `:rows` point read alone.
  {
    const c = liveCollection("golden.lookup-only", {
      row: z.object({ id: z.string(), n: z.number() }),
      id: "id",
    });
    const { db, h } = harness(ROW_SAMPLE);
    const specs = compileCollection(c, {
      from: rows,
      where: eq(rows.dismissed, 0),
      db,
    });
    out["lookup-only"] = await collectionRecord(h, c as never, specs, {
      window: {},
      point: {
        two: c.rows.point.encode(["r1", "r2"]),
        none: c.rows.point.encode([]),
      },
      groups: {},
    });
  }

  return out;
}

// ── The `all` group (P8 v3 step 16b.5) ───────────────────────────────────────
//
// `compileAllCollection` over two declarations — a flat one (a static `where`,
// a two-key order) and a tree-shaped one (a required lookup, a top-level
// rollup, a children join with a nested rollup and a `jsonAgg`, a second
// children join, and a closure whose ancestors carry a rollup and a children
// join) — recorded shape by shape: full, scoped, orderIds, `:rows`, every
// route (each reverse probe's SQL), the uses, the order signature and the
// definition (A18: a byte of SQL moving moves it).

const allTasks = pgTable("golden_all_tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  ownerId: text("owner_id").notNull(),
  heldAt: timestamp("held_at", { withTimezone: true }),
  droppedAt: timestamp("dropped_at", { withTimezone: true }),
  rank: integer("rank").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
const allOwners = pgTable("golden_all_owners", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});
const allAttempts = pgTable(
  "golden_all_attempts",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("golden_all_attempts_task_idx").on(t.taskId)],
);
const allDeps = pgTable(
  "golden_all_deps",
  {
    taskId: text("task_id").notNull(),
    dependsOn: text("depends_on").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.dependsOn] }),
    index("golden_all_deps_depends_on_idx").on(t.dependsOn),
  ],
);
const allConvs = pgTable(
  "golden_all_convs",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id").notNull(),
    status: text("status").notNull(),
  },
  (t) => [index("golden_all_convs_attempt_idx").on(t.attemptId)],
);
const allPushes = pgTable("golden_all_pushes", {
  id: text("id").primaryKey(),
  attemptId: text("attempt_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
const allConvAggT = pgTable(ATTEMPT_CONV_AGG_TABLE, {
  attemptId: text("attempt_id").primaryKey(),
  hasLive: boolean("has_live"),
});
const allConvAgg = defineRollup({
  table: allConvAggT,
  key: allConvAggT.attemptId,
  select: (scope) =>
    `SELECT c.attempt_id, bool_or(c.status <> 'done') AS has_live FROM golden_all_convs c WHERE ${scope("c.attempt_id")} GROUP BY c.attempt_id`,
  sources: [
    { table: allConvs, carry: allConvs.attemptId, reads: [allConvs.status] },
  ],
});
// A rollup keyed by TASK, through the attempts hop (A35: attempts is a source
// of its own carrying the task id).
const allTaskPushT = pgTable(TASK_LATEST_CONVERSATION_TABLE, {
  taskId: text("task_id").primaryKey(),
  firstPushAt: timestamp("first_push_at", { withTimezone: true }),
});
const allTaskPush = defineRollup({
  table: allTaskPushT,
  key: allTaskPushT.taskId,
  select: (scope) =>
    `SELECT a.task_id, min(p.created_at) AS first_push_at FROM golden_all_pushes p JOIN golden_all_attempts a ON a.id = p.attempt_id WHERE ${scope("a.task_id")} GROUP BY a.task_id`,
  sources: [
    {
      table: allPushes,
      carry: allPushes.attemptId,
      via: {
        table: allAttempts,
        match: allAttempts.id,
        key: allAttempts.taskId,
      },
      reads: [allPushes.createdAt],
    },
    {
      table: allAttempts,
      carry: allAttempts.taskId,
      reads: [],
      ops: ["update", "delete"],
    },
  ],
});

const AllFlatRow = z.object({
  id: z.string(),
  title: z.string(),
  rank: z.number(),
  createdAt: z.date(),
});
const AllTreeRow = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.date(),
  ownerName: z.string(),
  firstPushAt: z.date().nullable(),
  done: z.boolean(),
  live: z.boolean().nullable(),
  attempts: z.array(z.unknown()),
  dependencies: z.array(z.string()),
  blocked: z.boolean(),
  status: z.string(),
});

/** The recording script of the `all` shapes: rows of exactly the projection each runs. */
function allScript(sample: Record<string, unknown>) {
  return (q: RecordedQuery): unknown[] => {
    if (q.sql.startsWith("select distinct"))
      return [{ id: "h1" }, { id: "h2" }];
    if (q.sql.startsWith("SELECT DISTINCT"))
      return [{ __h: "h1" }, { __h: "h2" }];
    if (q.sql.startsWith("WITH RECURSIVE __d_"))
      return [{ __n: "d1" }, { __n: "d2" }];
    if (/^SELECT \S+ AS __id /.test(q.sql))
      return [{ __id: "r2" }, { __id: "r1" }];
    return [sample, { ...sample, id: "r2" }];
  };
}

async function allRecord(
  compileIt: (
    db: ReturnType<typeof recordingQueryDb>["db"],
  ) => ReturnType<typeof compileAllCollection>,
  sample: Record<string, unknown>,
): Promise<Json> {
  const recording = recordingQueryDb(allScript(sample));
  const h: Harness = {
    calls: recording.calls,
    counters: { where: 0, orderBy: 0 },
  };
  const compiled = compileIt(recording.db);
  const all = compiled.all as unknown as ServerOpts & {
    scopedMembership: {
      orderOf(p: ResourceParams): Promise<string[]>;
      orderSignatureOf(row: unknown, p: ResourceParams): string;
    };
  };
  let fullRows: unknown[] = [];
  const full = await shape(h, async () => {
    fullRows = (await all.loader({} as never)) as unknown[];
    return fullRows;
  });
  return {
    keyField: compiled.keyField,
    definition: compiled.definition,
    options: optionsOf(all),
    routes: await routesOf(h, all),
    uses: await outcome(() => usesOf(all.routes!, {})),
    full,
    scoped: await shape(h, () =>
      all.loader({} as never, { affectedIds: ["r1", "r2"] }),
    ),
    orderIds: await shape(h, () => all.scopedMembership.orderOf({})),
    signatures: await shape(h, () =>
      fullRows.map((row) => all.scopedMembership.orderSignatureOf(row, {})),
    ),
    rows: await pointRecord(h, compiled.rows as unknown as ServerOpts, {
      one: { ids: "r1" },
      two: { ids: "r1,r2" },
    }),
  };
}

async function allCases(): Promise<Record<string, Json>> {
  const flat = liveCollection("golden.all-flat", {
    row: AllFlatRow,
    id: "id",
    all: {
      orderBy: [
        ["rank", "asc"],
        ["createdAt", "desc"],
      ],
      unbounded: { reason: "a golden fixture" },
    },
  });
  const tree = liveCollection("golden.all-tree", {
    row: AllTreeRow,
    id: "id",
    all: {
      orderBy: [["createdAt", "asc"]],
      unbounded: { reason: "a golden fixture" },
    },
    preload: "boot",
  });
  const owner: LookupJoin<"owner", typeof allOwners> = {
    kind: "lookup",
    alias: "owner",
    table: allOwners,
    pk: allOwners.id,
    on: { from: BASE_RELATION, col: allTasks.ownerId },
    required: true,
  };
  const convRollup = {
    kind: "rollup",
    alias: "conv",
    rollup: allConvAgg,
    on: allAttempts.id,
  } as const;
  const att = childrenJoin({
    alias: "att",
    table: allAttempts,
    fk: allAttempts.taskId,
    rollups: [convRollup],
    where: (c) => sql`${c.att.status} <> 'system'`,
    aggregates: (c) => ({
      done: aggregate(sql`bool_or(${c.att.status} = 'completed')`, {
        decoder: Boolean,
        sqlType: "boolean",
        notNull: true,
        ifNone: sql`false`,
      }),
      live: aggregate(sql`bool_or(${c.conv.hasLive})`, {
        decoder: Boolean,
        sqlType: "boolean",
      }),
      list: jsonAgg(
        {
          id: c.att.id,
          status: c.att.status,
          createdAt: c.att.createdAt,
          live: c.conv.hasLive,
        },
        { orderBy: [[c.att.createdAt, "desc"]] },
      ),
    }),
  });
  const deps = childrenJoin({
    alias: "deps",
    table: allDeps,
    fk: allDeps.taskId,
    aggregates: (c) => ({
      ids: aggregate(
        sql`array_agg(${c.deps.dependsOn} ORDER BY ${c.deps.createdAt})`,
        {
          decoder: parsed(z.array(z.string()), "golden.deps.ids"),
          sqlType: "text[]",
          notNull: true,
          ifNone: sql`ARRAY[]::text[]`,
        },
      ),
    }),
  });
  const ancAtt = childrenJoin({
    alias: "att",
    table: allAttempts,
    fk: allAttempts.taskId,
    rollups: [convRollup],
    aggregates: (c) => ({
      done: aggregate(
        sql`bool_or(${c.att.status} = 'completed' AND NOT COALESCE(${c.conv.hasLive}, false))`,
        {
          decoder: Boolean,
          sqlType: "boolean",
          notNull: true,
          ifNone: sql`false`,
        },
      ),
    }),
  });
  const blocking = closureJoin({
    alias: "blocking",
    edges: allDeps,
    child: allDeps.taskId,
    parent: allDeps.dependsOn,
    nodes: allTasks,
    ancestorJoins: [
      { kind: "rollup", alias: "push", rollup: allTaskPush, on: allTasks.id },
      ancAtt,
    ],
    aggregates: (c) => ({
      blocked: aggregate(
        sql`bool_or(${c.anc.droppedAt} IS NULL AND ${c.push.firstPushAt} IS NULL AND NOT ${c.att.done})`,
        {
          decoder: Boolean,
          sqlType: "boolean",
          notNull: true,
          ifNone: sql`false`,
        },
      ),
    }),
  });
  const createdAt = "2026-10-06 10:00:00+00";
  return {
    flat: await allRecord(
      (db) =>
        compileAllCollection(
          { all: flat.all, rows: flat.rows },
          {
            from: allTasks,
            select: ({ j, render }) => ({
              id: render(j.base.id),
              title: render(j.base.title),
              rank: render(j.base.rank),
              createdAt: render(j.base.createdAt),
            }),
            where: sql`${allTasks.droppedAt} IS NULL AND ${allTasks.rank} > ${0}`,
            debounceMs: 250,
            db,
          },
        ),
      { id: "r1", title: "T", rank: 1, createdAt },
    ),
    tree: await allRecord(
      (db) =>
        compileAllCollection(
          { all: tree.all, rows: tree.rows },
          {
            from: allTasks,
            joins: [
              owner,
              {
                kind: "rollup",
                alias: "first",
                rollup: allTaskPush,
                on: { from: BASE_RELATION, col: allTasks.id },
              },
              att,
              deps,
              blocking,
            ],
            select: ({ j, render, aggregate: agg, expr: ex }) => ({
              id: render(j.base.id),
              title: render(j.base.title),
              createdAt: render(j.base.createdAt),
              ownerName: render(j.owner.name),
              firstPushAt: render(j.first.firstPushAt),
              done: agg(j.att.done),
              live: agg(j.att.live),
              attempts: agg(j.att.list),
              dependencies: agg(j.deps.ids),
              blocked: agg(j.blocking.blocked),
              status: ex(
                expr(
                  sql`CASE WHEN ${j.base.heldAt} IS NOT NULL THEN 'held' WHEN ${j.att.done} THEN 'done' WHEN ${j.blocking.blocked} THEN 'blocked' ELSE 'new' END`,
                  { decoder: String, sqlType: "text", notNull: true },
                ),
                "status",
              ),
            }),
            wire: {
              encodeRow: (row) => row,
              ids: { title: "golden:identity" },
            },
            db,
          },
        ),
      {
        id: "r1",
        title: "T",
        createdAt,
        ownerName: "o",
        firstPushAt: null,
        done: false,
        live: null,
        attempts: [],
        dependencies: [],
        blocked: false,
        status: "new",
      },
    ),
  };
}

// ── The `exposed` group (fields declared once, phase 1) ──────────────────────
//
// Collections declaring `exposes` fold every served exposure of the entities
// they reach: a base exposure (`golden_xp_convs_ext_usage`, joined on the
// host's id — an alias route, COALESCE to its `absent` 0) and a related one
// (`golden_xp_tasks_ext_track`, joined on the `attempt` lookup's `on` — a
// reverse route probed through that chain, COALESCE to its `absent` "main",
// bound plain and decoded through its widened schema). Recorded for a window
// (a filter and a sort on the exposed columns, a grouping on each — the
// grouped COALESCE named by ordinal, so its bound `absent` is rendered once)
// and for an `all` set, with and without the exposure (its definition moves).

const xpTasks = pgTable("golden_xp_tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
});
const xpAttempts = pgTable("golden_xp_attempts", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
});
const xpConvs = pgTable("golden_xp_convs", {
  id: text("id").primaryKey(),
  attemptId: text("attempt_id").notNull(),
  title: text("title").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
const xpTasksRef = entityRef("golden_xp_tasks", {});
const xpConvsRef = entityRef("golden_xp_convs", {});
// A declared default (`main`): a missing row reads it, COALESCEd.
const xpTrack = defineExtension(
  xpTasks,
  "track",
  defineExtensionShape({
    key: "taskId",
    fields: {
      track: enumTextField(["main", "sidequest"] as const, {
        label: "Track",
        default: "main",
      }),
    },
    exposes: { parent: xpTasksRef, name: "track", fields: { track: {} } },
  }),
  { columns: { track: { default: "main" } } },
);
// `cost` declares 0; `plays` declares nothing (a missing row reads NULL, no
// COALESCE) and is listed as `playCount` (`as`).
const xpUsage = defineExtension(
  xpConvs,
  "usage",
  defineExtensionShape({
    key: "conversationId",
    fields: {
      cost: intField({ label: "Cost", default: 0 }),
      plays: intField({ label: "Plays" }),
    },
    exposes: {
      parent: xpConvsRef,
      name: "usage",
      fields: { cost: {}, plays: { as: "playCount" } },
    },
  }),
  { columns: { cost: { default: 0 } } },
);
// Presence: a boolean on the related task, two literals on the base.
const xpStarred = defineExtension(
  xpTasks,
  "starred",
  defineExtensionShape({
    key: "taskId",
    fields: {},
    exposes: {
      parent: xpTasksRef,
      name: "starred",
      presence: { id: "starred", label: "Starred" },
    },
  }),
);
const xpOrigin = defineExtension(
  xpConvs,
  "origin",
  defineExtensionShape({
    key: "conversationId",
    fields: {},
    exposes: {
      parent: xpConvsRef,
      name: "origin",
      presence: {
        id: "origin",
        label: "Origin",
        values: { present: "agent", absent: "user" },
      },
    },
  }),
);
const xpOwnerJoins = [
  {
    kind: "lookup",
    alias: "attempt",
    table: xpAttempts,
    pk: xpAttempts.id,
    on: { from: "base", col: xpConvs.attemptId },
    required: true,
  } satisfies LookupJoin<"attempt", typeof xpAttempts>,
  {
    kind: "lookup",
    alias: "task",
    table: xpTasks,
    pk: xpTasks.id,
    on: { from: "attempt", col: xpAttempts.taskId },
    required: true,
  } satisfies LookupJoin<"task", typeof xpTasks>,
] as const;
const XpRow = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.date(),
});

async function exposedCases(): Promise<Record<string, Json>> {
  const out: Record<string, Json> = {};
  const TRACK = "golden_xp_tasks_ext_track.track";
  const COST = "golden_xp_convs_ext_usage.cost";
  const PLAYS = "golden_xp_convs_ext_usage.plays";
  const STARRED = "golden_xp_tasks_ext_starred.starred";
  const ORIGIN = "golden_xp_convs_ext_origin.origin";
  const served = [xpTrack, xpUsage, xpStarred, xpOrigin];
  const columns = [
    exposedColumns(xpTrack.exposure),
    exposedColumns(xpUsage.exposure),
    exposedColumns(xpStarred.exposure),
    exposedColumns(xpOrigin.exposure),
  ];

  {
    const c = liveCollection("golden.exposed-window", {
      row: XpRow,
      id: "id",
      filterable: { title: liveText() },
      sortable: ["createdAt"],
      default: { orderBy: [["createdAt", "desc"]], limit: 10 },
      maxLimit: 30,
      exposes: { base: xpConvsRef, task: xpTasksRef },
    });
    const createdAt = new Date("2026-10-12T10:00:00.000Z");
    const { db, h } = harness([
      {
        id: "c1",
        title: "a",
        createdAt,
        [TRACK]: "main",
        [COST]: 0,
        [PLAYS]: null,
        [STARRED]: false,
        [ORIGIN]: "user",
      },
      {
        id: "c2",
        title: "b",
        createdAt,
        [TRACK]: "sidequest",
        [COST]: 7,
        [PLAYS]: 3,
        [STARRED]: true,
        [ORIGIN]: "agent",
      },
    ]);
    const specs = compileCollection(
      c,
      { from: xpConvs, joins: xpOwnerJoins, db },
      [],
      served,
    );
    const encode = (q: object) =>
      c.window.window.encode({ ...q, columns } as never);
    out.window = await collectionRecord(h, c, specs, {
      window: {
        default: encode({}),
        sidequests: encode({ where: { [TRACK]: "sidequest" } }),
        mainByCost: encode({
          where: { [TRACK]: "main" },
          orderBy: [[COST, "desc"]],
        }),
        neverPlayed: encode({ where: { [PLAYS]: { isEmpty: true } } }),
        starred: encode({ where: { [STARRED]: true } }),
        byAgents: encode({ where: { [ORIGIN]: "agent" } }),
      },
      point: { two: c.rows.point.encode(["c1", "c2"]) },
      groups: {
        track: c.groups.groups.encode({
          groupBy: TRACK as never,
          columns,
        }),
        cost: c.groups.groups.encode({
          groupBy: COST as never,
          columns,
        }),
        trackOfCostly: c.groups.groups.encode({
          groupBy: TRACK as never,
          where: { [COST]: { gt: 0 } } as never,
          columns,
        }),
        starred: c.groups.groups.encode({
          groupBy: STARRED as never,
          columns,
        }),
        origin: c.groups.groups.encode({
          groupBy: ORIGIN as never,
          columns,
        }),
      },
    });
  }

  {
    const all = liveCollection("golden.exposed-all", {
      row: XpRow,
      id: "id",
      all: {
        orderBy: [["createdAt", "desc"]],
        unbounded: { reason: "a golden fixture" },
      },
      exposes: { task: xpTasksRef },
    });
    const sample = {
      id: "r1",
      title: "T",
      createdAt: "2026-10-12T10:00:00.000Z",
    };
    out.all = await allRecord(
      (db) =>
        compileCollection(
          all,
          { from: xpConvs, joins: xpOwnerJoins, db },
          [],
          served,
        ),
      { ...sample, [TRACK]: "sidequest", [STARRED]: true },
    );
    // No exposure served: the rows still carry `$columns`, and the
    // definition differs from the folded one.
    out.allUnfolded = await allRecord(
      (db) =>
        compileCollection(all, { from: xpConvs, joins: xpOwnerJoins, db }),
      sample,
    );
  }
  return out;
}

/**
 * The whole golden record, deterministic for one source tree: every case
 * builds its own declarations (unique keys) and recording db, in a fixed order.
 */
export async function recordCompileGolden(): Promise<Json> {
  return {
    window: await directWindowCases(),
    point: await directPointCases(),
    collections: await collectionCases(),
    all: await allCases(),
    exposed: await exposedCases(),
  };
}
