import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { NodeFS } from "@electric-sql/pglite/nodefs";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { WriteTrackedFs } from "./write-tracked-fs";

// A read never writes back; a write always does. PGlite calls the
// filesystem's `syncToFs` after every query outside a transaction; the
// tracked filesystem passes it on only when a file under its mounts changed.
// The browser's IDBFS needs IndexedDB, so this drives the same tracking over
// PGlite's on-disk `nodefs`, counting the syncs that reach it. Durable mode
// (no `relaxedDurability`), so each query's sync has run when it answers.
//
// In a FRESH bun process (this file, re-run as a child), as every PGlite
// suite here: PGlite picks its environment from `typeof window`, which an
// earlier suite in the shared process may have stubbed.

setDefaultTimeout(120_000);

const IN_CHILD = process.env.PGLITE_WRITE_TRACKED_CHILD === "1";

if (!IN_CHILD) {
  test("a read never syncs the filesystem; a write does (in a fresh process)", async () => {
    const result = await spawnCaptured(
      [process.execPath, "test", import.meta.path],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, PGLITE_WRITE_TRACKED_CHILD: "1" },
        timeoutMs: 110_000,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `PGlite write-tracked child exited ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      );
    }
    expect(result.exitCode).toBe(0);
  });
}

/** PGlite's on-disk filesystem, counting the syncs that reach it. */
class CountingNodeFs extends NodeFS {
  syncs = 0;
  override async syncToFs(relaxedDurability?: boolean): Promise<void> {
    this.syncs++;
    await super.syncToFs(relaxedDurability);
  }
}

if (IN_CHILD) {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("reads leave the filesystem clean and unsynced; writes mark and sync it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pglite-write-tracked-"));
    dirs.push(dir);
    const inner = new CountingNodeFs(dir);
    const fs = new WriteTrackedFs(inner);
    const pg = new PGlite({ fs });
    await pg.waitReady;
    try {
      // initdb wrote the cluster, and PGlite synced it.
      await pg.exec(
        "CREATE TABLE notes (id int PRIMARY KEY, body text); INSERT INTO notes VALUES (1, 'a'), (2, 'b')",
      );
      expect(fs.dirty).toBe(false);

      // Reads, every way the driver sends one: a parameterized query, a
      // script through exec, a catalog read, a transaction.
      const before = inner.syncs;
      for (let i = 0; i < 20; i++) {
        await pg.query("SELECT body FROM notes WHERE id = $1", [1]);
        await pg.exec("SELECT count(*) FROM notes");
        await pg.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
        );
        await pg.transaction(async (tx) => {
          await tx.query("SELECT * FROM notes ORDER BY id");
        });
      }
      expect(fs.dirty).toBe(false);
      expect(inner.syncs).toBe(before);

      // A write reaches the filesystem, and the next sync persists it.
      await pg.query("INSERT INTO notes VALUES ($1, $2)", [3, "c"]);
      expect(inner.syncs).toBe(before + 1);
      expect(fs.dirty).toBe(false);

      // A write inside a transaction: PGlite syncs nothing at its COMMIT
      // (it runs as part of the transaction), so the change waits, marked,
      // for the next sync — the next query's, or the storage's flush.
      await pg.transaction(async (tx) => {
        await tx.query("UPDATE notes SET body = 'z' WHERE id = 1");
      });
      expect(fs.dirty).toBe(true);
      expect(inner.syncs).toBe(before + 1);
      await pg.query("SELECT 1");
      expect(fs.dirty).toBe(false);
      expect(inner.syncs).toBe(before + 2);

      // A schema change (new relation files) too.
      await pg.exec("CREATE INDEX notes_body ON notes (body)");
      expect(inner.syncs).toBe(before + 3);
    } finally {
      await pg.close();
    }
  });

  test("a sync of a clean filesystem waits for the one in flight", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pglite-write-tracked-"));
    dirs.push(dir);
    // While armed, the next sync to reach the disk stops there until released.
    let armed: { entered: () => void; gate: Promise<void> } | null = null;
    class GatedFs extends NodeFS {
      override async syncToFs(relaxedDurability?: boolean): Promise<void> {
        const held = armed;
        armed = null;
        if (held !== null) {
          held.entered();
          await held.gate;
        }
        await super.syncToFs(relaxedDurability);
      }
    }
    const fs = new WriteTrackedFs(new GatedFs(dir));
    // Relaxed, as the browser host opens it: a query answers before its
    // sync is done.
    const pg = new PGlite({ fs, relaxedDurability: true });
    await pg.waitReady;
    try {
      let release = (): void => {
        throw new Error("no sync held");
      };
      const entered = new Promise<void>((resolve) => {
        armed = {
          entered: resolve,
          gate: new Promise<void>((r) => {
            release = r;
          }),
        };
      });
      await pg.query("CREATE TABLE t (id int)");
      await entered;
      // The write's sync is in flight and has cleared the mark: a flush now
      // finds nothing new, yet must not answer before that sync is done.
      expect(fs.dirty).toBe(false);
      let flushed = false;
      const flush = fs.syncToFs(false).then(() => {
        flushed = true;
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(flushed).toBe(false);
      release();
      await flush;
      expect(flushed).toBe(true);
    } finally {
      await pg.close();
    }
  });
}
