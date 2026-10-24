/**
 * Mail's real fork and backup exclusions against mail's real drizzle schema:
 * no table kept in a fork or a backup may have a foreign key to a table whose
 * rows are left out (pg_restore would fail re-adding it — see `database/admin`).
 *
 * The check itself is database/admin's (`assertExclusionsClosed`): it derives
 * the catalog from the drizzle table objects rather than a live database.
 *
 * Run: `./equin test plugins/apps/plugins/mail`
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { collectContributions } from "@plugins/framework/plugins/server-core/core";
import { ExcludeFromBackup } from "@plugins/database/plugins/admin/server";
import { assertExclusionsClosed } from "@plugins/database/plugins/admin/server/testing";
import mailCore, {
  _mailAccounts,
  _mailAttachments,
  _mailLabels,
  _mailMessageLabels,
  _mailMessages,
  _mailSyncState,
  _mailThreads,
} from "../index";
import { _mailDraftAttachmentsTable } from "./schema-attachments";
import { _mailDrafts, _mailOutbox } from "./tables";

const TABLES: PgTable[] = [
  _mailAccounts,
  _mailSyncState,
  _mailLabels,
  _mailThreads,
  _mailMessages,
  _mailMessageLabels,
  _mailAttachments,
  _mailDrafts,
  _mailOutbox,
  _mailDraftAttachmentsTable,
];

const tableNames = (c: { table: PgTable | string }[]) =>
  c.map((x) => (typeof x.table === "string" ? x.table : getTableName(x.table)));

beforeAll(() => {
  collectContributions([
    { id: "apps/mail/mail-core", contributions: mailCore.contributions },
  ]);
});

describe("mail's data exclusions", () => {
  test("leave the corpus and its sync state out of backups, and keep the rest", () => {
    expect(
      [...tableNames(ExcludeFromBackup.getContributions())].sort(),
    ).toEqual([
      "mail_attachments",
      "mail_message_labels",
      "mail_messages",
      "mail_sync_state",
      "mail_threads",
    ]);
  });

  test("no kept table links to a left-out one, in a backup or a fork", () => {
    expect(() => assertExclusionsClosed(TABLES)).not.toThrow();
  });

  test("the drafts → threads link this guards against would be refused", () => {
    expect(() =>
      assertExclusionsClosed(TABLES, {
        extraForeignKeys: [
          {
            table: "mail_drafts",
            constraint: "mail_drafts_thread_id_mail_threads_id_fk",
            references: "mail_threads",
          },
        ],
      }),
    ).toThrow(/"mail_drafts" links to "mail_threads"/);
  });
});
