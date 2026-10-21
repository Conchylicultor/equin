import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  analyzeSnapshotDag,
  mergeSnapshotParents,
  migrationContentHash,
  NULL_SNAPSHOT_ID,
  parseMigration,
  readSnapshotNodes,
} from "@plugins/database/plugins/migrations/core";
import {
  formatMigrationTimestamp,
  joinSnapshotTips,
  latestMigrationTimestamp,
  mergeSnapshotId,
  SnapshotJoinError,
} from "./snapshot-join";
import { renameMigrations } from "./migrations";

// Snapshot ids of the fixture history, uuid-shaped as drizzle writes them.
const uid = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const A = uid(1);
const P1 = uid(2);
const U1 = uid(3);
const P2 = uid(4);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "snapshot-join-"));
  mkdirSync(join(dir, "meta"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const table = (name: string, columns: Record<string, unknown> = {}) => ({
  [`public.${name}`]: {
    name,
    schema: "",
    columns: {
      id: { name: "id", type: "text", primaryKey: true, notNull: true },
      ...columns,
    },
  },
});

/** Write one schema migration (.sql + snapshot) and return its basename. */
function write(
  ts: string,
  slug: string,
  id: string,
  prevId: string,
  tables: Record<string, unknown>,
): string {
  // Content only feeds the filename hash; any DDL works, and the literal
  // CREATE-TABLE form is reserved for allowlisted tables repo-wide.
  const sql = `ALTER TABLE "${slug}" ADD COLUMN "c" text;\n`;
  const tag = `${ts}_${migrationContentHash(sql)}__${slug}`;
  writeFileSync(join(dir, `${tag}.sql`), sql);
  writeFileSync(
    join(dir, "meta", `${tag}_snapshot.json`),
    JSON.stringify(
      {
        id,
        prevId,
        version: "7",
        dialect: "postgresql",
        tables,
        enums: {},
        schemas: {},
        sequences: {},
        roles: {},
        policies: {},
        views: {},
        _meta: { columns: {}, schemas: {}, tables: {} },
      },
      null,
      2,
    ),
  );
  return tag;
}

const MAIN = "refs/heads/main";
const ORIGIN = "refs/remotes/origin/main";

/** Which `main` a fixture file is on, by its slug: the shape of a clone. */
type Placement = (file: string) => string[];
const cloneShape: Placement = (f) =>
  f.includes("__base")
    ? [MAIN, ORIGIN]
    : /__(upstream|third)/.test(f)
      ? [ORIGIN]
      : [MAIN];

/**
 * Every file under the data dir as published, with its origin refs
 * (`publishedMigrationOrigins`' shape).
 */
function published(place: Placement = cloneShape): Map<string, string[]> {
  return new Map(
    [...readdirSync(dir), ...readdirSync(join(dir, "meta"))].map((f) => [
      f,
      place(f),
    ]),
  );
}

function forkedHistory(noteU?: string, noteP?: string): void {
  write("20260901_000000", "base", A, NULL_SNAPSHOT_ID, table("base"));
  write("20260902_000000", "upstream", P1, A, {
    ...table("base"),
    ...table("probe", noteP ? { note: { name: "note", type: noteP } } : {}),
  });
  write("20260903_000000", "user", U1, A, {
    ...table("base"),
    ...table("mine"),
    ...(noteU ? table("probe", { note: { name: "note", type: noteU } }) : {}),
  });
}

describe("joinSnapshotTips", () => {
  test("a single chain is left alone", async () => {
    write("20260901_000000", "base", A, NULL_SNAPSHOT_ID, table("base"));
    write("20260902_000000", "next", P1, A, table("base"));
    const before = published();
    expect(await joinSnapshotTips(dir, before)).toEqual({ kind: "single-tip" });
    expect(published()).toEqual(before);
  });

  test("two published tips are joined by a no-op merge node", async () => {
    forkedHistory();
    const result = await joinSnapshotTips(dir, published());
    expect(result).toMatchObject({ kind: "joined", parents: [P1, U1] });
    if (result.kind !== "joined") return;

    // One second after the latest migration, content-hashed, merge slug.
    expect(result.file).toMatch(
      /^20260903_000001_[0-9a-f]{8}__merge_snapshot\.sql$/,
    );
    const sql = readFileSync(join(dir, result.file), "utf8");
    expect(result.file.slice(16, 24)).toBe(migrationContentHash(sql));
    expect(mergeSnapshotParents(sql)).toEqual([P1, U1]);
    expect(parseMigration(sql)).toEqual({
      kind: "phased",
      expand: "",
      contract: "",
      claims: [],
      supersedes: null,
    });

    const snapshot = JSON.parse(
      readFileSync(
        join(dir, "meta", `${result.file.slice(0, -4)}_snapshot.json`),
        "utf8",
      ),
    );
    expect(snapshot.id).toBe(mergeSnapshotId([P1, U1]));
    expect(snapshot.prevId).toBe(U1); // the parent that sorts last
    expect(Object.keys(snapshot.tables).sort()).toEqual([
      "public.base",
      "public.mine",
      "public.probe",
    ]);
    expect(snapshot._meta).toEqual({ columns: {}, schemas: {}, tables: {} });
    expect(Object.keys(snapshot).slice(0, 2)).toEqual(["id", "prevId"]);

    // The DAG is healed: one root, one tip, nothing else wrong.
    const dag = analyzeSnapshotDag(await readSnapshotNodes(dir));
    expect(dag.problems).toEqual([]);
    expect(dag.tips.map((t) => t.id)).toEqual([snapshot.id]);

    // A second join finds the single tip.
    expect(await joinSnapshotTips(dir, published())).toEqual({
      kind: "single-tip",
    });
  });

  test("the merge node is deterministic: reset and re-joined, it comes back byte-identical", async () => {
    forkedHistory();
    const pub = published();
    const first = await joinSnapshotTips(dir, pub);
    if (first.kind !== "joined") throw new Error("expected a join");
    const tag = first.file.slice(0, -4);
    const bytes = [
      readFileSync(join(dir, first.file), "utf8"),
      readFileSync(join(dir, "meta", `${tag}_snapshot.json`), "utf8"),
    ];
    rmSync(join(dir, first.file));
    rmSync(join(dir, "meta", `${tag}_snapshot.json`));

    const second = await joinSnapshotTips(dir, pub);
    expect(second).toEqual(first);
    expect([
      readFileSync(join(dir, first.file), "utf8"),
      readFileSync(join(dir, "meta", `${tag}_snapshot.json`), "utf8"),
    ]).toEqual(bytes);
  });

  test("a branch-local tip is a rebase Y-fork: refused with --reset-migration, nothing written", async () => {
    forkedHistory();
    const pub = published();
    const user = readdirSync(dir).find((f) => f.includes("__user"))!;
    pub.delete(user);
    pub.delete(`${user.slice(0, -4)}_snapshot.json`);
    const before = published();
    const err = await joinSnapshotTips(dir, pub).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapshotJoinError);
    expect((err as Error).message).toContain("--reset-migration");
    expect((err as Error).message).toContain("(branch-local)");
    expect(published()).toEqual(before);
  });

  test("both sides adding a column with different types names the path, and writes nothing", async () => {
    forkedHistory("integer", "text");
    const before = published();
    const err = await joinSnapshotTips(dir, before).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapshotJoinError);
    expect((err as Error).message).toContain(
      "tables.public.probe.columns.note.type: ours=integer theirs=text base=<absent>",
    );
    // Sides are named by where they come from, this checkout's trunk first.
    const message = (err as Error).message;
    expect(message).toMatch(
      /ours {3}= this checkout \(main\): 20260903_000000_[0-9a-f]{8}__user\n/,
    );
    expect(message).toMatch(
      /theirs = upstream \(refs\/remotes\/origin\/main\): 20260902_000000_[0-9a-f]{8}__upstream\n/,
    );
    expect(message).toMatch(/base {3}= 20260901_000000_[0-9a-f]{8}__base\n/);
    expect((err as Error).message).toContain("Stop here");
    expect(published()).toEqual(before);
  });

  test("three tips fold pairwise into one node", async () => {
    forkedHistory();
    write("20260904_000000", "third", P2, A, {
      ...table("base"),
      ...table("third"),
    });
    const result = await joinSnapshotTips(dir, published());
    expect(result).toMatchObject({ kind: "joined", parents: [P1, U1, P2] });
    const dag = analyzeSnapshotDag(await readSnapshotNodes(dir));
    expect(dag.problems).toEqual([]);
  });

  test("a later upstream update merges against the previous merge node's side", async () => {
    forkedHistory();
    const first = await joinSnapshotTips(dir, published());
    if (first.kind !== "joined") throw new Error("expected a join");
    // Upstream moves on from P1 (not from the merge node).
    write("20260905_000000", "upstream_two", P2, P1, {
      ...table("base"),
      ...table("probe"),
      ...table("later"),
    });
    const second = await joinSnapshotTips(dir, published());
    expect(second).toMatchObject({ kind: "joined" });
    const dag = analyzeSnapshotDag(await readSnapshotNodes(dir));
    expect(dag.problems).toEqual([]);
    const tip = JSON.parse(
      readFileSync(join(dir, "meta", dag.tips[0]!.file), "utf8"),
    );
    // Base was P1: user's `mine` survives, upstream's `later` arrives.
    expect(Object.keys(tip.tables).sort()).toEqual([
      "public.base",
      "public.later",
      "public.mine",
      "public.probe",
    ]);
  });
});

