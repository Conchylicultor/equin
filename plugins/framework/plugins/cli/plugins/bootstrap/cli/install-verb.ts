import { INSTALL_VERB } from "../core";
import { STAMP_REL } from "./ensure-deps";

/**
 * `./equin install` — the one verb whose whole work IS the bootstrap, so the
 * bootstrap answers it itself instead of handing it to the CLI.
 *
 * Every invocation runs `ensureDeps()` before the CLI is loaded; `install` asks
 * for exactly that and nothing more. Routing it through the CLI cost, after an
 * install, a re-exec (a fresh Bun, the bootstrap again: git, the dep-input
 * walk, the signature) plus the full CLI import (commander, every command
 * declaration) — ~0.6 s measured on 2026-11-17, a fifth of a cold checkout's
 * install step — only for the verb's body to confirm the stamp `ensureDeps`
 * had just written. Answering here, nothing is re-done: the stamp was written
 * (or found fresh) by this very process, and `ensureDeps` throws otherwise.
 *
 * The verb's NAME is owned by the bootstrap (`../core`), and the `install`
 * plugin's command declaration takes it from there (it stays a declared command so
 * `./equin --help` lists it). That is what keeps the bootstrap's "reads no
 * argv" rule honest: the rule exists because the bootstrap cannot load the
 * declarations, so it may not keep a copy of a set they own — but this name is
 * not theirs, it is the bootstrap's.
 *
 * PRE-INSTALL-SAFE, like the rest of this plugin: relative imports only.
 */

/**
 * Whether the arguments after the entry point are exactly `install`. Anything
 * else (`install --help`, a stray argument) goes to the CLI, which parses it
 * like any other verb.
 */
export function isInstallInvocation(args: readonly string[]): boolean {
  return args.length === 1 && args[0] === INSTALL_VERB;
}

/** The line `./equin install` ends with once `root`'s dependencies are installed. */
export function installedLine(root: string): string {
  return `${INSTALL_VERB}: ${root} is installed (${STAMP_REL})`;
}
