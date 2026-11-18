// `bun install --verbose`'s output → an install's package count.
//
//   bun install --verbose 2>&1 | bun plugins/installer/bin/bun-install-progress.ts <bun.lock>
//
// What the CLI's dependency install pipes through while an install runs it
// (`./equin`'s bootstrap, `ensureDeps`, when `EQUIN_INSTALL_EVENTS` is set):
// bun prints no progress without a terminal, but `--verbose` prints one
// `[<package>] Extracted to …` line per package it unpacks. Each is counted
// against the lockfile's package entries and reported as an install
// `progress` event (packages); every other line passes through, minus the
// verbose mode's own noise (HTTP headers, queue chatter, the lockfile hash
// dump), so the install log reads like a plain `bun install`.
//
// Runs BEFORE node_modules exists, with bare `bun`: it may load no npm
// package (installer/cli loads none — types only from installer/core).

import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { reportInstallProgress } from "@plugins/installer/cli";

const lockPath = process.argv[2];
if (lockPath === undefined)
  throw new Error("usage: bun-install-progress.ts <bun.lock>");

/** Packages the lockfile resolves (workspace members are linked, not extracted). */
function lockfilePackages(path: string): number {
  const text = readFileSync(path, "utf8");
  const start = text.indexOf('\n  "packages": {');
  if (start === -1) throw new Error(`${path} has no "packages" section`);
  let n = 0;
  for (const line of text.slice(start).split("\n"))
    if (/^ {4}"[^"]+": \["/.test(line) && !line.includes("@workspace:")) n++;
  return n;
}

const total = lockfilePackages(lockPath);
const EXTRACTED = /^\[[^\]]+\] Extracted to /;
/** `--verbose`'s own lines, which a plain `bun install` never prints. */
const NOISE = [
  /^\s/, // HTTP request headers, timings
  /^</, // HTTP response headers
  /^\[PackageManager\]/,
  /^Enqueue /,
  /^Downloaded .* versions$/,
  /^\[[^\]]+\] (Extract|Extracted to) /,
  /^-- (BEGIN|END) /,
  /^Clean lockfile: /,
  /^Resolved, downloaded and extracted /,
  // bun's advice about the lifecycle scripts it did not run. The repo leaves
  // them untrusted on purpose (embedded-postgres' symlink hydration is done by
  // database/embedded's start script, @parcel/watcher ships prebuilt), so
  // `bun pm untrusted` is nothing for a person installing equin to act on.
  /^Blocked \d+ (postinstall|lifecycle script)s?\. Run 'bun pm untrusted' for details\.$/,
];

let done = 0;
let inHashDump = false;
reportInstallProgress(0, total, "packages");
for await (const line of console) {
  if (EXTRACTED.test(line)) {
    done++;
    reportInstallProgress(done, total, "packages");
    continue;
  }
  // The lockfile hash dump: one `name@version` line per package.
  if (line.startsWith("-- BEGIN ")) inHashDump = true;
  if (inHashDump) {
    if (line.startsWith("-- END")) inHashDump = false;
    continue;
  }
  if (line === "" || NOISE.some((re) => re.test(line))) continue;
  console.log(line);
}
// No closing "total of total": a package already in bun's cache is linked,
// not extracted, so the count can end short — the step's own `done` (only
// when bun exited 0) is what says the install finished.
