import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import {
  findPublishedMigrationViolations,
  migrationContentHash,
} from "./published-immutable";
import {
  MIGRATIONS_DATA_DIR,
  publishedMergeBases,
  publishedMigrationBasenames,
  publishedMigrationRefs,
  publishedMigrationRefsSignature,
} from "./published";

// Real git in throwaway repos, with the machine's own config switched off.
// Remote-tracking refs are written with `update-ref` — the helper only ever
// reads refs, so how they got there does not matter, and nothing dials out.
const GIT_ENV = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"] as const;
const saved = new Map<string, string | undefined>();
let dir = "";

beforeAll(() => {
  for (const k of GIT_ENV) saved.set(k, process.env[k]);
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  dir = mkdtempSync(join(tmpdir(), "published-migrations-"));
});

afterAll(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

async function git(root: string, ...args: string[]): Promise<string> {
  const r = await spawnExpectOk(
    ["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { cwd: root, timeoutMs: 60_000 },
  );
  return r.stdout.trim();
}

let n = 0;
async function repo(): Promise<string> {
  const root = join(dir, `r${n++}`);
  await spawnExpectOk(["git", "init", "-q", "-b", "main", root], {
    timeoutMs: 60_000,
  });
  write(root, "README", "seed\n");
  await commit(root, "seed");
  return root;
}

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

async function commit(root: string, msg: string): Promise<string> {
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "--allow-empty", "-m", msg);
  return git(root, "rev-parse", "HEAD");
}

/** A schema migration (`.sql` + snapshot) with a correct filename sha8. */
function migration(root: string, ts: string, slug: string): string {
  const sql = `-- ${slug}\nCREATE TABLE "${slug}" ("id" text);\n`;
  const tag = `${ts}_${migrationContentHash(sql)}__${slug}`;
  write(root, `${MIGRATIONS_DATA_DIR}/${tag}.sql`, sql);
  write(
    root,
    `${MIGRATIONS_DATA_DIR}/meta/${tag}_snapshot.json`,
    `{"id":"${slug}"}\n`,
  );
  return `${tag}.sql`;
}

/**
 * Await `p` and return the Error it rejected with; throw if it resolved.
 * `expect(p).rejects.toThrow()` is typed `void` under bun:test.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

const sqlPath = (f: string) => `${MIGRATIONS_DATA_DIR}/${f}`;
const setRef = (root: string, ref: string, sha: string) =>
  git(root, "update-ref", ref, sha);

describe("publishedMigrationRefs / publishedMigrationBasenames", () => {
  test("author: main + origin/main, local main first", async () => {
    const root = await repo();
    const a = migration(root, "20260101_000000", "a");
    const sha = await commit(root, "a");
    await setRef(root, "refs/remotes/origin/main", sha);
    await setRef(root, "refs/remotes/origin/HEAD", sha); // not a `main`
    await setRef(root, "refs/remotes/origin/feature/main", sha); // deeper: no

    const refs = await publishedMigrationRefs(root);
    expect(refs.map((r) => r.ref)).toEqual([
      "refs/heads/main",
      "refs/remotes/origin/main",
    ]);
    expect(refs.every((r) => r.sha === sha)).toBe(true);
    expect(await publishedMigrationRefsSignature(root)).toBe(
      `refs/heads/main=${sha},refs/remotes/origin/main=${sha}`,
    );
    const names = await publishedMigrationBasenames(root);
    expect(names.has(a)).toBe(true);
    expect(names.has(a.replace(/\.sql$/, "_snapshot.json"))).toBe(true);
  });

  test("clone: origin = author, local main ahead with its own migration", async () => {
    const root = await repo();
    const author = migration(root, "20260101_000000", "author");
    const authorSha = await commit(root, "author");
    await setRef(root, "refs/remotes/origin/main", authorSha);
    const own = migration(root, "20260102_000000", "own");
    await commit(root, "own work landed on local main");

    await git(root, "checkout", "-q", "-b", "task");
    const branchLocal = migration(root, "20260103_000000", "task");
    await commit(root, "task");

    const names = await publishedMigrationBasenames(root);
    // The user's own landed migration is published even though origin/main
    // (the author's repo) does not have it — the bug this helper fixes.
    expect(names.has(author)).toBe(true);
    expect(names.has(own)).toBe(true);
    expect(names.has(branchLocal)).toBe(false);
    expect(await findPublishedMigrationViolations(root)).toEqual([]);
  });

  test("fork: origin/main + upstream/main are both published", async () => {
    const root = await repo();
    const base = await git(root, "rev-parse", "HEAD");
    const up = migration(root, "20260101_000000", "upstream");
    const upSha = await commit(root, "upstream");
    await setRef(root, "refs/remotes/upstream/main", upSha);
    await git(root, "reset", "-q", "--hard", base);
    const mine = migration(root, "20260102_000000", "mine");
    const mineSha = await commit(root, "mine");
    await setRef(root, "refs/remotes/origin/main", mineSha);

    expect((await publishedMigrationRefs(root)).map((r) => r.ref)).toEqual([
      "refs/heads/main",
      "refs/remotes/origin/main",
      "refs/remotes/upstream/main",
    ]);
    const names = await publishedMigrationBasenames(root);
    expect(names.has(up)).toBe(true);
    expect(names.has(mine)).toBe(true);
  });

  test("throws loudly when there is no local main", async () => {
    const root = await repo();
    await git(root, "branch", "-q", "-m", "main", "trunk");
    expect((await rejection(publishedMigrationRefs(root))).message).toMatch(
      /No local `main` branch/,
    );
    expect(
      (await rejection(publishedMigrationBasenames(root))).message,
    ).toMatch(/No local `main` branch/);
  });
});

describe("findPublishedMigrationViolations", () => {
  test("merge branch: both sides published, nothing changed → passes", async () => {
    const root = await repo();
    const base = await git(root, "rev-parse", "HEAD");
    migration(root, "20260101_000000", "upstream");
    const upSha = await commit(root, "upstream");
    await setRef(root, "refs/remotes/upstream/main", upSha);
    await git(root, "reset", "-q", "--hard", base);
    migration(root, "20260102_000000", "user");
    await commit(root, "user");

    await git(root, "checkout", "-q", "-b", "update");
    await git(root, "merge", "-q", "--no-edit", "refs/remotes/upstream/main");

    const bases = await publishedMergeBases(root);
    // main and upstream/main are both ancestors of HEAD: two distinct bases.
    expect(bases.map((b) => b.refs).sort()).toEqual([
      ["refs/heads/main"],
      ["refs/remotes/upstream/main"],
    ]);
    expect(await findPublishedMigrationViolations(root)).toEqual([]);
  });

  test("stale branch behind main passes (a newer main migration is not 'missing')", async () => {
    const root = await repo();
    migration(root, "20260101_000000", "old");
    await commit(root, "old");
    await git(root, "checkout", "-q", "-b", "stale");
    await git(root, "checkout", "-q", "main");
    migration(root, "20260102_000000", "newer");
    await commit(root, "newer on main");
    await git(root, "checkout", "-q", "stale");

    expect(await findPublishedMigrationViolations(root)).toEqual([]);
  });

  test("a deleted, renamed or edited published file fails, naming it and the ref", async () => {
    const root = await repo();
    const del = migration(root, "20260101_000000", "deleted");
    const ren = migration(root, "20260101_000001", "renamed");
    const edt = migration(root, "20260101_000002", "edited");
    const sha = await commit(root, "published");
    await setRef(root, "refs/remotes/origin/main", sha);
    await git(root, "checkout", "-q", "-b", "task");

    rmSync(join(root, sqlPath(del)));
    renameSync(
      join(root, sqlPath(ren)),
      join(root, sqlPath(ren.replace("renamed", "renamed2"))),
    );
    write(root, sqlPath(edt), "-- hand edit\n");
    // A branch-local file is this branch's to change.
    const local = migration(root, "20260103_000000", "local");
    write(root, sqlPath(local), "-- edited, still branch-local\n");

    const both = ["refs/heads/main", "refs/remotes/origin/main"];
    expect(await findPublishedMigrationViolations(root)).toEqual([
      { kind: "missing", path: sqlPath(del), refs: both },
      { kind: "missing", path: sqlPath(ren), refs: both },
      { kind: "modified", path: sqlPath(edt), refs: both },
    ]);
  });

  test("a published legacy-snapshots.json entry is pinned; the tip snapshot, the journal and a per-migration snapshot are not", async () => {
    const root = await repo();
    const f = migration(root, "20260101_000000", "snap");
    const g = migration(root, "20260101_000001", "gone");
    const meta = `${MIGRATIONS_DATA_DIR}/meta`;
    const legacy = `${meta}/legacy-snapshots.json`;
    const entries = (o: Record<string, [string, string]>) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(o).map(([k, [id, prevId]]) => [k, { id, prevId }]),
        ),
      );
    const tag = (file: string) => file.replace(/\.sql$/, "");
    write(
      root,
      legacy,
      entries({ [tag(f)]: ["a", "0"], [tag(g)]: ["b", "a"] }),
    );
    write(root, `${meta}/schema.snapshot.json`, `{"id":"b","prevId":"a"}\n`);
    write(root, `${meta}/_journal.json`, "{}\n");
    await commit(root, "published");
    await git(root, "checkout", "-q", "-b", "task");

    // Free to change: the tip body, the journal, a per-migration snapshot,
    // and a key the published file did not have.
    write(root, `${meta}/schema.snapshot.json`, `{"id":"c","prevId":"b"}\n`);
    write(root, `${meta}/_journal.json`, "{ }\n");
    rmSync(join(root, `${meta}/${tag(f)}_snapshot.json`));
    write(
      root,
      legacy,
      entries({ [tag(f)]: ["a", "0"], [tag(g)]: ["b", "a"], new: ["c", "b"] }),
    );
    expect(await findPublishedMigrationViolations(root)).toEqual([]);

    // Not free: a published entry rewritten or dropped.
    write(root, legacy, entries({ [tag(f)]: ["a", "x"] }));
    expect(await findPublishedMigrationViolations(root)).toEqual([
      {
        kind: "legacy-entry",
        path: legacy,
        tag: tag(f),
        refs: ["refs/heads/main"],
        now: "changed",
      },
      {
        kind: "legacy-entry",
        path: legacy,
        tag: tag(g),
        refs: ["refs/heads/main"],
        now: "missing",
      },
    ]);
  });

  test("a published .sql whose filename sha8 is not its content hash fails", async () => {
    const root = await repo();
    const bad = "20260101_000000_deadbeef__bad.sql";
    write(root, sqlPath(bad), "SELECT 1;\n");
    await commit(root, "published with a wrong hash");

    expect(await findPublishedMigrationViolations(root)).toEqual([
      {
        kind: "hash-mismatch",
        path: sqlPath(bad),
        refs: ["refs/heads/main"],
        filenameHash: "deadbeef",
        contentHash: migrationContentHash("SELECT 1;\n"),
      },
    ]);
  });

  test("a remote main with no common ancestor contributes nothing", async () => {
    const root = await repo();
    await git(root, "checkout", "-q", "--orphan", "other");
    await git(root, "rm", "-rq", "--cached", ".");
    rmSync(join(root, "README"));
    migration(root, "20260101_000000", "unrelated");
    const other = await commit(root, "unrelated history");
    await setRef(root, "refs/remotes/stranger/main", other);
    await git(root, "checkout", "-q", "-f", "main");

    const bases = await publishedMergeBases(root);
    expect(bases.map((b) => b.refs)).toEqual([["refs/heads/main"]]);
    expect(await findPublishedMigrationViolations(root)).toEqual([]);
  });
});
