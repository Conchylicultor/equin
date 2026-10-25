/**
 * The per-database setting a fork stamps on the database it creates
 * (`ALTER DATABASE … SET`): the instant, on the cluster's clock, just after its
 * rows were copied in. Every row older than it came from the source database;
 * every row the fork's own backend writes is newer.
 *
 * A setting of the database object rather than a row, on purpose: it survives
 * the fork's rename to its canonical name, and `pg_dump` does not carry it (no
 * `--create`) — so a fork of a fork is stamped afresh, and a database restored
 * from a backup, never forked, has none.
 *
 * Written by `database/admin`'s `forkDatabase`; read by `databaseForkedAt`.
 */
export const FORKED_AT_SETTING = "lineage.forked_at";
