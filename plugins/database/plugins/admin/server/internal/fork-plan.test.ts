/**
 * The fork's rules about its own exclusion set, checked against a hand-built
 * catalog.
 *
 * No database: `planForkExclusions` is pure precisely so this suite can exist
 * here. `admin` cannot import `db-test-fixture` — the fixture imports `admin`,
 * so a test edge back would close an R6 cycle — and the rules are about the
 * SHAPE of a catalog, which a literal states more legibly than a live database
 * ever could. `readSchemaCatalog`'s one SQL statement is exercised by every
 * real fork.
 *
 * The catalog below is main's real `graphile_worker` and `public` schemas, plus
 * a hypothetical `ext*` family standing in for any service that owns a set of
 * schemas: its mixed-case table names and the `/` inside a schema name are why
 * the emitted patterns have to be quoted.
 *
 * KNOW WHAT THIS SUITE CANNOT SEE. A hand-built catalog is a well-formed one, so
 * nothing here can catch `readSchemaCatalog` handing the planner the wrong SHAPE
 * — and it did exactly that once: `array_agg(relname)` produces `name[]`, which
 * `pg` has no decoder for, so `tables` arrived as the raw literal string
 * `"{_private_jobs,…}"` and the planner iterated it one character at a time.
 * Every emitted pattern matched nothing, `pg_dump` said nothing, and the fork
 * copied the whole `graphile_worker` schema. It took a real fork to find. The
 * `::text` casts and the `CatalogRowSchema` parse in `catalog-plan.ts` are the
 * standing answer; verification of that half is a real fork, not this file.
 *
 * Run: `./equin test plugins/database/plugins/admin`
 */

import { describe, test, expect } from "bun:test";
import {
  describeUndeclaredSchema,
  ForkPlanError,
  planForkExclusions,
  type SchemaCatalog,
} from "./fork-plan";
import type { CatalogForeignKey } from "./catalog-plan";

function schema(
  name: string,
  tables: string[],
  extra: {
    bytes?: number;
    fromExtension?: boolean;
    partitions?: Record<string, string[]>;
    foreignKeys?: CatalogForeignKey[];
  } = {},
) {
  return {
    name,
    tables,
    partitions: extra.partitions ?? {},
    foreignKeys: extra.foreignKeys ?? [],
    bytes: extra.bytes ?? 1_000_000,
    fromExtension: extra.fromExtension ?? false,
  };
}

/**
 * Main's schemas, trimmed to the tables the assertions talk about, plus the
 * hypothetical `ext*` family.
 */
const CATALOG: SchemaCatalog = {
  schemas: [
    schema("graphile_worker", [
      "_private_job_queues",
      "_private_jobs",
      "_private_known_crontabs",
      "_private_tasks",
      "migrations",
    ]),
    schema("public", ["tasks", "traces", "mail_messages"]),
    schema("ext", ["permissions"]),
    schema("ext_0", ["clients", "publishedSchema", "versionHistory"]),
    schema("ext_0/log", ["changeLog", "replicationState"]),
    schema("ext_0/state", ["rowsVersion"]),
  ],
};

/**
 * The declarations this repo ships, plus one for the `ext*` family that keeps
 * nothing.
 */
const DECLARED = {
  tables: ["traces", "mail_messages"],
  schemas: [
    { schema: "graphile_worker", keep: ["migrations"] },
    { schema: "ext*", keep: [] },
  ],
};

