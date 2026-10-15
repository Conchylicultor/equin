/**
 * An exposure SORTED and FILTERED by a window — a collection reaching an
 * entity (`exposes`) whose extension exposes a defaulted count and a nullable
 * instant (Sonata's play stats) — without a database: the recording `QueryDb`
 * renders every statement.
 *
 * - the codec validates a query against the column sets it names, never a
 *   registry, and the server's params gate decodes against the folded ones;
 * - each exposed column is projected flat under its wire name and folded into
 *   `$columns`; `:rows` carries it too;
 * - a defaulted column reads its default (COALESCE) in a sort and a filter, so
 *   a host with no side row sorts and filters as the extension defines it;
 * - its join routes like any extension: `value` for a tuple that only projects
 *   it, `membership` for one that sorts or filters by it;
 * - the order signature reads a sorted exposed column off `$columns`.
 *
 * (The fold's shape, presence fields, related entities and boot are
 * `serve-collection-exposed.test.ts`'s.)
 *
 * Run: `./singularity test plugins/network/plugins/live`.
 */

import { describe, expect, test } from "bun:test";
import { pgTable, text } from "drizzle-orm/pg-core";
import { nullable } from "@plugins/fields/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import type { ResourceParams } from "@plugins/framework/plugins/resource-runtime/core";
import { ResourceContractError } from "@plugins/packages/plugins/resource-protocol/core";
import {
  compileWindowQuery,
  recordingQueryDb,
} from "@plugins/infra/plugins/query-resource/server/testing";
import {
  exposedColumns,
  liveCollection,
  LIVE_COLUMNS_KEY,
} from "@plugins/network/plugins/live/core";
import { compileCollection } from "./serve-collection";

const songs = pgTable("xs_songs", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
});
const songsRef = entityRef("xs_songs", {
  id: textField({ label: "Id", filterable: false }),
  title: textField({ label: "Title" }),
});
const playback = defineExtension(
  songs,
  "playback",
  defineExtensionShape({
    key: "songId",
    fields: {
      playCount: intField({ label: "Plays", default: 0 }),
      lastPlayedAt: nullable(dateField({ label: "Last played" })),
    },
    exposes: {
      parent: songsRef,
      name: "playback",
      fields: { playCount: {}, lastPlayedAt: {} },
    },
  }),
  { columns: { playCount: { default: 0 } } },
);
const stats = exposedColumns(playback.exposure);
const SLICE = "xs_songs_ext_playback";
const PLAYS = `${SLICE}.playCount`;
const LAST = `${SLICE}.lastPlayedAt`;

let n = 0;
function library() {
  return liveCollection(`test.live.exposed-sort-${n++}`, {
    from: songsRef,
    pick: ["id", "title"],
    id: "id",
    sortable: ["title"],
    default: { orderBy: [["title", "asc"]], limit: 10 },
    maxLimit: 30,
  });
}

