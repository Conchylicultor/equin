/**
 * The name of `./equin install`, the one verb whose whole work is the
 * bootstrap's `ensureDeps()` — so the bootstrap answers it itself
 * (`../cli/install-verb.ts`) and the `install` plugin's command declaration
 * takes its name from here. Its own module with no imports, so a declaration
 * (loaded on every `./equin` invocation) can read it without the bootstrap's
 * runtime closure.
 */
export const INSTALL_VERB = "install";
