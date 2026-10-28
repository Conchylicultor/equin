// ── The principal handshake: does the gateway in front of me stamp? ─────────
//
// A socket host enforces the principal fail-closed (a missing header is
// anonymous) only when its gateway DECLARES that it stamps one: the bare
// `--principal-stamped` on the backend's launch argv (`backendLaunch` in
// `gateway/worktree.go`, central included). The gateway binary is a shared
// dependency that `./equin build` does not rebuild or restart, so a backend can
// boot behind a gateway older than the stamp. Fail-closed there would refuse
// everything — the gateway's own readiness probe included — and take down
// every namespace until someone restarts it. Without the flag the host serves
// ungated (every caller is the owner, the pre-principal status quo) and says so
// loudly: a boot line, and the health report's Gateway row.

/**
 * The flag the gateway appends to every backend's argv. Pinned to the Go
 * constant (`principalStampedFlag`, `gateway/principal.go`) by the
 * `principal:header-in-sync` check.
 */
export const PRINCIPAL_STAMPED_FLAG = "--principal-stamped";

/** What a host without the stamp logs at boot, and the health report repeats. */
export const UNSTAMPED_GATEWAY_WARNING =
  "this gateway predates the principal stamp (no --principal-stamped on this " +
  "backend's argv): cross-site requests are NOT refused until it is " +
  "restarted: ./equin start --force";

/**
 * Where this process stands: `stamped` / `unstamped` once its serving entry
 * point read its argv, `undeclared` in a process that serves nothing (an exec
 * child, a CLI, a test).
 */
export type PrincipalStamp = "stamped" | "unstamped" | "undeclared";

let declared: boolean | undefined;

/**
 * Read whether the gateway declared it stamps the principal (from argv, passed
 * by the entry point so this module never reads `process`), record it, and
 * return it. Called ONCE, by each socket host's entry point, before it mounts
 * its routes.
 */
export function readPrincipalStamp(argv: readonly string[]): boolean {
  const stamped = argv.includes(PRINCIPAL_STAMPED_FLAG);
  if (declared !== undefined && declared !== stamped) {
    throw new Error(
      `[principal] this process already declared stamped=${declared} and ` +
        `cannot be redeclared stamped=${stamped}.`,
    );
  }
  declared = stamped;
  return stamped;
}

/** This process's stamp, as its entry point declared it. */
export function principalStamp(): PrincipalStamp {
  if (declared === undefined) return "undeclared";
  return declared ? "stamped" : "unstamped";
}

/** Drop the declaration — for this plugin's own tests (imported by path). */
export function resetPrincipalStamp(): void {
  declared = undefined;
}