function compile(script?: (q: { sql: string }) => unknown[]) {
  const c = library();
  const recording = recordingQueryDb(script);
  const specs = compileCollection(
    c,
    { from: songs, db: recording.db },
    [],
    [playback],
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

describe("exposed columns — the codec", () => {
  test("a query names an exposed column only with the set that declares it", () => {
    const c = library();
    const codec = c.window.window;
    expect(() =>
      codec.encode({ orderBy: [[PLAYS as "title", "desc"]] }),
    ).toThrow(/not a sortable column/);
    const params = codec.encode({
      orderBy: [[PLAYS as "title", "desc"]],
      where: { [PLAYS]: { gt: 3 } } as never,
      columns: [stats],
    });
    expect(params).toEqual({
      limit: "10",
      order: `[["${PLAYS}","desc"]]`,
      where: `{"column":"${PLAYS}","op":"gt","operand":3}`,
    });
    // The server decodes against the sets it folds — and only those.
    expect(() => codec.decode(params)).toThrow();
    expect(codec.decode(params, [stats]).orderBy as unknown).toEqual([
      [PLAYS, "desc"],
    ]);
    // A collection that does not reach the entity cannot name its columns.
    const unreached = liveCollection(`test.live.exposed-sort-x-${n++}`, {
      carry: { fields: { id: textField(), title: textField() } },
      id: "id",
      sortable: ["title"],
      default: { orderBy: [["title", "asc"]], limit: 10 },
      maxLimit: 30,
    });
    expect(() =>
      unreached.window.window.encode({ columns: [stats] } as never),
    ).toThrow(/does not reach/);
  });
});

describe("exposed columns — the compile", () => {
  test("the params gate decodes against the folded sets: the descriptor's own would refuse their columns", () => {
    const { c, window } = compile();
    const params = c.window.window.encode({
      orderBy: [[PLAYS as "title", "desc"]],
      columns: [stats],
    });
    expect(() => c.window.validateParams(params)).toThrow(
      ResourceContractError,
    );
    expect(() => window.validateParams!(params)).not.toThrow();
    // A column no folded set declares is still a contract mismatch.
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
        [PLAYS]: 4,
        [LAST]: played,
        __row_key_0: "t",
        __row_key_1: "s1",
      },
    ]);
    const [row] = (await window.loader(c.window.window.encode())) as Record<
      string,
      unknown
    >[];
    expect(calls[0]!.sql).toStartWith(
      'select "xs_songs"."id", "xs_songs"."title", ' +
        `COALESCE("${SLICE}"."play_count", $1), "${SLICE}"."last_played_at"`,
    );
    expect(row).toEqual({
      id: "s1",
      title: "t",
      $key: '["t","s1"]',
      [LIVE_COLUMNS_KEY]: {
        [SLICE]: { playCount: 4, lastPlayedAt: played },
      },
    });
    // The point sibling projects them too: one row shape per collection.
    const [point] = (await rows.loader(c.rows.point.encode(["s1"]))) as Record<
      string,
      unknown
    >[];
    expect(point![LIVE_COLUMNS_KEY]).toEqual({
      [SLICE]: { playCount: 4, lastPlayedAt: played },
    });
  });

  test("a defaulted column sorts and filters as its default: a song never played has playCount 0", async () => {
    const { c, window, calls } = compile();
    await window.loader(
      c.window.window.encode({
        orderBy: [[PLAYS as "title", "desc"]],
        where: { [PLAYS]: 0 } as never,
        columns: [stats],
      }),
    );
    expect(calls[0]!.sql).toMatch(
      new RegExp(`where .*COALESCE\\("${SLICE}"\\."play_count", \\$\\d+\\)`),
    );
    expect(calls[0]!.sql).toMatch(
      new RegExp(
        `order by COALESCE\\("${SLICE}"\\."play_count", \\$\\d+\\) DESC NULLS LAST`,
      ),
    );
  });

  test("its join is value for a tuple that only projects it, membership for one ordering or filtering by it", () => {
    const { c, window } = compile();
    const codec = c.window.window;
    expect(roles(window.routes!, codec.encode())).toEqual({
      base: "membership",
      [SLICE]: "value",
    });
    expect(
      roles(
        window.routes!,
        codec.encode({
          orderBy: [[LAST as "title", "desc"]],
          columns: [stats],
        }),
      ),
    ).toEqual({ base: "membership", [SLICE]: "membership" });
    const route = window.routes!.routes.find((r) => r.id === SLICE)!;
    expect(route.map).toEqual({ kind: "alias" });
  });

  test("the order signature reads a sorted exposed column off $columns", () => {
    const { c, window } = compile();
    const params = c.window.window.encode({
      orderBy: [[PLAYS as "title", "desc"]],
      columns: [stats],
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
        [SLICE]: { playCount: count, lastPlayedAt: null },
      },
    });
    expect(sig(row(1), params)).not.toBe(sig(row(2), params));
    expect(sig(row(1), params)).toBe(sig(row(1), params));
  });
});
