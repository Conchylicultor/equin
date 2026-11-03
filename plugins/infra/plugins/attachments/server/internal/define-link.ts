import { and, eq, getTableName, inArray, or } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "@plugins/database/server";
import type { EntityRef } from "@plugins/infra/plugins/entities/core";
import {
  defineEntity,
  defaultNow,
} from "@plugins/infra/plugins/entities/server";
import type { attachmentLinkFields } from "../../core";
import { _attachments } from "./tables";

type OwnerTable = PgTable & { id: AnyPgColumn };

// `notNull: true` is not decoration: without it drizzle infers a SELECT of
// these columns as `string | null`, and the (owner, attachment) pair — the
// table's own primary key, so never null — stops being usable as a diff key.
type LinkTable = PgTable & {
  ownerId: AnyPgColumn<{ data: string; notNull: true }>;
  attachmentId: AnyPgColumn<{ data: string; notNull: true }>;
};

// db-or-tx executor. The db arm is the BARE `NodePgDatabase` (the `doc-store.ts`
// precedent for a db-parametrized helper), not `typeof db`: the app's singleton
// is `NodePgDatabase & { $client: Pool }`, so typing it that way would exclude
// the throwaway database `createTestDb` hands the test — the one caller a
// db-parametrized helper exists for. A transaction handle is not a
// `NodePgDatabase`, so it stays its own arm.
type LinkExecutor =
  NodePgDatabase | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface AttachmentLinkSource {
  table: PgTable;
  attachmentIdCol: AnyPgColumn;
}

// One owner's desired link set, as handed to `setMany`.
export interface AttachmentLinkEntry {
  ownerId: string;
  ids: readonly string[];
}

// Typed handle returned by `Attachments.defineLink(ownerTable, linkRef)`. Wraps the
// underlying join table with a fixed protocol (`set`/`setMany`/`add`);
// the table itself is exposed as `.table` for intra-plugin raw queries
// (drizzle-kit schema discovery + niche selects). Cross-plugin imports of the
// underlying table are blocked by the plugin-boundary checker because the table
// never leaves `internal/` — only the handle is barrel-exported.
export interface AttachmentLink {
  /** The owner table's name (`"tasks"`) — `attachments.by-owner`'s `ownerType`. */
  readonly ownerType: string;
  readonly table: ReturnType<typeof linkEntity>["table"];
  // Reconcile link rows so they exactly match `ids`. Inserts new ids,
  // deletes ids no longer present. Use when the attachment set is the
  // canonical mirror of a replaceable source (e.g. a markdown column).
  // One-owner `setMany` — same silence guarantee, same single transaction.
  set(ownerId: string, ids: readonly string[]): Promise<void>;
  // The many-owner reconcile: ONE transaction, ONE indexed read over the
  // touched owners, then AT MOST one batched INSERT and one batched DELETE.
  // Use it whenever a whole document's owners are reconciled together (the
  // page attachment reconcile) instead of looping `set()` — a per-owner loop
  // is a transaction per owner, and an owner whose set is unchanged still
  // costs a delete-nothing DELETE, which a STATEMENT-level change-feed
  // trigger cannot tell apart from a real one.
  setMany(entries: readonly AttachmentLinkEntry[]): Promise<void>;
  // Append-only union. Atomic: one INSERT … ON CONFLICT DO NOTHING. Use
  // when the source of truth grows append-only (turns in a conversation,
  // attachments inherited by chained tasks). Avoids the read-merge-write
  // race that `set(union(existing, new))` would have.
  add(ownerId: string, ids: readonly string[]): Promise<void>;
}

const linkSources: AttachmentLinkSource[] = [];

// The link table's PK is the (owner, attachment) PAIR, so the diff key is the
// pair too — a single-column `notInArray` cannot express it.
const pairKey = (ownerId: string, attachmentId: string) =>
  `${ownerId} ${attachmentId}`;

/**
 * Reconcile the link rows of every owner in `entries` to exactly the ids that
 * entry declares. db-PARAMETRIZED (the `doc-store.ts` precedent) so the real
 * SQL — the batched ON CONFLICT insert and the composite-pair delete — is
 * exercised against a throwaway Postgres in `define-link.test.ts`; the `db`
 * singleton is bound only by the handle's `setMany`.
 *
 * The property that matters here is SILENCE, not batching: when an owner's set
 * is unchanged, both diff sets are empty and this issues one indexed SELECT and
 * ZERO write statements. That is why it is a diff and not the simpler
 * delete-all-then-reinsert — the latter is equally O(1) round-trips but
 * rewrites rows that did not change, firing the DB change-feed on the link
 * table for a no-op and recreating the very push churn the batching exists to
 * remove.
 *
 * An owner with an empty id set contributes nothing to the insert and is
 * covered by the delete arm, so "clear this owner" needs no special case.
 */