describe("planForkExclusions — what it emits", () => {
  test("a keep-list is enumerated; keeping nothing is one dump-time wildcard", () => {
    const plan = planForkExclusions(CATALOG, DECLARED);
    expect(plan.unmatched).toEqual([]);
    expect(plan.undeclaredSchemas).toEqual([]);
    expect([...plan.excludeTableData].sort()).toEqual(
      [
        // graphile keeps `migrations`, so its tables are named one by one.
        '"graphile_worker"."_private_job_queues"',
        '"graphile_worker"."_private_jobs"',
        '"graphile_worker"."_private_known_crontabs"',
        '"graphile_worker"."_private_tasks"',
        // `ext*` keeps nothing, so each MATCHED schema collapses to `.*` — the
        // schema name still comes from the catalog, but the relation set is
        // resolved by pg_dump at dump time, closing the window in which a
        // service creates a table after we read the catalog.
        '"ext".*',
        '"ext_0".*',
        '"ext_0/log".*',
        '"ext_0/state".*',
        '"public"."mail_messages"',
        '"public"."traces"',
      ].sort(),
    );
  });

  test("the kept table is the one thing absent from the arguments", () => {
    const plan = planForkExclusions(CATALOG, DECLARED);
    expect(plan.excludeTableData).not.toContain(
      '"graphile_worker"."migrations"',
    );
  });

  test("mixed-case and slashed names are quoted, so pg_dump does not case-fold them", () => {
    // Unquoted, `ext_0.changeLog` folds to `ext_0.changelog` and matches
    // nothing at all — the silent miss this design exists to remove.
    const plan = planForkExclusions(CATALOG, {
      tables: [],
      schemas: [{ schema: "ext_0/log", keep: ["replicationState"] }],
    });
    expect(plan.excludeTableData).toEqual(['"ext_0/log"."changeLog"']);
  });

  test("a declared table that is partitioned expands to its leaves", () => {
    // `--exclude-table-data` does not cascade to partitions, and a partition's
    // rows are dumped under the LEAF's name — so naming only the parent would
    // exclude nothing at all.
    const partitioned: SchemaCatalog = {
      schemas: [
        schema("public", ["traces", "traces_2026_07", "traces_2026_08"], {
          partitions: { traces: ["traces_2026_07", "traces_2026_08"] },
        }),
      ],
    };
    const plan = planForkExclusions(partitioned, {
      tables: ["traces"],
      schemas: [],
    });
    expect([...plan.excludeTableData].sort()).toEqual([
      '"public"."traces"',
      '"public"."traces_2026_07"',
      '"public"."traces_2026_08"',
    ]);
  });

  test("every name in an emitted argument came from the catalog", () => {
    // The property the whole design rests on: no author-written pattern reaches
    // pg_dump, so a stale or over-narrow pattern cannot silently match nothing.
    const schemas = new Set(CATALOG.schemas.map((s) => `"${s.name}"`));
    const relations = new Set(
      CATALOG.schemas.flatMap((s) => s.tables.map((t) => `"${s.name}"."${t}"`)),
    );
    for (const arg of planForkExclusions(CATALOG, DECLARED).excludeTableData) {
      const wildcard = arg.endsWith(".*");
      expect(
        wildcard ? schemas.has(arg.slice(0, -2)) : relations.has(arg),
      ).toBe(true);
    }
  });
});

describe("planForkExclusions — what it refuses", () => {
  test("two declarations matching one schema are fatal", () => {
    const overlapping = {
      ...DECLARED,
      schemas: [
        { schema: "graphile_worker", keep: ["migrations"] },
        { schema: "ext*", keep: [] },
        { schema: "ext_0", keep: ["clients"] },
      ],
    };
    expect(() => planForkExclusions(CATALOG, overlapping)).toThrow(/ambiguous/);
  });

  test("a keep entry naming no table is fatal", () => {
    const typo = {
      ...DECLARED,
      schemas: [
        { schema: "graphile_worker", keep: ["migration"] },
        { schema: "ext*", keep: [] },
      ],
    };
    expect(() => planForkExclusions(CATALOG, typo)).toThrow(/"migration"/);
  });

  test("both refusals name only mistakes in THIS repo, never source drift", () => {
    // The rules that throw are about the declarations disagreeing with
    // themselves or with a table they claim to preserve. Neither can be caused
    // by main's database growing a schema this checkout has not heard of —
    // that case is reported instead, below.
    expect(() => planForkExclusions(CATALOG, DECLARED)).not.toThrow();
  });
});

