// An initialized, empty PGlite cluster — what initdb writes for this PGlite
// build — as a gzipped data directory at `<out>`. Run by the host-snapshot
// stage (`../core/internal/host-snapshots.ts`) once per PGlite build, in a
// fresh process: a snapshot take's database opens from it (`loadDataDir`)
// instead of running initdb, which a fresh PGlite does on every start and
// which was half of the take's `onReadyBlocking:database`. The cluster holds
// no app state (no migration, no row), so nothing but PGlite and this script
// decide its bytes.
//
// Every snapshot ships this cluster's layout to each first visitor, and the
// worker reads its every file into memory (and, persistent, writes it to
// IndexedDB), so the cluster carries only what a PGlite host uses:
//  - WAL in 1 MB segments, at most two kept: initdb's default 16 MB segments,
//    with Postgres keeping 80 MB of recycled ones, were 33.6 MB of the
//    workspace demo's 72 MB data directory (4.9 of its 8 MB gzipped) — WAL no
//    open needs once the take checkpoints before its dump (the pglite driver's
//    `dump`). Set in the cluster (`postgresql.auto.conf`), not as start flags:
//    a data dir initialized with 16 MB segments refuses a `min_wal_size` under
//    two of them, so the setting belongs to the cluster it fits.
//  - only the `postgres` database PGlite connects to: template0 and template1
//    serve CREATE DATABASE alone, which no host runs (2.0 MB gzipped, 15 MB
//    raw).
import { writeFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const out = process.argv[2];
if (out === undefined) throw new Error("usage: pglite-cluster.ts <out-file>");
// A fresh PGlite's start awaits work that holds no event-loop handle: in a
// script with nothing else running, Bun ends the process mid-initdb, with
// exit code 0 and no file (measured on PGlite 0.5.11, Bun 1.4.4). The timer
// holds the loop until the file is written; the stage still checks that the
// file exists.
const hold = setTimeout(() => {}, 2 ** 31 - 1);
const pglite = new PGlite({ initDbStartParams: ["--wal-segsize=1"] });
// Before its start finished, `dumpDataDir` spins instead of waiting for it.
await pglite.waitReady;
// Read at the next start: every open of this cluster (a take, a visitor's
// snapshot) runs with them. One statement per exec: a multi-statement exec
// is one transaction block, which ALTER SYSTEM refuses.
await pglite.exec("ALTER SYSTEM SET min_wal_size = '2MB'");
await pglite.exec("ALTER SYSTEM SET wal_recycle = off");
for (const template of ["template0", "template1"]) {
  await pglite.exec(`ALTER DATABASE ${template} IS_TEMPLATE false`);
  await pglite.exec(`DROP DATABASE ${template}`);
}
const dataDir = await pglite.dumpDataDir("gzip");
await pglite.close();
writeFileSync(out, new Uint8Array(await dataDir.arrayBuffer()));
clearTimeout(hold);
