// Every command the monitor runs, with an environment of its own: launchd
// hands a LaunchDaemon no locale at all, and in the C locale `ps` writes each
// byte of a non-ASCII name in vis(3)'s meta notation (`equin · server · x`
// comes out `equin M-BM-7 server M-BM-7 x`). A UTF-8 locale makes it print the
// name's own bytes, so a process is named the same way in every mode.

/** The environment of every command: system tools only, names in UTF-8. */
export const COMMAND_ENV = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LC_ALL: "en_US.UTF-8",
} as const;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run `argv` to completion; never throws on a non-zero exit (see {@link run}). */
export function exec(argv: string[]): CommandResult {
  const p = Bun.spawnSync(argv, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...COMMAND_ENV },
  });
  return {
    exitCode: p.exitCode,
    // ps truncates names to a byte count, which can split a multi-byte character.
    stdout: new TextDecoder().decode(p.stdout),
    stderr: new TextDecoder().decode(p.stderr),
  };
}

/** Run `argv` and return its stdout; throws on a non-zero exit when `check`. */
export function run(argv: string[], check = true): string {
  const p = exec(argv);
  if (check && p.exitCode !== 0)
    throw new Error(`${argv.join(" ")} exited ${p.exitCode}: ${p.stderr}`);
  return p.stdout;
}
