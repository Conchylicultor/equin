import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql as drizzleSql } from "drizzle-orm";
import { getViewConfig } from "drizzle-orm/pg-core";
import {
  topoSortViews,
  compileCreateView,
  DERIVED_VIEW_STATE_TABLE_NAME,
  type RegisteredView,
} from "@plugins/database/plugins/derived-views/core";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { z } from "zod";
import { derivedViewsLog as log } from "./log";
import type { View } from "./contribution";

// One declared view, as a `View` contribution carries it.
export type DeclaredView = ReturnType<typeof View.getContributions>[number];

// Rebuilds the entire plain-derived-view layer from source on every boot.
//
// Plain views hold no data, so we can freely DROP + CREATE them. We drop in
// REVERSE dependency order (dependents before dependencies) and recreate in
// forward dependency order (dependencies before dependents) so Postgres never
// rejects a drop for an existing dependent or a create for a missing source.
//
// The whole thing runs in one transaction inside `onReadyBlocking` (before the
// server-ready barrier, no traffic yet): any failure throws and blocks boot
// loudly rather than serving against a half-rebuilt view layer.
//
// `db` is passed in (like runMigrations) so this module never imports
// @plugins/database/server — that would form a cycle (database/server calls us).
//
// `views` is passed in too, never read from `View.getContributions()` here. That
// table is filled only by a booted backend's `collectContributions`; a process
// that never boots (the `migration-applies-clean` check) gathers the same set
// from the server barrels instead. Reading it here made the check's dry-run
// rebuild zero views and pass without testing any.
//
// SKIP WHEN UNCHANGED. The DROP+CREATE holds an AccessExclusive lock over each
// view until commit. During a hot-swap restart the *previous* backend is still
// serving reads of those same views against the same DB, so the exclusive
// window deadlocked concurrent readers (the tasks loader, the allow-files poll
// — see the per-query deadlock retry in database/server). The view layer is a
// pure function of source, so we fingerprint the compiled DDL and skip the
// rebuild entirely when it matches what is already live — removing the lock
// window from the steady-state restart path. The rebuild (and its brief
// deadlock risk) now only runs on a genuine view edit, not every restart.
export async function rebuildDerivedViews(
  db: NodePgDatabase,
  views: readonly DeclaredView[],
): Promise<void> {
  const declared: RegisteredView[] = views.map(({ view, dependsOn }) => ({
    name: getViewConfig(view).name,
    view,
    dependsOn: dependsOn ?? [],
  }));
  const ordered = topoSortViews(declared);
  if (ordered.length === 0) return;

  // Content signature of the whole view layer: each view's name + compiled DDL,
  // in dependency order. Identical signature ⇒ identical views ⇒ nothing to do.
  const compiled = ordered.map((v) => ({
    name: v.name,
    ddl: compileCreateView(v),
  }));
  const signature = sha256Hex(
    compiled.map((c) => `${c.name}\n${c.ddl}`).join("\n--\n"),
  );

  await db.transaction(async (tx) => {
    // Bookkeeping for the derived-view layer's content signature. Created
    // idempotently here (not via a migration) because, like the views it
    // tracks, it is derived-layer state — not schema in the migration chain.
    // It lives in the DB so a worktree fork carries the signature with its
    // views (a `CREATE DATABASE ... TEMPLATE` copies the row), avoiding a
    // spurious first-boot rebuild on the fork.
    await tx.execute(
      drizzleSql.raw(
        `CREATE TABLE IF NOT EXISTS "public"."${DERIVED_VIEW_STATE_TABLE_NAME}" (
           id boolean PRIMARY KEY DEFAULT true CHECK (id),
           signature text NOT NULL
         )`,
      ),
    );

    // No row on the very first boot of a database — a legitimately-empty
    // result, which is why this reads rows rather than demanding exactly one.
    const priorRows = await executeRows(tx, {
      query: drizzleSql.raw(
        `SELECT signature FROM "public"."${DERIVED_VIEW_STATE_TABLE_NAME}" LIMIT 1`,
      ),
      row: z.object({ signature: z.string() }),
      label: "derived-views: read signature",
    });
    const prior = priorRows[0]?.signature;

    // Guard against a view dropped out-of-band: only trust the signature when
    // every declared view also physically exists.
    const existingRows = await executeRows(tx, {
      // `information_schema.views.table_name` is a domain over `name`; the
      // cast keeps the column's decoded type the one the schema declares.
      query: drizzleSql.raw(
        `SELECT table_name::text AS table_name FROM information_schema.views WHERE table_schema = 'public'`,
      ),
      row: z.object({ table_name: z.string() }),
      label: "derived-views: list existing views",
    });
    const existing = new Set(existingRows.map((r) => r.table_name));
    const allPresent = ordered.every((v) => existing.has(v.name));

    if (prior === signature && allPresent) {
      log.publish(
        `[derived-views] up to date (${ordered.length} view(s), signature unchanged) — skipping rebuild`,
      );
      return;
    }

    log.publish(
      `[derived-views] rebuilding ${ordered.length} view(s): ${ordered
        .map((v) => v.name)
        .join(", ")}`,
    );

    for (const v of [...ordered].reverse()) {
      await tx.execute(
        drizzleSql.raw(`DROP VIEW IF EXISTS "public"."${v.name}"`),
      );
    }
    for (const v of compiled) {
      await tx.execute(drizzleSql.raw(v.ddl));
    }

    await tx.execute(
      drizzleSql`
        INSERT INTO "public".${drizzleSql.raw(`"${DERIVED_VIEW_STATE_TABLE_NAME}"`)} (id, signature)
        VALUES (true, ${signature})
        ON CONFLICT (id) DO UPDATE SET signature = EXCLUDED.signature
      `,
    );
  });
}

// Drops every plain view that is LIVE in the `public` schema, ahead of pending
// migrations. Views are derived code rebuilt from source right after migrations
// (`rebuildDerivedViews`), so nothing is lost — but while they exist, a migration
// that drops or retypes a column a live view reads fails ("cannot drop column …
// because other objects depend on it"). drizzle-kit never sees the views, so it
// cannot order a DROP VIEW itself, and push regenerates schema migrations, so a
// hand-added DROP VIEW never survives. Dropping the whole layer first makes that
// class of failure impossible.
//
// The LIVE set, not the declared one: the view in the way is the one the
// previous code created, which the current declarations may no longer name.
// Every public view is derived (plain views left the migration layer in
// `views_as_derived_code`); other schemas (graphile_worker) are untouched.
//
// One statement naming every view, so Postgres resolves dependents among them
// with no ordering and no CASCADE. `rebuildDerivedViews` then sees views missing
// and rebuilds regardless of its stored signature.
export async function dropDerivedViews(db: NodePgDatabase): Promise<void> {
  const rows = await executeRows(db, {
    // `information_schema.views.table_name` is a domain over `name`; the cast
    // keeps the decoded type the one the schema declares.
    query: drizzleSql.raw(
      `SELECT table_name::text AS table_name FROM information_schema.views WHERE table_schema = 'public'`,
    ),
    row: z.object({ table_name: z.string() }),
    label: "derived-views: list live views to drop",
  });
  if (rows.length === 0) return;
  const names = rows.map((r) => r.table_name);
  log.publish(
    `[derived-views] dropping ${names.length} live view(s) before migrations: ${names.join(", ")}`,
  );
  await db.execute(
    drizzleSql.raw(
      `DROP VIEW IF EXISTS ${names.map((n) => `"public"."${n.replaceAll('"', '""')}"`).join(", ")}`,
    ),
  );
}
