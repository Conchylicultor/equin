import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  journalEntriesForSqlFiles,
  phaseGeneratedMigrations,
  promptKey,
  regenerateJournal,
  resolveAnswer,
  type DetectedPrompt,
  type MigrationAnswer,
} from "./migrations";

function tablePrompt(name: string, fromName?: string): DetectedPrompt {
  const options: DetectedPrompt["options"] = [
    { index: 0, action: "create", label: `+ ${name} create` },
  ];
  if (fromName) {
    options.push({
      index: 1,
      action: "rename",
      label: `~ ${fromName} › ${name} rename`,
      fromName,
    });
  }
  return {
    index: 0,
    entityType: "table",
    entityName: name,
    context: null,
    question: `Is ${name} table created or renamed from another table?`,
    options,
  };
}

function columnPrompt(
  table: string,
  col: string,
  fromName?: string,
): DetectedPrompt {
  const options: DetectedPrompt["options"] = [
    { index: 0, action: "create", label: `+ ${col} create` },
  ];
  if (fromName) {
    options.push({
      index: 1,
      action: "rename",
      label: `~ ${fromName} › ${col} rename`,
      fromName,
    });
  }
  return {
    index: 0,
    entityType: "column",
    entityName: col,
    context: table,
    question: `Is ${col} column in ${table} table created or renamed from another column?`,
    options,
  };
}

function enumPrompt(name: string): DetectedPrompt {
  return {
    index: 0,
    entityType: "enum",
    entityName: name,
    context: null,
    question: `Is ${name} enum created or renamed from another enum?`,
    options: [{ index: 0, action: "create", label: `+ ${name} create` }],
  };
}

describe("promptKey", () => {
  test("table prompt → table:<name>", () => {
    expect(promptKey(tablePrompt("staged_config_default"))).toBe(
      "table:staged_config_default",
    );
  });

  test("column prompt → column:<table>.<name>", () => {
    expect(promptKey(columnPrompt("tasks", "priority"))).toBe(
      "column:tasks.priority",
    );
  });

  test("enum prompt → enum:<name>", () => {
    expect(promptKey(enumPrompt("task_status"))).toBe("enum:task_status");
  });
});

describe("resolveAnswer (keyed replay)", () => {
  test("create resolves to option index 0", () => {
    const prompt = tablePrompt(
      "staged_config_default",
      "reorder_staged_default",
    );
    const answer: MigrationAnswer = { action: "create" };
    expect(resolveAnswer(prompt, answer)).toBe(0);
  });

  test("rename resolves to the matching option index", () => {
    const prompt = tablePrompt(
      "staged_config_default",
      "reorder_staged_default",
    );
    const answer: MigrationAnswer = {
      action: "rename",
      from: "reorder_staged_default",
    };
    expect(resolveAnswer(prompt, answer)).toBe(1);
  });

  test("keyed map lookup → resolveAnswer returns the right index", () => {
    const prompt = tablePrompt("b", "a");
    const keyed = new Map<string, MigrationAnswer>([
      [promptKey(prompt), { action: "rename", from: "a" }],
    ]);
    const a = keyed.get(promptKey(prompt));
    expect(a).toBeDefined();
    expect(resolveAnswer(prompt, a!)).toBe(1);
  });

  test("stale rename source not in options → throws (keyed path catches → unanswered)", () => {
    // The branch authored a rename from "old_a", but after rebase the prompt no
    // longer offers that source. resolveAnswer must throw so the keyed path can
    // mark it unanswered rather than silently picking a wrong option.
    const prompt = tablePrompt("b", "different_source");
    const answer: MigrationAnswer = { action: "rename", from: "old_a" };
    expect(() => resolveAnswer(prompt, answer)).toThrow(/rename from "old_a"/);
  });
});

