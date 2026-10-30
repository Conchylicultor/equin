// The REAL installed drizzle-kit, driven through its create-vs-rename prompt.
// Every other test here feeds the parser canned output; this one is what fails
// when a drizzle-kit release changes how its prompts can be driven (0.31.10
// refused every prompt without a TTY, and a bump to it passed every gate). The
// deps updater runs `./equin test`, so such a bump now fails its own task.
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, relative, resolve } from "path";
import {
  drizzleGenerateArgv,
  MIGRATIONS_PLUGIN_DIR,
} from "@plugins/database/plugins/migrations/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import {
  runDrizzleKitWithPrompts,
  type MigrationAnswer,
} from "./migrations-interactive";

// The schema file lives outside the repo, so it imports pg-core by absolute path.
const PG_CORE = Bun.fileURLToPath(import.meta.resolve("drizzle-orm/pg-core"));

const schemaWith = (column: string) =>
  `import { pgTable, text } from ${JSON.stringify(PG_CORE)};\n` +
  `export const t = pgTable("t", { id: text("id").primaryKey(), ${column}: text("${column}") });\n`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// The cwd must be the migrations plugin, so `bun x` finds the installed binary.
const CWD = resolve(REPO_ROOT, MIGRATIONS_PLUGIN_DIR);

function generate(dir: string, answers: MigrationAnswer[] | null) {
  return runDrizzleKitWithPrompts({
    cmd: drizzleGenerateArgv({ configPath: join(dir, "drizzle.config.ts") }),
    cwd: CWD,
    answers,
  });
}

/** A project whose snapshot holds `t.a`, and whose schema now has `t.b` instead. */
async function columnSwapped(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "drizzle-prompt-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "drizzle.config.ts"),
    `export default ${JSON.stringify({
      dialect: "postgresql",
      schema: join(dir, "schema.ts"),
      // drizzle-kit reads its snapshots at `./${out}/…`, so `out` must be
      // relative to the cwd (an absolute one is not found, and it exits 0).
      out: relative(CWD, join(dir, "out")),
      dbCredentials: { url: "postgres://codegen@codegen.invalid/codegen" },
    })};\n`,
  );
  writeFileSync(join(dir, "schema.ts"), schemaWith("a"));
  const first = await generate(dir, null);
  expect(first.exitCode).toBe(0);
  expect(first.detectedPrompts).toEqual([]);
  writeFileSync(join(dir, "schema.ts"), schemaWith("b"));
  return dir;
}

function latestSql(dir: string): string {
  const out = join(dir, "out");
  const files = readdirSync(out)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  expect(files.length).toBe(2);
  return readFileSync(join(out, files.at(-1)!), "utf8");
}

describe("runDrizzleKitWithPrompts on the installed drizzle-kit", () => {
  test("detect mode sees the column prompt with its rename source", async () => {
    const r = await generate(await columnSwapped(), null);
    expect(r.stdoutBuf + r.stderrBuf).not.toContain("require a TTY");
    expect(r.exitCode).toBe(0);
    expect(r.detectedPrompts).toHaveLength(1);
    const [p] = r.detectedPrompts;
    expect(p!.entityType).toBe("column");
    expect(p!.entityName).toBe("b");
    expect(p!.context).toBe("t");
    expect(p!.options.map((o) => o.action)).toEqual(["create", "rename"]);
    expect(p!.options[1]!.fromName).toBe("a");
  }, 60_000);

  test("a rename answer renames the column", async () => {
    const dir = await columnSwapped();
    const r = await generate(dir, [{ action: "rename", from: "a" }]);
    expect(r.exitCode).toBe(0);
    expect(r.detectedPrompts).toHaveLength(1);
    expect(latestSql(dir)).toContain('RENAME COLUMN "a" TO "b"');
  }, 60_000);

  test("a create answer drops the old column and adds the new one", async () => {
    const dir = await columnSwapped();
    const r = await generate(dir, [{ action: "create" }]);
    expect(r.exitCode).toBe(0);
    const sql = latestSql(dir);
    expect(sql).toContain('DROP COLUMN "a"');
    expect(sql).toContain('ADD COLUMN "b"');
    expect(sql).not.toContain("RENAME");
  }, 60_000);
});
