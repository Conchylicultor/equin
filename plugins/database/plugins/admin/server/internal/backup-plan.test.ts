/**
 * The backup's table rule, checked against a hand-built catalog.
 *
 * No database, for the same reason as ./fork-plan.test.ts: `admin` cannot
 * import `db-test-fixture` without closing a cycle. The real round trip — dump
 * with an exclusion, restore, find the table empty — lives in
 * `backup/sources/databases` (`backup-exclusion.test.ts`).
 *
 * Run: `./equin test plugins/database/plugins/admin`
 */

import { describe, test, expect } from "bun:test";
import { BackupPlanError, planBackupExclusions } from "./backup-plan";
import type { CatalogForeignKey, SchemaCatalog } from "./catalog-plan";

function schema(
  name: string,
  tables: string[],
  partitions: Record<string, string[]> = {},
  foreignKeys: CatalogForeignKey[] = [],
) {
  return {
    name,
    tables,
    partitions,
    foreignKeys,
    bytes: 1_000_000,
    fromExtension: false,
  };
}

const STRICT = { strict: true } as const;
const LENIENT = { strict: false } as const;

function fk(table: string, references: string): CatalogForeignKey {
  return { table, constraint: `${table}_${references}_fk`, references };
}

/** A small mail-shaped cluster: a corpus, the drafts beside it, and a partitioned log. */
function linked(foreignKeys: CatalogForeignKey[]): SchemaCatalog {
  return {
    schemas: [
      schema(
        "public",
        [
          "accounts",
          "threads",
          "messages",
          "drafts",
          "log",
          "log_2026_09",
          "log_2026_10",
          "log_readers",
        ],
        { log: ["log_2026_09", "log_2026_10"] },
        foreignKeys,
      ),
    ],
  };
}

const CATALOG: SchemaCatalog = {
  schemas: [
    schema("graphile_worker", ["_private_jobs", "migrations"]),
    schema(
      "public",
      [
        "tasks",
        "traces",
        "events",
        "events_2026_09",
        "events_2026_10",
        "songIndex",
      ],
      { events: ["events_2026_09", "events_2026_10"] },
    ),
  ],
};

describe("planBackupExclusions", () => {
  test("a declared table gives one quoted pattern", () => {
    const plan = planBackupExclusions(CATALOG, { tables: ["traces"] }, STRICT);
    expect(plan.excludeTableData).toEqual(['"public"."traces"']);
    expect(plan.excludedTables).toEqual(["traces"]);
    expect(plan.unmatched).toEqual([]);
  });

  test("a partitioned table gives the parent plus every leaf", () => {
    const plan = planBackupExclusions(CATALOG, { tables: ["events"] }, STRICT);
    expect(plan.excludeTableData).toEqual([
      '"public"."events"',
      '"public"."events_2026_09"',
      '"public"."events_2026_10"',
    ]);
    expect(plan.excludedTables).toEqual([
      "events",
      "events_2026_09",
      "events_2026_10",
    ]);
  });

  test("a missing table is reported and emits nothing", () => {
    const plan = planBackupExclusions(
      CATALOG,
      {
        tables: ["song_index_cache", "traces"],
      },
      STRICT,
    );
    expect(plan.excludeTableData).toEqual(['"public"."traces"']);
    expect(plan.excludedTables).toEqual(["traces"]);
    expect(plan.unmatched).toEqual([
      'table "public.song_index_cache" does not exist in the source database',
    ]);
  });

  test("only `public` is searched: a same-named table elsewhere does not match", () => {
    const plan = planBackupExclusions(
      CATALOG,
      { tables: ["migrations"] },
      STRICT,
    );
    expect(plan.excludeTableData).toEqual([]);
    expect(plan.unmatched).toHaveLength(1);
  });

  test("a mixed-case name is quoted, so pg_dump does not case-fold it", () => {
    const plan = planBackupExclusions(
      CATALOG,
      { tables: ["songIndex"] },
      STRICT,
    );
    expect(plan.excludeTableData).toEqual(['"public"."songIndex"']);
  });

  test("a database without the app schema reports every declaration", () => {
    const plan = planBackupExclusions(
      { schemas: [schema("graphile_worker", ["migrations"])] },
      { tables: ["traces"] },
      STRICT,
    );
    expect(plan.excludeTableData).toEqual([]);
    expect(plan.unmatched).toHaveLength(1);
  });
});

