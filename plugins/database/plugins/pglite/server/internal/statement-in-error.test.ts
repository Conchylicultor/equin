import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { createPgliteDriver } from "./pglite-driver";

// A failed statement's error names the statement, so a crash report filed
// from a browser host's boot says which of its statements failed — not only
// what Postgres said (report-1795156708-k37rzk: "ERRORDATA_STACK_SIZE
// exceeded", nothing else). The error stays PGlite's own: callers branch on
// its `code`.
//
// In a FRESH bun process (this file, re-run as a child), as every PGlite suite
// here: PGlite picks its environment from `typeof window`, which an earlier
// suite in the shared process may have stubbed.

setDefaultTimeout(60_000);

const IN_CHILD = process.env.PGLITE_STATEMENT_ERROR_CHILD === "1";

if (!IN_CHILD) {
  test("a failed statement's error names it (in a fresh process)", async () => {
    const result = await spawnCaptured(
      [process.execPath, "test", import.meta.path],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, PGLITE_STATEMENT_ERROR_CHILD: "1" },
        timeoutMs: 55_000,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `child exited ${result.exitCode}\n${result.stdout}\n${result.stderr}`,
      );
    }
  });
}

async function failure(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (err) {
    if (err instanceof Error) return err;
    throw err;
  }
  throw new Error("expected the statement to fail");
}

describe.if(IN_CHILD)("a failed statement on PGlite", () => {
  const driver = createPgliteDriver();

  test("a script (no parameters) names the script, keeping the code", async () => {
    const err = await failure(() =>
      driver.db().execute(sql.raw("SELECT 1;\n  SELECT * FROM no_such_table")),
    );
    expect(err.message).toContain('relation "no_such_table" does not exist');
    expect(err.message).toContain(
      "in statement: SELECT 1; SELECT * FROM no_such_table",
    );
    expect((err as Error & { code?: string }).code).toBe("42P01");
  });

  test("a parameterized query names its text", async () => {
    const err = await failure(() =>
      driver.db().execute(sql`SELECT * FROM missing_table WHERE x = ${1}`),
    );
    expect(err.message).toContain(
      "in statement: SELECT * FROM missing_table WHERE x = $1",
    );
  });

  test("a long statement is cut short", async () => {
    const long = `SELECT ${"1 + ".repeat(400)}* FROM nowhere`;
    const err = await failure(() => driver.db().execute(sql.raw(long)));
    const named = err.message.split("in statement: ")[1] ?? "";
    expect(named.endsWith("…")).toBe(true);
    expect(named.length).toBe(301);
  });
});
