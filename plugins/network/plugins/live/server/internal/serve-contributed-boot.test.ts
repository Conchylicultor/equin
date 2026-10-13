/**
 * A contributed collection's resources are DEFERRED: registered at module eval
 * under their descriptors, compiled at `bindDeferredResources` — the boot step
 * after contributions are collected — with every `LiveColumns.Serve` naming the
 * collection folded in. Serving one before the bind throws, and a served
 * column set no contributed collection compiles fails the bind.
 *
 * Run: `./singularity test plugins/network/plugins/live`.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { pgTable, text } from "drizzle-orm/pg-core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import {
  bindDeferredResources,
  collectContributions,
} from "@plugins/framework/plugins/server-core/core";
import { recordingQueryDb } from "@plugins/infra/plugins/query-resource/server/testing";
import {
  liveCollection,
  liveColumns,
  LIVE_COLUMNS_KEY,
  LIVE_ROW_KEY,
} from "@plugins/network/plugins/live/core";
import { liveNumber } from "@plugins/network/plugins/live/plugins/filter/core";
import { serveCollection } from "./serve-collection";
import { LiveColumns, serveColumns } from "./serve-columns";

const songs = pgTable("contrib_boot_songs", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
});
const plays = defineExtension(
  songs,
  "plays",
  defineExtensionShape({ key: "songId", fields: { count: intField() } }),
  { columns: { count: { default: 0 } } },
);

let n = 0;
function library() {
  return liveCollection(`test.live.contributed-boot-${n++}`, {
    row: z.object({ id: z.string(), title: z.string() }),
    id: "id",
    filterable: {},
    sortable: ["title"],
    default: { orderBy: [["title", "asc"]], limit: 10 },
    maxLimit: 30,
    contributed: true,
  });
}

describe("contributed collection — the deferred bind", () => {
  test("serving before the bind throws; after it, rows carry every served contributor", async () => {
    const c = library();
    const handle = liveColumns(c, "plays", {
      row: z.object({ count: z.number() }),
      filterable: { count: liveNumber() },
      sortable: ["count"],
    });
    // The row as the database answers it: its fields, the contributor's
    // column, and the row key's parts (the order key, then the id).
    const recording = recordingQueryDb(() => [
      {
        id: "s1",
        title: "t",
        "plays.count": 7,
        __row_key_0: "t",
        __row_key_1: "s1",
      },
    ]);
    const served = serveCollection(c, { from: songs, db: recording.db });
    // Declared at module eval: every minted key, and its Declare.
    expect(served.keys).toEqual([c.key, `${c.key}:rows`, `${c.key}:groups`]);
    expect(served.declare).toHaveLength(3);
    // `expect(p).rejects` is typed `void` by bun's matchers: capture instead.
    let early: unknown;
    try {
      await served.window.load(c.window.window.encode());
    } catch (err) {
      early = err;
    }
    expect((early as Error).message).toMatch(/is deferred and not bound yet/);

    collectContributions([
      {
        id: "test.plays",
        contributions: [
          LiveColumns.Serve(
            serveColumns(handle, { join: plays.join("plays") }),
          ),
        ],
      },
    ]);
    bindDeferredResources();

    // A window row carries its `$key` beside the row type's fields.
    const rows: unknown[] = await served.window.load(c.window.window.encode());
    expect(rows).toEqual([
      {
        id: "s1",
        title: "t",
        [LIVE_COLUMNS_KEY]: { plays: { count: 7 } },
        [LIVE_ROW_KEY]: '["t","s1"]',
      },
    ]);
    expect(recording.calls[0]!.sql).toContain(
      'left join "contrib_boot_songs_ext_plays" "plays"',
    );
  });

  test("a served column set no contributed collection here compiles fails the bind", () => {
    const c = library();
    const handle = liveColumns(c, "orphan", {
      row: z.object({ count: z.number() }),
      filterable: {},
      sortable: [],
    });
    // `c` is declared but never served.
    collectContributions([
      {
        id: "test.orphan",
        contributions: [
          LiveColumns.Serve(
            serveColumns(handle, { join: plays.join("orphan") }),
          ),
        ],
      },
    ]);
    expect(() => bindDeferredResources()).toThrow(
      /LiveColumns.Serve contribution\(s\) name a collection no `serveCollection` serves here/,
    );
  });
});
