import { queryRows } from "@plugins/database/plugins/sql-rows/core";
import { z } from "zod";
import { openShortLivedClient } from "./pool";

// The part of turning declared exclusions into `pg_dump` flags that forks and
// backups share: the one catalog read, the pattern quoting, and the rule for a
// table-level declaration (it must exist in `public`, and a partitioned table
// is expanded to its leaves).
//
// Everything schema-level (globs, `keep`, unclaimed schemas) is a fork question
// and stays in ./fork-plan. A backup keeps every schema's rows and only ever
// names tables — see ./backup-plan.
//
// Pure core, thin edge: `planTableExclusions` holds the rule and
// `readSchemaCatalog` is the one SQL statement, so the rule is testable with no
// database (`admin` cannot import `db-test-fixture` — the fixture imports
// `admin`, so a test edge back would close an R6 cycle).

/**
 * One foreign key between two tables of the same schema: `table` links to
 * `references` through `constraint`. Self-references are never listed.
 */
export interface CatalogForeignKey {
  readonly table: string;
  readonly constraint: string;
  readonly references: string;
}

/** One schema of the source database, as the plan needs to see it. */
export interface CatalogSchema {
  readonly name: string;
  /**
   * The relations `--exclude-table-data` can empty: ordinary and partitioned
   * tables, plus materialized views (whose "data" is the restore's
   * `REFRESH MATERIALIZED VIEW`, so excluding one leaves it unpopulated —
   * exactly the DDL-kept/rows-dropped shape).
   *
   * Sequences are deliberately absent. Their data component is a `setval`, and
   * suppressing it would restart a fork's sequences at their declared start
   * rather than continuing from the source's high-water mark — harmless either
   * way, and not worth enumerating.
   */
  readonly tables: readonly string[];
  /**
   * Partitioned parent → every descendant leaf of it in this schema.
   *
   * `--exclude-table-data` does NOT cascade to partitions (which is why
   * Postgres 16 grew a separate `…-and-children` flag), and a partition's rows
   * are dumped under the LEAF's own name. So a declaration naming a partitioned
   * parent has to be expanded here or it silently excludes nothing at all.
   * Nothing in this repo is partitioned yet; `traces` at 949 MB is the obvious
   * first candidate, and it is already named by an `ExcludeFromFork`.
   */
  readonly partitions: Readonly<Record<string, readonly string[]>>;
  /**
   * Foreign keys whose two tables are both in this schema, excluding
   * self-references, so the planner can refuse a kept table linking to a table
   * whose rows are left out (see {@link KeptLinkToLeftOut}).
   *
   * Only top-level constraints (`conparentid = 0`): Postgres clones an FK onto
   * every partition of the tables it joins, and the clone says nothing the
   * top-level constraint does not.
   */
  readonly foreignKeys: readonly CatalogForeignKey[];
  /** Total on-disk size, only ever used to make a warning concrete. */
  readonly bytes: number;
  /** Owned by an installed extension (`pg_extension.extnamespace`). */
  readonly fromExtension: boolean;
}

/**
 * The source database's non-system schemas. `pg_*` and `information_schema` are
 * already filtered out here — they are Postgres's own and never a decision
 * anyone makes. Everything that IS a decision is left to the planners.
 */
export interface SchemaCatalog {
  readonly schemas: readonly CatalogSchema[];
}

/**
 * The app's own schema: every table this repo declares in drizzle lives here,
 * so a table-level declaration (`ExcludeFromFork`, `ExcludeFromBackup`) is
 * matched against it and nowhere else.
 */
export const APP_SCHEMA = "public";

/**
 * Quote one identifier as a `pg_dump` PATTERN part.
 *
 * `pg_dump` parses `--exclude-table-data` with psql's identifier rules, not as a
 * literal string: an unquoted portion is case-folded to lower case and `*`/`?`
 * are wildcards. A foreign runtime's tables can be mixed-case (`changeLog`) and
 * its schema names can contain a slash (`ext_0/log`), so an unquoted
 * `ext_0.changeLog` folds to `ext_0.changelog` and matches nothing at all —
 * the exact silent-miss the planners exist to make impossible.
 *
 * Inside double quotes every character is literal (wildcards included) and only
 * `"` needs escaping, by doubling.
 *
 * `change-feed` has a byte-identical private twin (`quoteIdent` in its
 * `triggers.ts`) and the duplication is forced: `change-feed` imports `admin`,
 * so importing it back would close a cycle. If a third copy ever appears, that
 * is the moment to give quoting its own leaf plugin rather than a fourth.
 */
