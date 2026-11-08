// An initialized, empty PGlite cluster — what initdb writes for this PGlite
// build — as a gzipped data directory at `<out>`. Run by the host-snapshot
// stage (`../core/internal/host-snapshots.ts`) once per PGlite build, in a
// fresh process: a snapshot take's database opens from it (`loadDataDir`)
// instead of running initdb, which a fresh PGlite does on every start and
// which was half of the take's `onReadyBlocking:database`. The cluster holds
// no app state (no migration, no row), so nothing but PGlite decides its
// bytes.
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
const pglite = new PGlite();
// Before its start finished, `dumpDataDir` spins instead of waiting for it.
await pglite.waitReady;
const dataDir = await pglite.dumpDataDir("gzip");
await pglite.close();
writeFileSync(out, new Uint8Array(await dataDir.arrayBuffer()));
clearTimeout(hold);