// The journal is a pure re-encoding of the `.sql` filenames on disk, which is
// what lets `generateMigration` regenerate it unconditionally as a
// post-condition. These pin that property — the fix for a branch-local data
// migration losing its journal entry to the `regen-migrations` merge driver.
describe("journalEntriesForSqlFiles", () => {
  const QUOTE = "20260804_140946_d4f01c6e__quote_anchor_split";

  test("ignores names the migration format can't parse", () => {
    const entries = journalEntriesForSqlFiles([
      `${QUOTE}.sql`,
      "0NaN_add_foo.sql", // drizzle's raw output, pre-rename
      "0001_add_foo.sql", // drizzle's numbered output
      "README.md",
      "_journal.json",
    ]);
    expect(entries.map((e) => e.tag)).toEqual([QUOTE]);
  });

  test("derives `when` from the filename timestamp as UTC", () => {
    // Anchored on the real regression: the entry the rebase dropped and
    // d27cad7af restored by hand. If this drifts, the journal stops being
    // byte-reproducible from the filenames and every rebase re-diffs it.
    const [entry] = journalEntriesForSqlFiles([`${QUOTE}.sql`]);
    expect(entry!.when).toBe(Date.UTC(2026, 7, 4, 14, 9, 46));
    expect(entry!.when).toBe(1785852586000);
  });

  test("emits drizzle's entry shape, and NO idx field", () => {
    // drizzle computes `idx = lastEntry.idx + 1`; with no idx that is NaN and it
    // prefixes fresh files `0NaN_`, which DRIZZLE_FORMAT is written to accept.
    // Adding idx here would silently switch it back to numbered prefixes.
    const [entry] = journalEntriesForSqlFiles([`${QUOTE}.sql`]);
    expect(entry).toEqual({
      version: "7",
      when: 1785852586000,
      tag: QUOTE,
      hash: "d4f01c6e",
      breakpoints: true,
    });
    expect(Object.keys(entry!)).not.toContain("idx");
  });

  test("orders by full filename, so a same-second pair breaks ties on hash", () => {
    const a = "20260804_140946_00000001__a";
    const b = "20260804_140946_ffffffff__b";
    const entries = journalEntriesForSqlFiles([`${b}.sql`, `${a}.sql`]);
    expect(entries.map((e) => e.tag)).toEqual([a, b]);
  });

  test("gives a snapshot-less data migration an entry like any other", () => {
    // J ⊆ N is deliberately NOT an invariant: backfills carry no snapshot but
    // must still be journalled, or they read as orphan .sql files.
    const entries = journalEntriesForSqlFiles([`${QUOTE}.sql`]);
    expect(entries).toHaveLength(1);
  });
});