export function quotePatternPart(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** A `pg_dump` pattern naming exactly one relation. */
export function tablePattern(schema: string, table: string): string {
  return `${quotePatternPart(schema)}.${quotePatternPart(table)}`;
}

/**
 * A kept table with a foreign key to a table whose rows are left out.
 *
 * `pg_dump --exclude-table-data` keeps the constraint's DDL, and `pg_restore`
 * adds constraints AFTER loading the data — so every kept row pointing at a row
 * that was left out fails that `ALTER TABLE … ADD CONSTRAINT`, and the restore
 * (a fork, or a backup brought back) errors out. Even when no row points
 * across today, the next one will. So the planners refuse it outright: the
 * fork with `ForkPlanError`, the backup with `BackupPlanError`.
 */
export type KeptLinkToLeftOut = CatalogForeignKey;

/** One human-readable line per kept → left-out link, telling the author what to do. */
export function describeKeptLinks(
  what: "fork" | "backup",
  links: readonly KeptLinkToLeftOut[],
): string {
  const lines = links.map(
    (l) =>
      `  - table "${l.table}" links to "${l.references}" through constraint "${l.constraint}"`,
  );
  return (
    `The ${what} exclusions leave out rows that a kept table links to:\n${lines.join("\n")}\n` +
    `pg_restore re-adds each of these constraints after loading the data, so a kept row ` +
    `pointing at a left-out row makes the restore fail. Either leave the source table out ` +
    `of the ${what} too, or replace the link with a plain id (no foreign key).`
  );
}

/** What a set of table-level declarations resolves to against one catalog. */
export interface TableExclusionPlan {
  /** Quoted `"public"."t"` patterns: each declared table plus every partition leaf. */
  readonly excludeTableData: readonly string[];
  /** The same relations as bare names, for a manifest that has to say what it left out. */
  readonly excludedTables: readonly string[];
  /**
   * Declarations naming no table in `public`, as human-readable lines.
   * Reported, not fatal: there are no rows to leave out, so the intent already
   * holds (a branch declaring a table main has not migrated yet; a composition
   * database whose schema never had it).
   */
  readonly unmatched: readonly string[];
  /**
   * Kept tables with a foreign key into a left-out one. Never ignorable — each
   * planner throws its own error class on a non-empty list (see
   * {@link KeptLinkToLeftOut}).
   */
  readonly keptLinks: readonly KeptLinkToLeftOut[];
}

/**
 * Match table-level declarations against the catalog.
 *
 * Pure: no I/O, no clock, no registry read. Every input is an argument.
 */
export function planTableExclusions(
  catalog: SchemaCatalog,
  tables: readonly string[],
): TableExclusionPlan {
  const excludeTableData: string[] = [];
  const excludedTables: string[] = [];
  const unmatched: string[] = [];
  const appSchema = catalog.schemas.find((s) => s.name === APP_SCHEMA);
  for (const table of tables) {
    if (!appSchema?.tables.includes(table)) {
      unmatched.push(
        `table "${APP_SCHEMA}.${table}" does not exist in the source database`,
      );
      continue;
    }
    // The parent AND every partition under it: a partition's rows are dumped
    // under the leaf's own name, so excluding only the parent excludes nothing.
    for (const name of [table, ...(appSchema.partitions[table] ?? [])]) {
      excludeTableData.push(tablePattern(APP_SCHEMA, name));
      excludedTables.push(name);
    }
  }
  // A foreign key from a table NOT left out to one that is. Both ends come from
  // the catalog, so both tables exist. Left out → kept and left out → left out
  // are fine: the rows that would dangle are not in the dump at all.
  const leftOut = new Set(excludedTables);
  const keptLinks: KeptLinkToLeftOut[] = (appSchema?.foreignKeys ?? []).filter(
    (fk) =>
      fk.table !== fk.references &&
      !leftOut.has(fk.table) &&
      leftOut.has(fk.references),
  );
  return { excludeTableData, excludedTables, unmatched, keptLinks };
}

/**
 * The shape of one catalog row, PARSED rather than asserted.
 *
 * This is not ceremony. `pg` decodes a result column using the parser
 * registered for its type OID, and there is none for `name[]` (OID 1003) — the
 * type `array_agg(relname)` produces, since `pg_class.relname` is `name`, not
 * `text`. So an uncast `array_agg` arrives as the RAW literal
 * `"{_private_jobs,migrations,…}"`: a string, which every array operation
 * accepts and silently misreads. `for (const t of tables)` walks it one
 * character at a time and emits `"graphile_worker"."_"`, `…"."p"`, …; every one
 * of those matches nothing, `pg_dump` says nothing, and the fork copies the
 * whole schema. That is the exact class of silent miss the planners exist to
 * remove, reintroduced one layer lower — and it survived a real fork, which is
 * how it was found.
 *
 * The `::text` casts below are the fix; the parse is what makes the fix
 * enforced rather than remembered. The read goes through `queryRows`, the one
 * door every raw-SQL row read in the repo takes, so a column that disagrees with
 * this schema names itself and its pg type OID.
 */
const CatalogRowSchema = z.object({
  name: z.string(),
  tables: z.array(z.string()),
  partitions: z.record(z.string(), z.array(z.string())).nullable(),
  bytes: z.string(),
  from_extension: z.boolean(),
});

/**
 * One foreign-key row. Every name is cast to `text` in the SQL for the same
 * reason as {@link CatalogRowSchema}.
 */
const ForeignKeyRowSchema = z.object({
  schema_name: z.string(),
  source_table: z.string(),
  constraint_name: z.string(),
  target_table: z.string(),
});

/**
 * Read the source database's schemas, their data-bearing relations, their
 * partition trees, their same-schema foreign keys, their size and whether an
 * extension owns them.
 *
 * `pg_*` (which covers `pg_toast`, `pg_temp_*` and `pg_toast_temp_*`) and
 * `information_schema` are filtered here rather than in the plan: they are
 * Postgres's own bookkeeping and never something a plugin author decides about.
 * Extension ownership IS carried through, because "an extension's schema is the
 * extension's business" is a policy of the fork design and belongs beside the
 * other policies.
 */
export async function readSchemaCatalog(
  source: string,
): Promise<SchemaCatalog> {
  const pool = await openShortLivedClient(source);
  try {
    // Every `relname` is cast to `text`. `relname` is `name`, and `pg` cannot
    // decode `name[]` — see CatalogRowSchema for what that silently produced.
    const rows = await queryRows(pool, {
      sql: `
      WITH RECURSIVE
        -- Every (top-level partitioned root, descendant) pair, so a multi-level
        -- partition tree collapses onto the relation a declaration would name.
        tree AS (
          SELECT i.inhparent AS root, i.inhrelid AS member
            FROM pg_inherits i
           WHERE NOT EXISTS (SELECT 1 FROM pg_inherits up
                              WHERE up.inhrelid = i.inhparent)
          UNION ALL
          SELECT t.root, i.inhrelid
            FROM tree t JOIN pg_inherits i ON i.inhparent = t.member
        ),
        rel AS (
          SELECT c.oid, c.relname::text AS relname, c.relnamespace,
                 pg_total_relation_size(c.oid) AS bytes
            FROM pg_class c
           WHERE c.relkind IN ('r', 'p', 'm')
        )
      SELECT n.nspname::text                         AS name,
             coalesce(r.tables, ARRAY[]::text[])     AS tables,
             coalesce(r.bytes, 0)::text              AS bytes,
             p.partitions                            AS partitions,
             EXISTS (SELECT 1 FROM pg_extension e
                      WHERE e.extnamespace = n.oid)  AS from_extension
        FROM pg_namespace n
        LEFT JOIN LATERAL (
               SELECT array_agg(rel.relname ORDER BY rel.relname) AS tables,
                      sum(rel.bytes)                              AS bytes
                 FROM rel WHERE rel.relnamespace = n.oid
             ) r ON true
        LEFT JOIN LATERAL (
               SELECT jsonb_object_agg(x.root, x.members) AS partitions
                 FROM (
                       SELECT root.relname AS root,
                              array_agg(member.relname ORDER BY member.relname) AS members
                         FROM tree
                         JOIN rel root   ON root.oid = tree.root
                         JOIN rel member ON member.oid = tree.member
                        WHERE root.relnamespace = n.oid
                          AND member.relnamespace = n.oid
                        GROUP BY root.relname
                      ) x
             ) p ON true
       WHERE n.nspname NOT LIKE 'pg\\_%'
         AND n.nspname <> 'information_schema'
       ORDER BY n.nspname
    `,
      row: CatalogRowSchema,
    });
    // Foreign keys whose two tables share a schema, minus self-references and
    // the per-partition clones (`conparentid <> 0`) of a top-level constraint.
    const fkRows = await queryRows(pool, {
      sql: `
      SELECT n.nspname::text   AS schema_name,
             src.relname::text AS source_table,
             c.conname::text   AS constraint_name,
             dst.relname::text AS target_table
        FROM pg_constraint c
        JOIN pg_class src   ON src.oid = c.conrelid
        JOIN pg_class dst   ON dst.oid = c.confrelid
        JOIN pg_namespace n ON n.oid = src.relnamespace
       WHERE c.contype = 'f'
         AND c.conparentid = 0
         AND c.conrelid <> c.confrelid
         AND dst.relnamespace = src.relnamespace
         AND n.nspname NOT LIKE 'pg\\_%'
         AND n.nspname <> 'information_schema'
       ORDER BY 1, 2, 3
    `,
      row: ForeignKeyRowSchema,
    });
    return {
      schemas: rows.map((r) => ({
        name: r.name,
        tables: r.tables,
        partitions: r.partitions ?? {},
        foreignKeys: fkRows
          .filter((fk) => fk.schema_name === r.name)
          .map((fk) => ({
            table: fk.source_table,
            constraint: fk.constraint_name,
            references: fk.target_table,
          })),
        bytes: Number(r.bytes),
        fromExtension: r.from_extension,
      })),
    };
  } finally {
    await pool.end();
  }
}
