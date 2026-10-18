import { afterEach, describe, it, expect } from "bun:test";
import {
  extractReadTablesFromSql,
  quotedRelationsIn,
  setKnownRelations,
} from "./read-set-capture";

// The quoted half of the read-set capture, with no relation set at all: what a
// raw-SQL compiler checks its rendered text against (a quoted CTE name would
// land in every read-set the query is captured under).
describe("quotedRelationsIn", () => {
  afterEach(() => setKnownRelations(null));

  it("returns the quoted FROM / JOIN names, deduped, in order of first appearance", () => {
    const sql =
      'select * from "tasks" t left join "attempts" a on a.task_id = t.id inner join "tasks" t2 on true';
    expect(quotedRelationsIn(sql)).toEqual(["tasks", "attempts"]);
  });

  it("ignores unquoted names whatever relation set is installed", () => {
    setKnownRelations(new Set(["tasks", "__agg"]));
    const sql =
      'with __agg as (select 1) select * from tasks join __agg on true join "pushes" p on true';
    expect(quotedRelationsIn(sql)).toEqual(["pushes"]);
  });

  it("reports a quoted CTE name — the spelling a raw shape must avoid", () => {
    const sql = 'with "__agg" as (select 1) select * from "__agg"';
    expect(quotedRelationsIn(sql)).toEqual(["__agg"]);
  });

  it("drops write targets and IS DISTINCT FROM operands, like the capture", () => {
    const sql =
      'delete from "notifications" where "a" is distinct from "b" and exists (select 1 from "reports")';
    expect(quotedRelationsIn(sql)).toEqual(["reports"]);
  });

  it("agrees with the capture's quoted branch when no relation set is installed", () => {
    setKnownRelations(null);
    const sql =
      'select * from "tasks" join attempts on true join "pushes" on true, lateral (select 1) x';
    expect(quotedRelationsIn(sql)).toEqual(extractReadTablesFromSql(sql));
  });
});