describe("regenerateJournal", () => {
  function withDataDir(run: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "sing-journal-"));
    try {
      mkdirSync(join(dir, "meta"));
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const readTags = (dir: string): string[] =>
    (
      JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as {
        entries: Array<{ tag: string }>;
      }
    ).entries.map((e) => e.tag);

  test("re-adds an entry the merge driver dropped, and is idempotent", () => {
    // Exactly the post-rebase state: both .sql files on disk, but the journal
    // resolved in main's favour so the branch-local one has no entry.
    withDataDir((dir) => {
      const mine = "20260804_140946_d4f01c6e__quote_anchor_split";
      const theirs = "20260805_085453_661b3e79__merged_20260805_0854";
      writeFileSync(join(dir, `${mine}.sql`), "SELECT 1;\n");
      writeFileSync(join(dir, `${theirs}.sql`), "SELECT 2;\n");
      writeFileSync(
        join(dir, "meta", "_journal.json"),
        JSON.stringify({
          version: "7",
          dialect: "postgresql",
          entries: journalEntriesForSqlFiles([`${theirs}.sql`]),
        }),
      );

      regenerateJournal(dir);
      expect(readTags(dir)).toEqual([mine, theirs]);

      const first = readFileSync(join(dir, "meta", "_journal.json"), "utf8");
      regenerateJournal(dir);
      expect(readFileSync(join(dir, "meta", "_journal.json"), "utf8")).toBe(
        first,
      );
    });
  });

  test("drops the orphan 0NaN entry a discarded generation leaves behind", () => {
    // drizzle writes the journal BEFORE the .sql, so an aborted generation
    // leaves a `0NaN_<name>` row with no file — an orphanJournal failure.
    withDataDir((dir) => {
      const kept = "20260805_085453_661b3e79__merged_20260805_0854";
      writeFileSync(join(dir, `${kept}.sql`), "SELECT 1;\n");
      writeFileSync(
        join(dir, "meta", "_journal.json"),
        JSON.stringify({
          version: "7",
          dialect: "postgresql",
          entries: [
            ...journalEntriesForSqlFiles([`${kept}.sql`]),
            { version: "7", when: 0, tag: "0NaN_add_foo", breakpoints: true },
          ],
        }),
      );

      regenerateJournal(dir);
      expect(readTags(dir)).toEqual([kept]);
    });
  });

  test("writes a trailing newline and 2-space indent (byte-stable in git)", () => {
    withDataDir((dir) => {
      writeFileSync(
        join(dir, "20260804_140946_d4f01c6e__x.sql"),
        "SELECT 1;\n",
      );
      regenerateJournal(dir);
      const raw = readFileSync(join(dir, "meta", "_journal.json"), "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(raw).toContain('\n  "version": "7"');
    });
  });
});

// The phasing step on a synthetic data/ dir: the fresh drizzle output is
// rewritten in place (before renameMigrations hashes it), and claims every
// branch-local data migration no other branch-local schema migration claims.
describe("phaseGeneratedMigrations", () => {
  const MAIN_DATA = "20260801_000000_aaaaaaaa__on_main_backfill";
  const OLD_DATA = "20260901_000000_bbbbbbbb__claimed_already";
  const PRIOR_SCHEMA = "20260901_000100_cccccccc__prior_schema";
  const NEW_DATA = "20260902_000000_dddddddd__remap_icons";

  function withDataDir(run: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "sing-phase-"));
    try {
      mkdirSync(join(dir, "meta"));
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function schemaFile(dir: string, tag: string, body: string): void {
    writeFileSync(join(dir, `${tag}.sql`), body);
    writeFileSync(join(dir, "meta", `${tag}_snapshot.json`), "{}");
  }

  test("phases the fresh file and claims only unclaimed branch-local data migrations", () => {
    withDataDir((dir) => {
      writeFileSync(join(dir, `${MAIN_DATA}.sql`), "UPDATE a SET b = 1;\n");
      writeFileSync(join(dir, `${OLD_DATA}.sql`), "UPDATE a SET b = 2;\n");
      writeFileSync(join(dir, `${NEW_DATA}.sql`), "UPDATE a SET b = 3;\n");
      schemaFile(
        dir,
        PRIOR_SCHEMA,
        "-- singularity:phase expand\n-- singularity:phase contract\n-- singularity:claims\n-- 20260901_000000__claimed_already\n",
      );
      const fresh =
        'ALTER TABLE "agents" ADD COLUMN "icon" text NOT NULL;--> statement-breakpoint\nALTER TABLE "agents" DROP COLUMN IF EXISTS "icon_svg_nodes";';
      writeFileSync(join(dir, "0NaN_swap_icons.sql"), fresh);

      phaseGeneratedMigrations(dir, new Set([`${MAIN_DATA}.sql`]), null);

      expect(readFileSync(join(dir, "0NaN_swap_icons.sql"), "utf8")).toBe(
        [
          "-- singularity:phase expand",
          'ALTER TABLE "agents" ADD COLUMN "icon" text;',
          "-- singularity:phase contract",
          'ALTER TABLE "agents" ALTER COLUMN "icon" SET NOT NULL;',
          'ALTER TABLE "agents" DROP COLUMN IF EXISTS "icon_svg_nodes";',
          "-- singularity:claims",
          "-- 20260902_000000__remap_icons",
          "",
        ].join("\n"),
      );
    });
  });

  test("leaves every already-named file untouched", () => {
    withDataDir((dir) => {
      writeFileSync(join(dir, `${NEW_DATA}.sql`), "UPDATE a SET b = 3;\n");
      phaseGeneratedMigrations(dir, new Set(), null);
      expect(readFileSync(join(dir, `${NEW_DATA}.sql`), "utf8")).toBe(
        "UPDATE a SET b = 3;\n",
      );
    });
  });

  test("throws, naming the statement, when the table rejects one", () => {
    withDataDir((dir) => {
      const fresh = 'DROP VIEW "public"."agents_v";';
      writeFileSync(join(dir, "0NaN_bad.sql"), fresh);
      expect(() => phaseGeneratedMigrations(dir, new Set(), null)).toThrow(
        /DROP VIEW "public"\."agents_v"/,
      );
      expect(readFileSync(join(dir, "0NaN_bad.sql"), "utf8")).toBe(fresh);
    });
  });
});
