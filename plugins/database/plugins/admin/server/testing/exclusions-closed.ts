import { getTableName } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { ExcludeFromBackup } from "../internal/backup-exclusion";
import { planBackupExclusions } from "../internal/backup-plan";
import {
  APP_SCHEMA,
  type CatalogForeignKey,
  type SchemaCatalog,
} from "../internal/catalog-plan";
import { ExcludeFromFork } from "../internal/fork-exclusion";
import { planForkExclusions } from "../internal/fork-plan";
import { tableLabel } from "../internal/table-label";

/**
 * Check a plugin's `ExcludeFromBackup` / `ExcludeFromFork` declarations against
 * its own drizzle tables, without a database: no kept table may have a foreign
 * key to a table whose rows are left out (pg_restore would fail re-adding it).
 * Throws the same refusal a real backup or fork would, naming the link.
 *
 * Reads the declarations collected so far, so call it after
 * `collectContributions` has run over the plugin. The catalog is derived from
 * `tables`' drizzle objects rather than a live database, so it sees the schema
 * this checkout declares, including a link removed before its migration has run
 * anywhere. `extraForeignKeys` adds links the tables do not declare, to prove a
 * refusal.
 */
export function assertExclusionsClosed(
  tables: readonly PgTable[],
  opts: { extraForeignKeys?: readonly CatalogForeignKey[] } = {},
): void {
  const catalog = catalogOf(tables, opts.extraForeignKeys ?? []);
  planBackupExclusions(
    catalog,
    {
      tables: ExcludeFromBackup.getContributions().map((c) =>
        tableLabel(c.table),
      ),
    },
    // Strict: a link into a left-out table is the refusal this checks for.
    { strict: true },
  );
  // The catalog holds only the app schema, so a schema-level declaration has
  // nothing here to match.
  planForkExclusions(catalog, {
    // The declarations collected over the plugin under test (a data list's
    // `getContributions()` reads the build's file, which a test never installs).
    tables: ExcludeFromFork.startedContributions().map((c) => c.table),
    schemas: [],
  });
}

function catalogOf(
  tables: readonly PgTable[],
  extra: readonly CatalogForeignKey[],
): SchemaCatalog {
  const foreignKeys: CatalogForeignKey[] = tables.flatMap((t) =>
    getTableConfig(t).foreignKeys.map((fk) => ({
      table: getTableName(t),
      constraint: fk.getName(),
      references: getTableName(fk.reference().foreignTable),
    })),
  );
  const names = new Set<string>();
  for (const fk of [...foreignKeys, ...extra]) {
    names.add(fk.table);
    names.add(fk.references);
  }
  for (const t of tables) names.add(getTableName(t));
  return {
    schemas: [
      {
        name: APP_SCHEMA,
        tables: [...names].sort(),
        partitions: {},
        foreignKeys: [...foreignKeys, ...extra].filter(
          (fk) => fk.table !== fk.references,
        ),
        bytes: 0,
        fromExtension: false,
      },
    ],
  };
}