describe("migration timestamps", () => {
  test("latest + format round-trip", () => {
    const files = [
      "20260901_000000_aaaaaaaa__a.sql",
      "20260903_235959_bbbbbbbb__b.sql",
      "_journal.json",
    ];
    const latest = latestMigrationTimestamp(files);
    expect(formatMigrationTimestamp(latest! + 1000)).toBe("20260904_000000");
    expect(latestMigrationTimestamp([])).toBeNull();
  });
});

describe("ordering by construction", () => {
  test("what drizzle-kit emits in the same run sorts after a merge node stamped in the future", async () => {
    // A merge node stamped latest + 1s can be ahead of the wall clock (a
    // migration authored in the last second, or clock skew). The fresh
    // migration must still sort after it — never by wall-clock luck.
    write("20991231_235958", "base", A, NULL_SNAPSHOT_ID, table("base"));
    write("20991231_235959", "upstream", P1, A, table("base"));
    write("20991231_235959", "user", U1, A, table("base"));
    const joined = await joinSnapshotTips(dir, published());
    if (joined.kind !== "joined") throw new Error("expected a join");
    expect(joined.file).toStartWith("21000101_000000_");

    writeFileSync(
      join(dir, "0NaN_next.sql"),
      'ALTER TABLE "n" ADD COLUMN "c" text;\n',
    );
    writeFileSync(join(dir, "meta", "0NaN_snapshot.json"), "{}");
    const { renamed } = renameMigrations(dir);
    expect(renamed.map((r) => r.to.slice(0, 15))).toEqual(["21000101_000001"]);
    const sqls = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(sqls.at(-1)).toBe(renamed[0]!.to);
    expect(sqls.at(-2)).toBe(joined.file);
  });
});

