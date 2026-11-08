import { beforeAll, describe, expect, test } from "bun:test";
import { loadModule } from "libpg-query";
import { LIVE_STATE_CHANGELOG_TABLE } from "@plugins/database/plugins/derived-views/core";
import { SchemaModel } from "./model";
import type { ProbeOutput, ResolvedRef } from "./probe-types";
import type { Hole, SqlSite } from "./sites";
import { parseSite } from "./statements";
import { validateStatements, writesIn } from "./validate";

beforeAll(async () => {
  await loadModule();
});

// The stop row and its checkpoint, as the probe reports them
// (conversations_ext_sdk_agent_stop: updated_at derived by its touchedBy trigger).
const PROBE: ProbeOutput = {
  tables: [
    {
      schema: "public",
      name: "conversations_ext_sdk_agent_stop",
      file: "/repo/tables.ts",
      columns: [
        { name: "parent_id", required: true, unwritten: null },
        { name: "stopped_at", required: false, unwritten: null },
        { name: "stop_error", required: false, unwritten: null },
        { name: "account", required: false, unwritten: null },
        { name: "created_at", required: false, unwritten: null },
        {
          name: "updated_at",
          required: false,
          unwritten: "derived-updated-at",
        },
      ],
    },
    {
      schema: "public",
      name: "conversations_ext_sdk_agent",
      file: "/repo/tables.ts",
      columns: [
        { name: "parent_id", required: true, unwritten: null },
        { name: "worktree_path", required: true, unwritten: null },
        {
          name: "updated_at",
          required: false,
          unwritten: "derived-updated-at",
        },
      ],
    },
    {
      schema: "public",
      name: "job_runs",
      file: "/repo/jobs.ts",
      columns: [
        { name: "id", required: false, unwritten: "generated" },
        { name: "job_name", required: true, unwritten: null },
      ],
    },
  ],
  imperative: [LIVE_STATE_CHANGELOG_TABLE],
  refs: {},
  loadFailures: [],
};

const STOPS: ResolvedRef = {
  kind: "table",
  schema: "public",
  name: "conversations_ext_sdk_agent_stop",
};
const AGENTS: ResolvedRef = {
  kind: "table",
  schema: "public",
  name: "conversations_ext_sdk_agent",
};

/** A site from a template's static parts, its holes resolved as `refs` say. */
function site(
  strings: TemplateStringsArray,
  ...holes: (ResolvedRef | Hole)[]
): { site: SqlSite; refs: (i: number) => ResolvedRef | undefined } {
  const asHole = (h: ResolvedRef | Hole): Hole =>
    "kind" in h &&
    (h.kind === "text" || h.kind === "ident" || h.kind === "opaque")
      ? (h as Hole)
      : {
          kind: "export",
          ref: { file: "/repo/tables.ts", exportName: "x", path: [] },
        };
  return {
    site: {
      file: "f.ts",
      line: 1,
      tagged: true,
      chunks: [...strings],
      holes: holes.map(asHole),
    },
    refs: (i) => {
      const h = holes[i];
      return h &&
        (h.kind === "table" || h.kind === "column" || h.kind === "string")
        ? (h as ResolvedRef)
        : undefined;
    },
  };
}

function issuesOf(s: ReturnType<typeof site>) {
  const parsed = parseSite(s.site, s.refs);
  if (parsed.kind !== "parsed")
    throw new Error(`did not parse: ${parsed.error}`);
  const model = SchemaModel.fromProbe(PROBE, (f) => f);
  return validateStatements(parsed.stmts, model).map((i) => i.kind);
}

const opaque = (expr: string): Hole => ({ kind: "opaque", expr });

describe("the 2026-11-08 crash loop (stopUpsert, 70c82060b3)", () => {
  test("its original statement is refused: it writes the derived updated_at", () => {
    // Verbatim from 70c82060b3's rows.ts, the holes as they were.
    const s = site`INSERT INTO ${STOPS} ("parent_id", "stopped_at", "stop_error", "account")
    SELECT "parent_id", ${opaque("stop.stoppedAt")}::timestamptz, ${opaque("stop.stopError")}::text, ${opaque("stop.account")}::text
    FROM ${AGENTS} WHERE "parent_id" = ${opaque("id")}
    ON CONFLICT ("parent_id") DO UPDATE SET
      "stopped_at" = EXCLUDED."stopped_at",
      "stop_error" = EXCLUDED."stop_error",
      "account" = EXCLUDED."account",
      "updated_at" = now()`;
    expect(issuesOf(s)).toEqual(["derived"]);
  });

  test("the fixed statement (2baf0e2a3b) passes", () => {
    const s = site`INSERT INTO ${STOPS} ("parent_id", "stopped_at", "stop_error", "account")
    SELECT "parent_id", ${opaque("a")}::timestamptz, ${opaque("b")}::text, ${opaque("c")}::text
    FROM ${AGENTS} WHERE "parent_id" = ${opaque("id")}
    ON CONFLICT ("parent_id") DO UPDATE SET
      "stopped_at" = EXCLUDED."stopped_at",
      "stop_error" = EXCLUDED."stop_error",
      "account" = EXCLUDED."account"`;
    expect(issuesOf(s)).toEqual([]);
  });
});

