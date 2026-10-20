// ── The serving socket: which Unix socket THIS BACKEND answers on ────────────
//
// The second thing the gateway hands a backend at its entry point, beside its
// namespace. Only the gateway knows it: a backend alternates between
// `<ns>.sock` and `<ns>.next.sock` across hot restarts, so the path cannot be
// derived from the namespace.
//
// It arrives as `--socket <path>` on argv, and only there. It used to arrive in
// the environment, and an environment variable reaches every descendant: the
// tmux server when a backend was the first to talk to it, a toolbar build, a
// supervised-exec child, the release and deploy CLIs — each of them "knew" a
// socket that belonged to somebody else, and an exec child that bound it would
// have collided with the live backend. Deleting the variable after reading it
// does not help: a Bun child with no explicit `env` receives the environment the
// process STARTED with, whatever `process.env` says by then.
// `launcher:per-process-env-on-argv` keeps the old name out of code.
//
// Design: research/2026-09-15-global-backend-env-leak-followups.md

const FLAG = "--socket";

let declared: string | undefined;

function argvSocket(argv: readonly string[]): string | undefined {
  const i = argv.indexOf(FLAG);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(
      `[boot] ${FLAG} was given with no value. It names the Unix socket this ` +
        `backend serves on; the gateway dials exactly that path.`,
    );
  }
  return value;
}

/**
 * Read the socket the gateway handed this serving backend (from its argv,
 * passed by the entry point so this module never reads `process`), record it,
 * and return it. Called ONCE, by each serving entry point, just before it binds
 * (`server-core/bin/index.ts`, `central-core/bin/index.ts`). An `exec` child
 * serves nothing and never calls it.
 *
 * Throws when `--socket` is missing. A backend with no socket is unreachable,
 * so booting on would only fail later and less clearly.
 */
export function readServingSocket(argv: readonly string[]): string {
  const path = argvSocket(argv);
  if (path === undefined) {
    throw new Error(
      `[boot] this backend was spawned without ${FLAG} <path>. The gateway ` +
        `passes it (gateway/worktree.go); a hand-run backend has to pass it ` +
        `itself. It names the Unix socket this backend serves on. A gateway ` +
        `started before the argv contract passes it in the environment ` +
        `instead — restart it with ./singularity start.`,
    );
  }
  if (declared !== undefined && declared !== path) {
    throw new Error(
      `[runtime-identity] this process already serves on "${declared}" and ` +
        `cannot be redeclared to serve on "${path}".`,
    );
  }
  declared = path;
  return path;
}

/**
 * The socket this backend serves on, for code that must reach its own backend
 * over HTTP. Throws when this process never declared one: a CLI, a test or an
 * `exec` child serves nothing, and handing it some other process's socket is
 * the leak this module exists to end.
 */
export function servingSocketPath(): string {
  if (declared === undefined) {
    throw new Error(
      "[runtime-identity] this process serves on no socket. Only a " +
        "gateway-spawned backend has one, declared by its entry point via " +
        "readServingSocket(); an exec child, a CLI and a test do not.",
    );
  }
  return declared;
}

/** Drop the declaration. TEST ONLY. */
export function resetServingSocketForTest(): void {
  declared = undefined;
}
