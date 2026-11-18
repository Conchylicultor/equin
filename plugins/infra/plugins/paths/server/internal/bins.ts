export const GIT = Bun.which("git") ?? "git";
export const PGREP = Bun.which("pgrep") ?? "pgrep";
export const PS = Bun.which("ps") ?? "ps";
export const LSOF = Bun.which("lsof") ?? "/usr/sbin/lsof";
/** macOS `sample`: a native stack sample of a running process. */
export const SAMPLE = Bun.which("sample") ?? "sample";
/** `mkfifo`: makes a named pipe. */
export const MKFIFO = Bun.which("mkfifo") ?? "mkfifo";