describe("writes against the declared schema", () => {
  test("a derived column in a plain UPDATE, inside a CTE", () => {
    const s = site`WITH w AS (UPDATE ${AGENTS} SET updated_at = now() WHERE parent_id = ${opaque("id")} RETURNING 1) SELECT 1`;
    expect(issuesOf(s)).toEqual(["derived"]);
  });

  test("a generated column in an INSERT", () => {
    const s = site`INSERT INTO job_runs (id, job_name) VALUES (${opaque("a")}, ${opaque("b")})`;
    expect(issuesOf(s)).toEqual(["derived"]);
  });

  test("an unknown table and an unknown column", () => {
    expect(
      issuesOf(site`DELETE FROM nowhere WHERE id = ${opaque("x")}`),
    ).toEqual(["unknown-table"]);
    expect(
      issuesOf(site`UPDATE ${STOPS} SET stoped_at = ${opaque("x")}`),
    ).toEqual(["unknown-column"]);
  });

  test("a column read off the target that does not exist", () => {
    expect(
      issuesOf(site`DELETE FROM ${STOPS} WHERE parent = ${opaque("x")}`),
    ).toEqual(["unknown-column"]);
    expect(
      issuesOf(
        site`UPDATE ${STOPS} s SET account = NULL WHERE s.nope = 1 RETURNING s.parent_id`,
      ),
    ).toEqual(["unknown-column"]);
  });

  test("an INSERT leaving out a required column, and one without a column list", () => {
    expect(
      issuesOf(
        site`INSERT INTO ${AGENTS} (parent_id) VALUES (${opaque("id")})`,
      ),
    ).toEqual(["missing-required"]);
    expect(
      issuesOf(
        site`INSERT INTO ${AGENTS} VALUES (${opaque("a")}, ${opaque("b")})`,
      ),
    ).toEqual(["positional-insert"]);
  });

  test("a table or column list the source does not spell is dynamic", () => {
    expect(issuesOf(site`DELETE FROM ${opaque("table")} WHERE id = 1`)).toEqual(
      ["dynamic"],
    );
    // `SET ${assignments}`: re-tried as an assignment list, then refused.
    expect(
      issuesOf(site`UPDATE ${STOPS} SET ${opaque("sets")} WHERE parent_id = 1`),
    ).toEqual(["dynamic"]);
  });

  test("clause-shaped holes still parse", () => {
    const s = site`WITH ${opaque("ctes")} INSERT INTO ${STOPS} (parent_id) ${opaque("select")} ON CONFLICT (parent_id) DO NOTHING`;
    const parsed = parseSite(s.site, s.refs);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind === "parsed") expect(writesIn(parsed.stmts)).toBe(1);
    expect(issuesOf(s)).toEqual([]);
  });

  test("an INSERT may give a derived updated_at (history); an UPDATE may not", () => {
    expect(
      issuesOf(
        site`INSERT INTO ${AGENTS} (parent_id, worktree_path, updated_at) VALUES (${opaque("a")}, ${opaque("b")}, ${opaque("at")})`,
      ),
    ).toEqual([]);
    expect(
      issuesOf(
        site`MERGE INTO ${AGENTS} a USING ${STOPS} s ON a.parent_id = s.parent_id WHEN MATCHED THEN UPDATE SET updated_at = now()`,
      ),
    ).toEqual(["derived"]);
  });

  test("DEFAULT VALUES still owes every required column", () => {
    expect(issuesOf(site`INSERT INTO ${AGENTS} DEFAULT VALUES`)).toEqual([
      "missing-required",
    ]);
  });

  test("a subquery re-binding the target's alias reads its own columns", () => {
    expect(
      issuesOf(
        site`DELETE FROM ${STOPS} t WHERE EXISTS (SELECT 1 FROM ${AGENTS} t WHERE t.worktree_path = 'x')`,
      ),
    ).toEqual([]);
    // Correlated (the alias not re-bound): still the target's, still checked.
    expect(
      issuesOf(
        site`DELETE FROM ${STOPS} t WHERE EXISTS (SELECT 1 FROM ${AGENTS} a WHERE a.parent_id = t.nope)`,
      ),
    ).toEqual(["unknown-column"]);
  });

  test("a table known only by name (imperative, generated DDL) skips column checks", () => {
    expect(
      issuesOf(site`INSERT INTO live_state_changelog (anything) VALUES (1)`),
    ).toEqual([]);
  });

  test("hand-written DDL declares a table", () => {
    const model = SchemaModel.fromProbe(PROBE, (f) => f);
    const ddl = parseSite(
      // (The table's IMPERATIVE_PUBLIC_TABLES constant, as a real create site names it.)
      site`CREATE TABLE IF NOT EXISTS ${{ kind: "text", text: LIVE_STATE_CHANGELOG_TABLE }} (id bigserial PRIMARY KEY, tbl text NOT NULL, note text)`
        .site,
      () => undefined,
    );
    if (ddl.kind !== "parsed") throw new Error("ddl did not parse");
    for (const s of ddl.stmts) model.applyCreate(s, "ddl.ts:1");
    const w = parseSite(
      site`INSERT INTO live_state_changelog (note, nope) VALUES (1, 2)`.site,
      () => undefined,
    );
    if (w.kind !== "parsed") throw new Error("write did not parse");
    expect(validateStatements(w.stmts, model).map((i) => i.kind)).toEqual([
      "unknown-column",
      "missing-required",
    ]);
  });
});
