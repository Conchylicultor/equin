import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { readdir } from "@plugins/packages/plugins/timed-fs/core";
import { processNamesDir } from "../../data-dirs";
import { cloneNamedBinary, type NamedBinary } from "./process-name";

// The machine-wide named Buns: `process-names/bun-<version>/`, one APFS clone
// per name and Bun version, shared by every checkout and backend. The CLI
// verbs sit in it directly (the `./equin` script names them from its argv);
// the processes a backend starts (`cloneSharedBun`) in its `processes/`
// subdirectory, so no verb can ever be given one of their names.
//
// Shared because macOS scans every fresh executable on its first exec, and the
// verdict is kept per (path, file): measured 2026-11-12, a scanned clone
// renamed or hardlinked to a new path is scanned again (1.5–1.8 s), a new clone
// at a scanned path too (3.0–3.6 s), whatever its signature (notarized
// Developer ID, ad-hoc) or provenance; only the same file at the same path runs
// free (0.03 s). So a name made once per machine is scanned once, and a name
// made per checkout or per agent is scanned once each — ~1.7 s for Bun's 88 MB.
// A symlink is not scanned, but the kernel names the process after the target
// (`proc_name` `bun`), so a name needs a file of its own.

/** The named Buns of the Bun this process runs on: `process-names/bun-<version>/`. */
export function sharedBunDir(): AppPath {
  return processNamesDir.file(`bun-${Bun.version}`);
}

/** Where the processes a backend starts live, under a version's directory. */
const PROCESSES = "processes";

/**
 * This process's Bun cloned into {@link sharedBunDir}'s `processes/` as
 * `name` — left alone while current, so every process run through it after
 * the first skips the scan.
 */
export function cloneSharedBun(name: string): Promise<NamedBinary> {
  return cloneNamedBinary({
    bin: asAppPath(process.execPath),
    dir: joinAppPath(sharedBunDir(), PROCESSES),
    name,
  });
}

/**
 * {@link cloneSharedBun}'s `name` in every Bun version's directory that holds
 * it — the ones an upgrade left behind included, for whoever runs processes
 * through `name` to reclaim once none does.
 */
export async function sharedBunsNamed(name: string): Promise<AppPath[]> {
  let versions: string[];
  try {
    versions = await readdir(processNamesDir.path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: AppPath[] = [];
  for (const v of versions.filter((d) => d.startsWith("bun-"))) {
    const dir = joinAppPath(processNamesDir.path, v, PROCESSES);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw err;
    }
    if (names.includes(name)) out.push(joinAppPath(dir, name));
  }
  return out;
}