export async function applyLinkDiff(
  tx: LinkExecutor,
  table: LinkTable,
  entries: readonly AttachmentLinkEntry[],
): Promise<void> {
  const owners = [...new Set(entries.map((e) => e.ownerId))];
  if (owners.length === 0) return;

  const wanted = new Map<string, { ownerId: string; attachmentId: string }>();
  for (const entry of entries) {
    for (const attachmentId of entry.ids) {
      wanted.set(pairKey(entry.ownerId, attachmentId), {
        ownerId: entry.ownerId,
        attachmentId,
      });
    }
  }

  // ONE read, over the touched owners only — never the whole table.
  const existing = await tx
    .select({ ownerId: table.ownerId, attachmentId: table.attachmentId })
    .from(table)
    .where(inArray(table.ownerId, owners));

  const have = new Set(existing.map((r) => pairKey(r.ownerId, r.attachmentId)));
  const toInsert = [...wanted]
    .filter(([key]) => !have.has(key))
    .map(([, row]) => row);
  const toDelete = existing.filter(
    (r) => !wanted.has(pairKey(r.ownerId, r.attachmentId)),
  );

  if (toInsert.length > 0) {
    await tx.insert(table).values(toInsert).onConflictDoNothing();
  }
  if (toDelete.length > 0) {
    await tx
      .delete(table)
      .where(
        or(
          ...toDelete.map((r) =>
            and(
              eq(table.ownerId, r.ownerId),
              eq(table.attachmentId, r.attachmentId),
            ),
          ),
        ),
      );
  }
}

// The link entity over `ref`: the (owner, attachment) pair is the primary
// key, both sides cascading.
function linkEntity(
  ownerTable: OwnerTable,
  ref: EntityRef<string, typeof attachmentLinkFields>,
) {
  return defineEntity(ref, {
    primaryKey: ["ownerId", "attachmentId"],
    columns: {
      ownerId: {
        references: {
          column: (): AnyPgColumn => ownerTable.id,
          onDelete: "cascade",
          onUpdate: "cascade",
        },
      },
      attachmentId: {
        references: {
          column: () => _attachments.id,
          onDelete: "cascade",
          onUpdate: "cascade",
        },
      },
      createdAt: { default: defaultNow() },
    },
  });
}

// Build the `<owner>_attachments` join table linking a consumer's domain table
// to `_attachments` — the entity the owner declared in its own `core/` over
// `attachmentLinkFields` (so its link collection reads it), named for the
// owner table — and return a handle whose methods close over it. Both FKs
// cascade on owner/attachment delete, and on update — so a rewrite of either
// parent's ids (a legacy bare uuid gaining its kind's prefix, `plugins/ids`)
// carries the link rows along; the orphan sweep reclaims rows whose last link
// disappears. Module-load side effect — every consumer's `tables*.ts` /
// `schema*.ts` runs at import time, registering its link with the sweep.
export function defineLink<T extends OwnerTable>(
  ownerTable: T,
  ref: EntityRef<string, typeof attachmentLinkFields>,
): AttachmentLink {
  const ownerType = getTableName(ownerTable);
  if (ref.name !== `${ownerType}_attachments`) {
    throw new Error(
      `Attachments.defineLink(${ownerType}): the link entity is "${ref.name}" — an owner's link table is named for it, "${ownerType}_attachments".`,
    );
  }
  const table = linkEntity(ownerTable, ref).table;
  linkSources.push({ table, attachmentIdCol: table.attachmentId });

  const setMany = async (
    entries: readonly AttachmentLinkEntry[],
  ): Promise<void> => {
    if (entries.length === 0) return;
    await db.transaction(async (tx) => {
      await applyLinkDiff(tx, table, entries);
    });
  };

  return Object.freeze({
    ownerType,
    table,
    setMany,
    async set(ownerId, ids) {
      await setMany([{ ownerId, ids }]);
    },
    async add(ownerId, ids) {
      const wanted = Array.from(new Set(ids));
      if (wanted.length === 0) return;
      await db
        .insert(table)
        .values(wanted.map((attachmentId) => ({ ownerId, attachmentId })))
        .onConflictDoNothing();
    },
  } satisfies AttachmentLink);
}

export function getRegisteredLinks(): readonly AttachmentLinkSource[] {
  return linkSources;
}