describe("planBackupExclusions — a kept table linking to a left-out one", () => {
  test("strict: is refused, naming the source table, constraint and target", () => {
    const catalog = linked([fk("drafts", "threads")]);
    expect(() =>
      planBackupExclusions(catalog, { tables: ["threads"] }, STRICT),
    ).toThrow(BackupPlanError);
    expect(() =>
      planBackupExclusions(catalog, { tables: ["threads"] }, STRICT),
    ).toThrow(
      /table "drafts" links to "threads" through constraint "drafts_threads_fk"[\s\S]*leave the source table out[\s\S]*plain id/,
    );
  });

  test("left out → left out is allowed", () => {
    const plan = planBackupExclusions(
      linked([fk("messages", "threads")]),
      {
        tables: ["threads", "messages"],
      },
      STRICT,
    );
    expect(plan.excludedTables).toEqual(["threads", "messages"]);
  });

  test("left out → kept is allowed", () => {
    const plan = planBackupExclusions(
      linked([fk("threads", "accounts")]),
      {
        tables: ["threads"],
      },
      STRICT,
    );
    expect(plan.excludedTables).toEqual(["threads"]);
  });

  test("a self-reference is allowed", () => {
    const plan = planBackupExclusions(
      linked([fk("threads", "threads")]),
      {
        tables: ["threads"],
      },
      STRICT,
    );
    expect(plan.excludedTables).toEqual(["threads"]);
  });

  test("strict: a link to a partition leaf of a left-out table is refused", () => {
    // The leaf is left out because its parent is declared, so the kept table
    // pointing at it would dangle just the same.
    expect(() =>
      planBackupExclusions(
        linked([fk("log_readers", "log_2026_09")]),
        {
          tables: ["log"],
        },
        STRICT,
      ),
    ).toThrow(/"log_readers" links to "log_2026_09"/);
  });

  test("a link into an undeclared table is not a finding", () => {
    const plan = planBackupExclusions(
      linked([fk("drafts", "threads")]),
      {
        tables: ["log"],
      },
      STRICT,
    );
    expect(plan.unmatched).toEqual([]);
  });
});

describe("planBackupExclusions — lenient (a database on an older schema)", () => {
  test("keeps the linked table's rows and reports why", () => {
    const plan = planBackupExclusions(
      linked([fk("drafts", "threads")]),
      { tables: ["threads", "log"] },
      LENIENT,
    );
    expect(plan.excludedTables).toEqual(["log", "log_2026_09", "log_2026_10"]);
    expect(plan.keptForLinks).toEqual([
      {
        table: "threads",
        linkedFrom: "drafts",
        constraint: "drafts_threads_fk",
      },
    ]);
    expect(plan.unmatched).toEqual([]);
  });

  test("follows the chain: keeping a table can force the table it links to", () => {
    // drafts (kept) → threads (declared) → messages (declared). Keeping
    // threads makes its own link into messages a kept → left-out link.
    const plan = planBackupExclusions(
      linked([fk("drafts", "threads"), fk("threads", "messages")]),
      { tables: ["threads", "messages"] },
      LENIENT,
    );
    expect(plan.excludedTables).toEqual([]);
    expect(plan.keptForLinks.map((k) => k.table)).toEqual([
      "threads",
      "messages",
    ]);
  });

  test("a link to a partition leaf keeps the whole partitioned table", () => {
    const plan = planBackupExclusions(
      linked([fk("log_readers", "log_2026_09")]),
      { tables: ["log"] },
      LENIENT,
    );
    expect(plan.excludeTableData).toEqual([]);
    expect(plan.keptForLinks).toEqual([
      {
        table: "log",
        linkedFrom: "log_readers",
        constraint: "log_readers_log_2026_09_fk",
      },
    ]);
  });

  test("two links into one table keep it once per link, in one round", () => {
    const plan = planBackupExclusions(
      linked([fk("drafts", "threads"), fk("accounts", "threads")]),
      { tables: ["threads"] },
      LENIENT,
    );
    expect(plan.excludedTables).toEqual([]);
    expect(plan.keptForLinks.map((k) => k.linkedFrom).sort()).toEqual([
      "accounts",
      "drafts",
    ]);
  });

  test("nothing links: identical to strict, nothing kept", () => {
    const catalog = linked([fk("messages", "threads")]);
    const tables = { tables: ["threads", "messages"] };
    const plan = planBackupExclusions(catalog, tables, LENIENT);
    expect(plan).toEqual(planBackupExclusions(catalog, tables, STRICT));
    expect(plan.keptForLinks).toEqual([]);
  });
});