describe("joinSnapshotTips: fold order", () => {
  /** Join, return the node's two files' bytes, and remove them. */
  async function joinBytes(place: Placement): Promise<string[]> {
    const r = await joinSnapshotTips(dir, published(place));
    if (r.kind !== "joined") throw new Error("expected a join");
    const tag = r.file.slice(0, -4);
    const files = [
      join(dir, r.file),
      join(dir, "meta", `${tag}_snapshot.json`),
    ];
    const bytes = files.map((f) => readFileSync(f, "utf8"));
    for (const f of files) rmSync(f);
    return [r.file, ...bytes];
  }

  test("swapping which tip is 'ours' yields a byte-identical node", async () => {
    forkedHistory();
    const userOnMain = await joinBytes(cloneShape);
    // The mirror image: upstream's tip is this checkout's trunk.
    const upstreamOnMain = await joinBytes((f) =>
      f.includes("__base")
        ? [MAIN, ORIGIN]
        : f.includes("__upstream")
          ? [MAIN]
          : [ORIGIN],
    );
    expect(upstreamOnMain).toEqual(userOnMain);
  });

  test("three tips give the same node whichever of them is on local main", async () => {
    forkedHistory();
    write("20260904_000000", "third", P2, A, {
      ...table("base"),
      ...table("third"),
    });
    const onMain =
      (slug: string): Placement =>
      (f) =>
        f.includes("__base") || f.includes(slug) ? [MAIN] : [ORIGIN];
    const a = await joinBytes(onMain("__user"));
    const b = await joinBytes(onMain("__upstream"));
    const c = await joinBytes(onMain("__third"));
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  test("when local main holds neither tip, each side is named by its refs", async () => {
    forkedHistory("integer", "text");
    const err = await joinSnapshotTips(
      dir,
      published((f) =>
        f.includes("__base")
          ? ["refs/remotes/a/main", "refs/remotes/b/main"]
          : f.includes("__upstream")
            ? ["refs/remotes/b/main"]
            : ["refs/remotes/a/main"],
      ),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapshotJoinError);
    const message = (err as Error).message;
    // File order then: upstream (b) sorts first.
    expect(message).toMatch(/ours {3}= refs\/remotes\/b\/main: 20260902_/);
    expect(message).toMatch(/theirs = refs\/remotes\/a\/main: 20260903_/);
    expect(message).not.toContain("this checkout");
    expect(message).toContain("columns.note.type");
  });
});
