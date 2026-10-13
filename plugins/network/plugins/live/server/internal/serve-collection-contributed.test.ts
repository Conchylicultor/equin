/**
 * A `contributed: true` collection — columns other plugins own, declared as
 * handles (`liveColumns`, core) and served by their own plugin
 * (`serveColumns` in a `LiveColumns.Serve` contribution) — without a database:
 * the recording `QueryDb` renders every statement.
 *
 * - the codec validates a query against the handles it names, never a registry;
 * - each contributed column is projected flat under its wire name, wire-encoded
 *   like any column, and folded into `$columns`; `:rows` carries it too;
 * - its join routes like any extension: `value` for a tuple that only projects
 *   it, `membership` for one that sorts or filters by it;
 * - a defaulted extension column reads its default (COALESCE), so a host with
 *   no side row sorts and filters as the extension defines it;
 * - boot: the deferred compile, and what it refuses.
 *
 * Run: `./singularity test plugins/network/plugins/live`.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { pgTable, text } from "drizzle-orm/pg-core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import type { ResourceParams } from "@plugins/framework/plugins/resource-runtime/core";
import { ResourceContractError } from "@plugins/packages/plugins/resource-protocol/core";
import {
  compileWindowQuery,
  recordingQueryDb,
} from "@plugins/infra/plugins/query-resource/server/testing";
import {
  liveCollection,
  liveColumns,
  LIVE_COLUMNS_KEY,
} from "@plugins/network/plugins/live/core";
import {
  liveNumber,
  liveText,
} from "@plugins/network/plugins/live/plugins/filter/core";
import { compileCollection } from "./serve-collection";
import { serveColumns } from "./serve-columns";

const songs = pgTable("contrib_songs", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
});
const playbackShape = defineExtensionShape({
  key: "songId",
  fields: { playCount: intField(), lastPlayedAt: dateField() },
});
const playback = defineExtension(songs, "playback", playbackShape, {
  columns: { playCount: { default: 0 } },
});

const Song = z.object({ id: z.string(), title: z.string() });

let n = 0;
function library() {
  return liveCollection(`test.live.contributed-${n++}`, {
    row: Song,
    id: "id",
    filterable: { title: liveText() },
    sortable: ["title"],
    default: { orderBy: [["title", "asc"]], limit: 10 },
    maxLimit: 30,
    contributed: true,
  });
}

function handleOn(c: ReturnType<typeof library>) {
  return liveColumns(c, "playback", {
    row: z.object({
      playCount: z.number(),
      lastPlayedAt: z.coerce.date().nullable(),
    }),
    filterable: { playCount: liveNumber() },
    sortable: ["playCount", "lastPlayedAt"],
  });
}

function compile(script?: (q: { sql: string }) => unknown[]) {
  const c = library();
  const handle = handleOn(c);
  const recording = recordingQueryDb(script);
  const specs = compileCollection(c, { from: songs, db: recording.db }, [
    serveColumns(handle, { join: playback.join("playback") }),
  ]);
  return {
    c,
    handle,
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

describe("contributed columns — the codec", () => {
  test("a query names a contributed column only with the handle that declares it", () => {
    const c = library();
    const handle = handleOn(c);
    const codec = c.window.window;
    expect(() =>
      codec.encode({ orderBy: [["playback.playCount" as "title", "desc"]] }),
    ).toThrow(/not a sortable column/);
    const params = codec.encode({
      orderBy: [["playback.playCount" as "title", "desc"]],
      where: { "playback.playCount": { gt: 3 } } as never,
      columns: [handle],
    });
    expect(params).toEqual({
      limit: "10",
      order: '[["playback.playCount","desc"]]',
      where: '{"column":"playback.playCount","op":"gt","operand":3}',
    });
    // The server decodes against the handles it serves — and only those.
    expect(() => codec.decode(params)).toThrow();
    expect(codec.decode(params, [handle]).orderBy as unknown).toEqual([
      ["playback.playCount", "desc"],
    ]);
    // Another collection's handle is not this one's.
    const other = handleOn(library());
    expect(() => codec.encode({ columns: [other] } as never)).toThrow(
      /belong to "test.live.contributed-\d+"/,
    );
  });

  test("a handle is declared only on a contributed collection, and its fields are its row's", () => {
    const plain = liveCollection("test.live.contributed-plain", {
      row: Song,
      id: "id",
      filterable: {},
      sortable: ["title"],
      default: { orderBy: [["title", "asc"]], limit: 10 },
      maxLimit: 30,
    });
    expect(() =>
      liveColumns(plain as never, "x", {
        row: z.object({ a: z.number() }),
        filterable: {},
        sortable: [],
      }),
    ).toThrow(/not declared `contributed: true`/);
    expect(() =>
      liveColumns(library(), "x", {
        row: z.object({ a: z.number() }),
        filterable: {},
        sortable: ["b" as "a"],
      }),
    ).toThrow(/"b" is not a field of its row schema/);
  });

  test("a row's slice is read — and parsed — through its handle", () => {
    const handle = handleOn(library());
    const row = {
      id: "s1",
      title: "t",
      [LIVE_COLUMNS_KEY]: {
        playback: { playCount: 4, lastPlayedAt: "2026-09-30T10:00:00.000Z" },
      },
    };
    expect(handle.read(row)).toEqual({
      playCount: 4,
      lastPlayedAt: new Date("2026-09-30T10:00:00.000Z"),
    });
    expect(handle.read(row)).toBe(handle.read(row));
  });
});

describe("contributed columns — the compile", () => {
  test("the params gate decodes against the served handles: the descriptor's own would refuse their columns", () => {
    const { c, handle, window } = compile();
    const params = c.window.window.encode({
      orderBy: [["playback.playCount" as "title", "desc"]],
      columns: [handle],
    });
    expect(() => c.window.validateParams(params)).toThrow(
      ResourceContractError,
    );
    expect(() => window.validateParams!(params)).not.toThrow();
    // A column no served handle declares is still a contract mismatch.
    expect(() =>
      window.validateParams!({
        ...params,
        order: '[["other.playCount","desc"]]',
      }),
    ).toThrow(ResourceContractError);
  });

  test("each column is projected flat under its wire name, and folded into $columns", async () => {
    const played = new Date("2026-09-30T10:00:00.000Z");
    const { c, window, rows, calls } = compile(() => [
      {
        id: "s1",
        title: "t",
        "playback.playCount": 4,
        "playback.lastPlayedAt": played,
        __row_key_0: "t",
        __row_key_1: "s1",
      },
    ]);
    const [row] = (await window.loader(c.window.window.encode())) as Record<
      string,
      unknown
    >[];
    expect(calls[0]!.sql).toStartWith(
      'select "contrib_songs"."id", "contrib_songs"."title", ' +
        'COALESCE("playback"."play_count", $1), "playback"."last_played_at"',
    );
    expect(row).toEqual({
      id: "s1",
      title: "t",
      $key: '["t","s1"]',
      [LIVE_COLUMNS_KEY]: {
        playback: { playCount: 4, lastPlayedAt: played },
      },
    });
    // The point sibling projects them too: one row shape per collection.
    const [point] = (await rows.loader(c.rows.point.encode(["s1"]))) as Record<
      string,
      unknown
    >[];
    expect(point![LIVE_COLUMNS_KEY]).toEqual({
      playback: { playCount: 4, lastPlayedAt: played },
    });
  });

  test("a defaulted column sorts and filters as its default: a song never played has playCount 0", async () => {
    const { c, handle, window, calls } = compile();
    await window.loader(
      c.window.window.encode({
        orderBy: [["playback.playCount" as "title", "desc"]],
        where: { "playback.playCount": 0 } as never,
        columns: [handle],
      }),
    );
    expect(calls[0]!.sql).toMatch(
      /where .*COALESCE\("playback"\."play_count", \$\d+\)/,
    );
    expect(calls[0]!.sql).toMatch(
      /order by COALESCE\("playback"\."play_count", \$\d+\) DESC NULLS LAST/,
    );
    // Non-nullable: the order key takes no NULL branch.
    expect(calls[0]!.sql).toContain(") DESC NULLS LAST");
  });

  test("its join is value for a tuple that only projects it, membership for one ordering or filtering by it", () => {
    const { c, handle, window } = compile();
    const codec = c.window.window;
    expect(roles(window.routes!, codec.encode())).toEqual({
      base: "membership",
      playback: "value",
    });
    expect(
      roles(
        window.routes!,
        codec.encode({
          orderBy: [["playback.lastPlayedAt" as "title", "desc"]],
          columns: [handle],
        }),
      ),
    ).toEqual({ base: "membership", playback: "membership" });
    const route = window.routes!.routes.find((r) => r.id === "playback")!;
    expect(route.map).toEqual({ kind: "alias" });
  });

  test("the order signature reads a sorted contributed column off $columns", async () => {
    const { c, handle, window } = compile();
    const params = c.window.window.encode({
      orderBy: [["playback.playCount" as "title", "desc"]],
      columns: [handle],
    });
    const sig = (
      window.membership as {
        orderSignatureOf(row: unknown, p: unknown): string;
      }
    ).orderSignatureOf;
    const row = (count: number) => ({
      id: "s1",
      title: "t",
      [LIVE_COLUMNS_KEY]: {
        playback: { playCount: count, lastPlayedAt: null },
      },
    });
    expect(sig(row(1), params)).not.toBe(sig(row(2), params));
    expect(sig(row(1), params)).toBe(sig(row(1), params));
  });

  test("two contributions of one name, or one for another collection, are refused", () => {
    const c = library();
    const handle = handleOn(c);
    const served = serveColumns(handle, { join: playback.join("playback") });
    expect(() =>
      compileCollection(c, { from: songs }, [
        served,
        serveColumns(handle, { join: playback.join("playback2") }),
      ]),
    ).toThrow(/two LiveColumns.Serve contributions are named "playback"/);
    expect(() =>
      compileCollection(library(), { from: songs }, [served]),
    ).toThrow(/belong to "test.live.contributed-\d+"/);
  });

  test("a contributor joins only an extension — a lookup (INNER when required) is a type error, and refused", () => {
    const c = library();
    const handle = handleOn(c);
    const ext = playback.join("playback");
    const lookup = {
      kind: "lookup" as const,
      alias: "playback",
      table: ext.table,
      pk: ext.key,
      on: { from: "base", col: songs.id },
      required: true,
    };
    // @ts-expect-error — a contributor's join is an ExtensionJoin.
    const served = serveColumns(handle, { join: lookup });
    expect(() => compileCollection(c, { from: songs }, [served])).toThrow(
      /contributed columns "playback" are read through a "lookup" join/,
    );
  });

  test("a contributed field with no column of its join by name must name one", () => {
    const c = library();
    const handle = liveColumns(c, "stats", {
      row: z.object({ plays: z.number() }),
      filterable: {},
      sortable: [],
    });
    expect(() =>
      compileCollection(c, { from: songs }, [
        serveColumns(handle, { join: playback.join("stats") } as never),
      ]),
    ).toThrow(
      /contributed field "stats.plays" binds to no wire column of join "stats"/,
    );
    const specs = compileCollection(c, { from: songs }, [
      serveColumns(handle, {
        join: playback.join("stats"),
        columns: { plays: (j) => j.stats.playCount! },
      }),
    ]);
    expect(Object.keys(specs.select)).toContain("stats.plays");
  });
});
