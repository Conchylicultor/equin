// Measures the whole-cache scans a build used to pay on its critical path,
// read-only (nothing is deleted): the web-artifact prune's roots (every dist's
// links) and its store pass, and the check cache's open-time listing. Prints
// wall time and the number of fs metadata calls each makes — counted from what
// the scans iterate (each is one call per entry), since Bun binds `node:fs`
// imports natively and a wrapper cannot count them.
//
//   ./equin run plugins/framework/plugins/tooling/plugins/web-artifacts/scripts/measure-cache-scans.ts

import { readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { worktreesDir } from "@plugins/infra/plugins/paths/core";
import { checkCacheDir } from "@plugins/framework/plugins/tooling/plugins/checks/data-dirs";
import {
  WEB_ARTIFACTS_DIR,
  WEB_ARTIFACTS_STORE_DIR,
} from "../core/internal/store";
import {
  refreshServedDists,
  scanServedDists,
} from "../core/internal/served-dists";

const ms = (t0: number): string => `${(performance.now() - t0).toFixed(0)} ms`;
const tryReaddir = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    return [];
  }
};

// ── Roots: the dist scan, counted ────────────────────────────────────
{
  let ops = 0;
  const wt = worktreesDir();
  const t0 = performance.now();
  const namespaces = tryReaddir(wt);
  ops++;
  let roots = 0;
  let links = 0;
  for (const ns of namespaces) {
    const names = tryReaddir(join(wt, ns));
    ops += 2; // ns dir + release-web
    for (const name of names) {
      if (
        name !== "web" &&
        !(name.startsWith("web.") && !name.startsWith("web.swap."))
      )
        continue;
      ops++; // realpath
      const root = realpathSync(join(wt, ns, name));
      roots++;
      const arts = tryReaddir(join(root, "artifacts"));
      ops++;
      for (const a of arts) {
        ops++;
        readlinkSync(join(root, "artifacts", a));
        links++;
      }
    }
  }
  console.log(
    `dist roots: ${namespaces.length} namespaces, ${roots} dist dirs (incl. duplicates by realpath), ${links} links, ~${ops} fs calls, ${ms(t0)}`,
  );
  const t1 = performance.now();
  const scan = scanServedDists();
  const refs = scan.targets;
  console.log(
    `scanServedDists() (the prune's unlocked phase): ${scan.stamps.size} dists, ${refs.size} distinct targets, ${ms(t1)}`,
  );
  // The prune's locked phase re-reads only what changed since the scan:
  // roots listed again (~1 readdir per worktree + a realpath and a stat per dist).
  const tr = performance.now();
  const { reread } = refreshServedDists(scan);
  console.log(
    `refreshServedDists() (under the store lock): ${reread} dists re-read, ~${2 * namespaces.length + 2 * roots} fs calls, ${ms(tr)}`,
  );

  // ── Store pass: readdir + a stat of every unreferenced entry ──────
  for (const sub of ["store", "vendors", "css", "package-assets"]) {
    const dir =
      sub === "store" ? WEB_ARTIFACTS_STORE_DIR : join(WEB_ARTIFACTS_DIR, sub);
    const t2 = performance.now();
    const names = tryReaddir(dir);
    let stats = 0;
    for (const n of names) {
      const p = join(dir, n);
      if (refs.has(p)) continue;
      try {
        statSync(p);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      stats++;
    }
    console.log(
      `prune pass ${sub}: ${names.length} entries, ${stats} stats (+1 readdir), ${ms(t2)}`,
    );
  }
}

// ── Check cache: the open-time listing and the hourly sweep's lists ───
{
  const dir = checkCacheDir.path;
  const t0 = performance.now();
  const names = tryReaddir(dir);
  console.log(
    `check-cache readdir (every open): ${names.length} entries, ${ms(t0)}`,
  );
  const t1 = performance.now();
  for (const n of names) {
    try {
      statSync(join(dir, n));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  console.log(
    `check-cache stat pass (hourly sweep): ${names.length} stats, ${ms(t1)}`,
  );
  const t2 = performance.now();
  const flights = tryReaddir(join(dir, "flights"));
  for (const n of flights) {
    try {
      statSync(join(dir, "flights", n));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  console.log(
    `check-cache flights (hourly sweep): ${flights.length} entries + stats, ${ms(t2)}`,
  );
}
