// The monitor's root LaunchDaemon — the opt-in that adds attribution — from
// the binary's own side: its plist, its install and removal as one command each
// (`install-root` / `uninstall-root`, run with sudo from any directory), the
// rule by which the user agent stands aside for it, and what is wrong with it
// when the user agent cannot.
//
// The user agent defers to a root daemon that is WRITING — its last tick is
// recent — never to a plist's mere existence: an empty, invalid or unloaded
// plist would otherwise stop the monitor without a word (2026-11-04, a `tee`
// whose producer failed left an empty plist, and nothing ticked for hours).
import {
  chownSync,
  existsSync,
  lchownSync,
  lstatSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  RootDaemonProblem,
  RootDaemonStatus,
} from "@plugins/infra/plugins/host/plugins/io-health/core";
import { exec } from "./run";

/** Where the root daemon of `label` is installed. */
export function rootDaemonPlist(label: string): string {
  return `/Library/LaunchDaemons/${label}.plist`;
}

/** The root daemon's own stdout/stderr, beside the log it writes. */
export function rootStdioLog(dir: string): string {
  return join(dir, "fs-latency-root-stdio.log");
}

export interface RootDaemonSpec {
  label: string;
  /** The binary launchd runs: the one the login service installed into the equin app. */
  executable: string;
  dir: string;
  intervalS: number;
}

const esc = (v: string) =>
  v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function renderRootDaemonPlist(s: RootDaemonSpec): string {
  const stdio = esc(rootStdioLog(s.dir));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${esc(s.label)}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${esc(s.executable)}</string>
\t\t<string>--dir</string>
\t\t<string>${esc(s.dir)}</string>
\t\t<string>--root-label</string>
\t\t<string>${esc(s.label)}</string>
\t\t<string>--interval-s</string>
\t\t<string>${s.intervalS}</string>
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>StartInterval</key>
\t<integer>${s.intervalS}</integer>
\t<key>ProcessType</key>
\t<string>Interactive</string>
\t<key>StandardOutPath</key>
\t<string>${stdio}</string>
\t<key>StandardErrorPath</key>
\t<string>${stdio}</string>
</dict>
</plist>
`;
}

/** A shell word: the path as one argument, whatever it holds. */
const sh = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`;

/** The one command that installs (or repairs) the root daemon, from any directory. */
export function installRootCommand(s: RootDaemonSpec): string {
  return `sudo ${sh(s.executable)} install-root --dir ${sh(s.dir)} --root-label ${s.label} --interval-s ${s.intervalS}`;
}

/**
 * The root daemon is writing while its last tick is at most this many of
 * launchd's intervals old. Four, not one: a tick on a stalled disk runs long
 * and launchd skips the next while it does, and two writers meanwhile would
 * interleave the log.
 */
export const ROOT_FRESH_INTERVALS = 4;

/** Whether the user agent stands aside: a root tick landed within the fresh window. */
export function rootIsWriting(
  rootTickAt: number | undefined,
  nowS: number,
  intervalS: number,
): boolean {
  return (
    rootTickAt !== undefined &&
    nowS - rootTickAt <= ROOT_FRESH_INTERVALS * intervalS
  );
}

const isLoaded = (label: string) =>
  exec(["launchctl", "print", `system/${label}`]).exitCode === 0;

/**
 * What is wrong with a root daemon that is not writing, or null when none is
 * installed (no plist: the user agent is the monitor, as designed). Readable
 * without root: the plist is world-readable, `launchctl print system/…` too.
 */
export function diagnoseRootDaemon(label: string): RootDaemonProblem | null {
  const plist = rootDaemonPlist(label);
  if (!existsSync(plist)) return null;
  if (statSync(plist).size === 0) return "empty";
  if (exec(["plutil", "-lint", plist]).exitCode !== 0) return "invalid";
  if (!isLoaded(label)) return "not-loaded";
  return "not-writing";
}

export function rootDaemonStatus(
  s: RootDaemonSpec,
  problem: RootDaemonProblem,
): RootDaemonStatus {
  return {
    problem,
    plist: rootDaemonPlist(s.label),
    stdio: rootStdioLog(s.dir),
    fix: installRootCommand(s),
  };
}

function mustRun(argv: string[]): void {
  const p = exec(argv);
  if (p.exitCode !== 0)
    throw new Error(
      `${argv.join(" ")} exited ${p.exitCode}: ${(p.stderr || p.stdout).trim()}`,
    );
}

function assertRoot(verb: string): void {
  if (process.geteuid?.() !== 0)
    throw new Error(
      `${verb} installs a LaunchDaemon: run it with sudo (it works from any directory)`,
    );
}

/**
 * Install (or replace) the root daemon in one step that cannot leave a partial
 * plist: render to a temporary file beside the target, check it with `plutil
 * -lint`, rename it into place (atomic), bootstrap it, and check launchd holds
 * it — removing the plist again when launchd refuses it, so a failed install
 * leaves nothing for the user agent to mistake for a daemon.
 */
export function installRoot(s: RootDaemonSpec): void {
  assertRoot("install-root");
  if (!/\.app\/Contents\/MacOS\/[^/]+$/.test(s.executable))
    throw new Error(
      `run install-root from the binary inside the equin app (…/equin.app/Contents/MacOS/fs-latency-monitor), not ${s.executable}: the daemon runs the binary it was installed from, and only the app's copy follows main's builds`,
    );
  if (!statSync(s.dir).isDirectory())
    throw new Error(`${s.dir} is not a directory`);
  const plist = rootDaemonPlist(s.label);
  const tmp = `${plist}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, renderRootDaemonPlist(s), { mode: 0o644 });
    chownSync(tmp, 0, 0);
    mustRun(["plutil", "-lint", tmp]);
    if (isLoaded(s.label))
      mustRun(["launchctl", "bootout", `system/${s.label}`]);
    renameSync(tmp, plist);
  } finally {
    rmSync(tmp, { force: true });
  }
  try {
    mustRun(["launchctl", "bootstrap", "system", plist]);
    if (!isLoaded(s.label))
      throw new Error(
        `launchd does not hold system/${s.label} after bootstrap`,
      );
  } catch (err) {
    rmSync(plist, { force: true });
    throw err;
  }
  process.stdout.write(
    `Installed ${plist}. Its first tick runs now; the user agent stands aside once it lands.\n`,
  );
}

/** Remove the root daemon, and hand every file it wrote back to the log directory's owner. */
export function uninstallRoot(label: string, dir: string): void {
  assertRoot("uninstall-root");
  if (isLoaded(label)) mustRun(["launchctl", "bootout", `system/${label}`]);
  rmSync(rootDaemonPlist(label), { force: true });
  handBack(dir, [dir], true);
  process.stdout.write(
    `Removed the root daemon; the user agent ticks again within ${ROOT_FRESH_INTERVALS} intervals.\n`,
  );
}

/**
 * Give every path (each directory with its entries, recursively when `deep`)
 * to the owner of `dir`, so the user agent can always take over what a root
 * tick wrote. Only what is not theirs already is changed.
 */
export function handBack(dir: string, paths: string[], deep = false): void {
  const { uid, gid } = statSync(dir);
  const visit = (p: string, depth: number): void => {
    let st;
    try {
      st = lstatSync(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (st.uid !== uid || st.gid !== gid) lchownSync(p, uid, gid);
    if (st.isDirectory() && (deep || depth === 0))
      for (const name of readdirSync(p)) visit(join(p, name), depth + 1);
  };
  for (const p of paths) visit(p, 0);
}