describe("planForkExclusions — a kept table linking to a left-out one", () => {
  function fk(table: string, references: string): CatalogForeignKey {
    return { table, constraint: `${table}_${references}_fk`, references };
  }
  function withLinks(
    foreignKeys: CatalogForeignKey[],
    partitions: Record<string, string[]> = {},
  ): SchemaCatalog {
    return {
      schemas: [
        schema(
          "public",
          [
            "tasks",
            "traces",
            "traces_2026_09",
            "mail_messages",
            "mail_threads",
            "mail_drafts",
          ],
          { foreignKeys, partitions },
        ),
      ],
    };
  }
  const MAIL = { tables: ["mail_messages", "mail_threads"], schemas: [] };

  test("is fatal, naming the source table, constraint and target", () => {
    const catalog = withLinks([fk("mail_drafts", "mail_threads")]);
    expect(() => planForkExclusions(catalog, MAIL)).toThrow(ForkPlanError);
    expect(() => planForkExclusions(catalog, MAIL)).toThrow(
      /table "mail_drafts" links to "mail_threads" through constraint "mail_drafts_mail_threads_fk"/,
    );
  });

  test("left out → left out, left out → kept and self-references are allowed", () => {
    const catalog = withLinks([
      fk("mail_messages", "mail_threads"),
      fk("mail_threads", "tasks"),
      fk("tasks", "tasks"),
      fk("mail_threads", "mail_threads"),
    ]);
    expect(() => planForkExclusions(catalog, MAIL)).not.toThrow();
  });

  test("a partition leaf of a left-out table counts as left out", () => {
    const catalog = withLinks([fk("tasks", "traces_2026_09")], {
      traces: ["traces_2026_09"],
    });
    expect(() =>
      planForkExclusions(catalog, { tables: ["traces"], schemas: [] }),
    ).toThrow(/"tasks" links to "traces_2026_09"/);
  });
});

describe("planForkExclusions — the schema nobody claimed", () => {
  test("is reported with its size, and does NOT stop the fork", () => {
    // The mistake this exists for: narrowing `ext*` to `ext_*` reads as safer
    // and silently drops the bare `ext` schema out of the exclusion set.
    const narrowed = {
      ...DECLARED,
      schemas: [
        { schema: "graphile_worker", keep: ["migrations"] },
        { schema: "ext_*", keep: [] },
      ],
    };
    const plan = planForkExclusions(CATALOG, narrowed);
    expect(plan.undeclaredSchemas.map((s) => s.schema)).toEqual(["ext"]);
    expect(
      plan.undeclaredSchemas.map(describeUndeclaredSchema).join("\n"),
    ).toContain("1.0 MB");
    // …and the fork still runs, with the schemas that ARE claimed excluded.
    expect(plan.excludeTableData).toContain('"ext_0".*');
    expect(plan.excludeTableData).not.toContain('"ext".*');
  });

  test("public and an extension's own schema are never reported", () => {
    const withExtension: SchemaCatalog = {
      schemas: [
        ...CATALOG.schemas,
        schema("cron", ["job", "job_run_details"], { fromExtension: true }),
      ],
    };
    expect(
      planForkExclusions(withExtension, DECLARED).undeclaredSchemas,
    ).toEqual([]);
  });

  test("a schema with no data-bearing relation is not reported either", () => {
    // Functions, types and enums only: nothing to copy, so nothing was decided
    // and nobody needs telling.
    const withTypesOnly: SchemaCatalog = {
      schemas: [...CATALOG.schemas, schema("app_enums", [])],
    };
    expect(
      planForkExclusions(withTypesOnly, DECLARED).undeclaredSchemas,
    ).toEqual([]);
  });
});

describe("planForkExclusions — what it merely reports", () => {
  test("a declaration matching nothing is reported, not fatal", () => {
    // Legitimate: a branch that adds a table together with its ExcludeFromFork
    // forks from a main whose database has not run that migration yet.
    const ahead = {
      tables: [...DECLARED.tables, "table_this_branch_adds"],
      schemas: [...DECLARED.schemas, { schema: "not_yet_started*", keep: [] }],
    };
    const plan = planForkExclusions(CATALOG, ahead);
    expect(plan.unmatched).toEqual([
      'schema pattern "not_yet_started*" matches no schema in the source database',
      'table "public.table_this_branch_adds" does not exist in the source database',
    ]);
    // …and the declarations that DO match are unaffected.
    expect(plan.excludeTableData).toContain('"public"."traces"');
  });

  test("a keep on a schema that is not there is reported, not fatal", () => {
    // Raising the keep rule here would be unactionable — the schema's absence
    // is the whole story, and the line above already says it.
    const plan = planForkExclusions(CATALOG, {
      tables: [],
      schemas: [
        { schema: "graphile_worker", keep: ["migrations"] },
        { schema: "ext*", keep: [] },
        { schema: "gone", keep: ["also_gone"] },
      ],
    });
    expect(plan.unmatched).toEqual([
      'schema pattern "gone" matches no schema in the source database',
    ]);
  });
});