// A loader's read-set contains only tables it READS (FROM / JOIN). Write targets
// (INSERT INTO / UPDATE / DELETE) must never appear — they are foreign
// observability leaks captured under a loader's ambient context, never a genuine
// read dependency. These tests pin that invariant so a future regex change that
// re-admits write targets is caught here rather than as read-set attribution
// noise in the Debug → Read-set pane.
describe("extractReadTablesFromSql", () => {
  it("captures FROM and JOIN targets, dedups repeats, order-insensitive", () => {
    const sql =
      'select * from "attempts_v" a join "conversations_v" c on c.attempt_id = a.id join "conversations_v" c2 on c2.id = c.parent';
    expect(extractReadTablesFromSql(sql).sort()).toEqual(
      ["attempts_v", "conversations_v"].sort(),
    );
  });

  it("ignores INSERT INTO write targets", () => {
    const sql =
      'insert into "notifications" (id, title) values ($1, $2) on conflict (id) do update set title = $2';
    expect(extractReadTablesFromSql(sql)).toEqual([]);
  });

  it("ignores UPDATE write targets", () => {
    const sql = 'update "notifications" set read = true where id = $1';
    expect(extractReadTablesFromSql(sql)).toEqual([]);
  });

  it("ignores DELETE FROM write targets", () => {
    const sql = 'delete from "notifications" where id = $1';
    expect(extractReadTablesFromSql(sql)).toEqual([]);
  });

  it("captures reads inside a subquery", () => {
    const sql =
      'select * from "tasks_v" where id in (select task_id from "attempts_v")';
    expect(extractReadTablesFromSql(sql).sort()).toEqual(
      ["attempts_v", "tasks_v"].sort(),
    );
  });

  // The set of relations that really exist is a module-level singleton, installed
  // once at boot. Every case below that installs one must put it back, or the
  // last one installed would still be in force for the lane-partition and
  // transaction-lease tests further down this file.
  afterEach(() => {
    setKnownRelations(null);
  });

  // A hand-written sql`` template names its tables the way SQL is normally
  // written — unquoted. Before this, such a read recorded NOTHING, so the
  // resource served stale data with no error and no log: the chord trainer's
  // progress panel stopped updating after every saved round. These are the real
  // table names from that incident.
  it("captures unquoted FROM and JOIN targets that name real relations", () => {
    setKnownRelations(new Set(["chord_answers", "chord_rounds"]));
    const sql =
      "select count(*) from chord_answers a join chord_rounds r on r.id = a.round_id";
    expect(extractReadTablesFromSql(sql).sort()).toEqual(
      ["chord_answers", "chord_rounds"].sort(),
    );
  });

  // Widening to unquoted names means anything that can follow FROM is now a
  // candidate — CTE names, subquery aliases, correlation names. Keeping only the
  // ones that name a real relation is what stops those phantoms from reaching the
  // Debug → Read-set pane, which would otherwise flag every resource as a silent
  // FULL and destroy the one surface that spots this class of bug.
  it("drops an unquoted candidate that names no real relation", () => {
    setKnownRelations(new Set(["chord_answers"]));
    const sql =
      "with recent as (select 1) select * from recent join chord_answers on true";
    expect(extractReadTablesFromSql(sql)).toEqual(["chord_answers"]);
  });

  // The compiled SQL of a live loader: the page sidebar's doc-order walk
  // (plugins/page/plugins/editor/server/internal/page-doc-order.ts). Its
  // recursive term reads `FROM up u` — the CTE it is defining — and its stop
  // condition uses `IS DISTINCT FROM`. Only the real table may come out.
  it("captures only the real table from a recursive CTE, not its own alias", () => {
    setKnownRelations(new Set(["page_blocks", "pages"]));
    const sql = `
      WITH RECURSIVE up AS (
        SELECT b.id AS page_row_id, b.page_id, b.parent_id AS cursor,
               ARRAY[b.rank::text] AS path
        FROM "page_blocks" b
        WHERE b.type = $1 AND b.deleted_at IS NULL
        UNION ALL
        SELECT u.page_row_id, u.page_id, p.parent_id, p.rank::text || u.path
        FROM up u
        JOIN "page_blocks" p ON p.id = u.cursor AND p.deleted_at IS NULL
        WHERE u.cursor IS NOT NULL
          AND u.cursor IS DISTINCT FROM u.page_id
          AND array_length(u.path, 1) < 64
      )
      SELECT page_row_id, path FROM up WHERE cursor IS NULL OR cursor = page_id
    `;
    expect(extractReadTablesFromSql(sql)).toEqual(["page_blocks"]);
  });

  // `IS DISTINCT FROM` is Postgres's null-safe inequality operator, followed by an
  // expression — never a table. It matches `\bfrom\s+<identifier>` all the same,
  // and there are seven sites in this repo, one of them inside a live loader. The
  // known set here deliberately contains the identifiers that follow the operator,
  // so this case can only pass because the keyword is guarded — never by accident
  // because the relation filter happened to drop them.
  it("treats IS DISTINCT FROM as an operator, not a FROM clause", () => {
    setKnownRelations(new Set(["page_blocks", "u", "page_id"]));
    expect(
      extractReadTablesFromSql(
        "select 1 from page_blocks where cursor IS DISTINCT FROM page_id",
      ),
    ).toEqual(["page_blocks"]);
    expect(
      extractReadTablesFromSql(
        "select 1 where u.cursor IS DISTINCT FROM u.page_id",
      ),
    ).toEqual([]);
  });

  // What follows FROM is not always a name: it can be a set-returning function,
  // a LATERAL subquery, or a plain derived table. All three appear in the chord
  // progress loader this fix came from; none of them is a dependency.
  it("captures nothing from a function call, a LATERAL, or a derived table", () => {
    setKnownRelations(new Set(["chord_answers", "chord_rounds"]));
    const sql = `
      SELECT t.token, a.correct
      FROM unnest($1::text[]) WITH ORDINALITY AS t(token, ord)
      CROSS JOIN LATERAL (
        SELECT correct FROM (SELECT true AS correct) rows_only
      ) a
      ORDER BY t.ord
    `;
    expect(extractReadTablesFromSql(sql)).toEqual([]);
  });

  // The write-target exclusions above are pinned in their quoted spelling; they
  // must hold in the unquoted one too, or widening the match would start
  // recording a loader's incidental writes as read dependencies.
  it("ignores unquoted write targets (DELETE FROM / INSERT INTO / UPDATE)", () => {
    setKnownRelations(new Set(["chord_answers", "notifications"]));
    expect(
      extractReadTablesFromSql(
        "delete from chord_answers where answered_at < $1",
      ),
    ).toEqual([]);
    expect(
      extractReadTablesFromSql(
        "insert into notifications (id, title) values ($1, $2)",
      ),
    ).toEqual([]);
    expect(
      extractReadTablesFromSql(
        "update notifications set read = true where id = $1",
      ),
    ).toEqual([]);
  });

  // A single statement mixes both spellings whenever a raw sql`` template
  // interpolates a drizzle table object (which renders quoted) beside a
  // hand-written name. Both are dependencies, and naming one table twice in two
  // spellings must still yield one entry.
  it("captures quoted and unquoted names in one statement, deduped", () => {
    setKnownRelations(new Set(["chord_answers", "chord_rounds"]));
    const sql =
      'select * from chord_answers a join "chord_rounds" r on r.id = a.round_id ' +
      'join "chord_answers" b on b.round_id = r.id where b.token in (select token from chord_answers)';
    expect(extractReadTablesFromSql(sql).sort()).toEqual(
      ["chord_answers", "chord_rounds"].sort(),
    );
  });

  // The change-feed names a changed table by its bare `TG_TABLE_NAME`, so a
  // `public.`-qualified read must land on the same key or the write would never
  // route to the resource. A read in ANY other schema is dropped whole: the feed
  // structurally excludes those schemas, so recording one would add a dependency
  // that can never fire — which the Debug pane then reports as a silent FULL.
  // The jobs list below is the real loader that reads outside `public`; it drives
  // its own notify() and must contribute nothing here.
  it("reduces a public-qualified name and drops every other schema", () => {
    setKnownRelations(new Set(["tasks", "attempts"]));
    expect(
      extractReadTablesFromSql(
        "select * from public.tasks t join public.attempts a on a.task_id = t.id",
      ).sort(),
    ).toEqual(["attempts", "tasks"].sort());

    const jobsList = `
      SELECT j.id::text AS id, t.identifier AS task_identifier, j.payload
        FROM graphile_worker._private_jobs j
        JOIN graphile_worker._private_tasks t ON t.id = j.task_id
   LEFT JOIN graphile_worker._private_job_queues q ON q.id = j.job_queue_id
       ORDER BY j.run_at DESC
    `;
    expect(extractReadTablesFromSql(jobsList)).toEqual([]);
  });

  // `FROM ONLY tasks` excludes a partitioned table's children. Without the strip
  // it would record the keyword `ONLY` and miss the table entirely — the exact
  // silent miss this change exists to remove, so it is pinned before anyone
  // writes one.
  it("strips a leading ONLY and keeps the table behind it", () => {
    setKnownRelations(new Set(["tasks"]));
    expect(extractReadTablesFromSql("select * from only tasks")).toEqual([
      "tasks",
    ]);
  });

  // Two windows have no relation set: the boot window before it is loaded, and
  // the central runtime, which never touches this pool. In both, behaviour must
  // be byte-identical to what it was before unquoted names were matched at all —
  // quoted captured, unquoted dropped. A loader that ran in that window heals on
  // its next full recompute, because the recorded read-set replaces rather than
  // unions.
  it("drops every unquoted name when no relation set is installed", () => {
    setKnownRelations(null);
    const sql =
      'select * from chord_answers a join "chord_rounds" r on r.id = a.round_id';
    expect(extractReadTablesFromSql(sql)).toEqual(["chord_rounds"]);
  });
});
