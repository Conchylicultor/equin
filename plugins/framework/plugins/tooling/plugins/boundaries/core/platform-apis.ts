/**
 * What counts as a PLATFORM API: a module that only exists on a host process —
 * the computer's filesystem, processes, sockets, native addons, the Postgres
 * client and the job queue built on it. Code that must run on every host (the
 * desktop backend and the browser) may not import one; the folders that must
 * are the `forbidden` rows of `platformApis` in `./boundary-config`.
 *
 * Plain data, read by two consumers that must agree: the
 * `boundaries/no-platform-api` lint rule (one file's own imports) and the
 * `boundaries:portable-closure` check (every module a portable server barrel
 * loads). It imports nothing, so a lint rule can load it under jiti.
 */

/** Specifier prefixes that are platform APIs whatever follows them. */
const PLATFORM_PREFIXES = ["node:", "bun:"] as const;

/**
 * The unprefixed Node builtins (`isBuiltin`'s bare names, by their first
 * segment — `fs` also covers `fs/promises`). Spelled out rather than read from
 * `node:module`, which this file may not import; `platform-apis.test.ts` holds
 * the list to the runtime's own `builtinModules`.
 */
export const NODE_BUILTIN_ROOTS = [
  "_http_agent",
  "_http_client",
  "_http_common",
  "_http_incoming",
  "_http_outgoing",
  "_http_server",
  "_stream_duplex",
  "_stream_passthrough",
  "_stream_readable",
  "_stream_transform",
  "_stream_wrap",
  "_stream_writable",
  "_tls_common",
  "_tls_wrap",
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
] as const;

/**
 * npm packages (and Bun's own module) that are platform APIs, matched as the
 * package itself or any subpath of it.
 */
const PLATFORM_PACKAGES = [
  "bun",
  "bun-pty",
  "pg",
  "@parcel/watcher",
  "drizzle-orm/node-postgres",
  ...NODE_BUILTIN_ROOTS,
] as const;

/** Package-name prefixes: every `pg-*` package and graphile-worker's family. */
const PLATFORM_PACKAGE_PREFIXES = ["pg-", "graphile-worker"] as const;

/** Whether importing `specifier` reaches a platform API. */
export function isPlatformApi(specifier: string): boolean {
  if (PLATFORM_PREFIXES.some((p) => specifier.startsWith(p))) return true;
  if (
    PLATFORM_PACKAGES.some(
      (p) => specifier === p || specifier.startsWith(`${p}/`),
    )
  ) {
    return true;
  }
  return PLATFORM_PACKAGE_PREFIXES.some((p) => specifier.startsWith(p));
}
