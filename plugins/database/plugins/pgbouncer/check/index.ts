import { dirname, join, resolve } from "node:path";
import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { LOCAL_SOCKET_BUFFER_BYTES } from "@plugins/database/plugins/pgbouncer/core";

const PROBE = resolve(import.meta.dir, "internal/socket-buffer-probe.ts");
const PROBE_TIMEOUT_MS = 60_000;
const PLUGIN_DIR = resolve(import.meta.dir, "..");

/**
 * Reads of a 768 KB reply the probe accepts. macOS: the reply fits PgBouncer's
 * send buffer whole, so it takes 1–2 reads (97 at the 8 KB default). Linux
 * caps an unprivileged buffer at `net.core.wmem_max` (~208 KB by default), so a
 * few more there — still far from one read per 8 KB.
 */
const MAX_READS = process.platform === "darwin" ? 4 : 24;

/** This platform's `@equin/pgbouncer-*` binary, as the checkout installed it. */
function declaredBinary(): string | { missing: string } {
  const arch =
    process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  const name = `@equin/pgbouncer-${process.platform}-${arch}`;
  if (arch === null || !["darwin", "linux"].includes(process.platform))
    return {
      missing: `no @equin/pgbouncer package is built for ${process.platform}-${process.arch}`,
    };
  try {
    const pkg = Bun.resolveSync(`${name}/package.json`, PLUGIN_DIR);
    return join(dirname(pkg), "native", "bin", "pgbouncer");
  } catch (err) {
    return { missing: `${name} is not installed (${(err as Error).message})` };
  }
}

/**
 * The PgBouncer this checkout declares, run with the config it renders, hands
 * a client a large reply over a Unix socket in a few reads — the guard on
 * `LOCAL_SOCKET_BUFFER_BYTES` reaching PgBouncer's sockets. Our build patches
 * PgBouncer to apply `tcp_socket_buffer` to Unix sockets too
 * (github.com/equinai/pgbouncer-embedded `patches/`); an upgrade to a binary
 * without the patch, or a config that stops rendering the key, puts the 8 KB
 * macOS default back: a 768 KB reply in 97 reads, 15 s on a busy backend.
 *
 * Behavioural on purpose — the probe runs the real binary between a fake
 * Postgres and a client that blocks its loop as a busy backend does, so it
 * cannot pass on a version number. Keyed on the tree (bun.lock names the
 * binary). ~0.5 s.
 */
const unixSocketBuffer: Check = {
  id: "pgbouncer:unix-socket-buffer",
  description:
    "the declared PgBouncer binary, with the rendered config, sends a large reply over a Unix socket in a few reads (its send buffer is LOCAL_SOCKET_BUFFER_BYTES, not macOS's 8 KB)",
  async run(): Promise<CheckResult> {
    const binary = declaredBinary();
    if (typeof binary !== "string")
      return {
        ok: false,
        message: binary.missing,
        hint: "Run `bun install` in the checkout.",
      };
    const probe = await spawnCaptured([process.execPath, PROBE, binary], {
      cwd: PLUGIN_DIR,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const last = probe.stdout.trim().split("\n").at(-1) ?? "";
    if (probe.exitCode !== 0 || !last.startsWith("{"))
      return {
        ok: false,
        message: `the socket-buffer probe failed (exit ${probe.exitCode}): ${probe.stderr.trim() || last}`,
      };
    const { reads, bytes } = JSON.parse(last) as {
      reads: number;
      bytes: number;
    };
    if (reads <= MAX_READS) return { ok: true };
    return {
      ok: false,
      message:
        `${binary} sent a ${Math.round(bytes / 1024)} KB reply over a Unix socket in ${reads} reads ` +
        `(at most ${MAX_READS} with a ${LOCAL_SOCKET_BUFFER_BYTES} B send buffer): its Unix sockets keep the OS default buffer. ` +
        "On macOS that is 8 KB, so a backend reads a large reply one 8 KB read per event-loop turn.",
      hint:
        "The binary lacks equinai/pgbouncer-embedded's Unix-socket-buffer patch (patches/), or renderPgbouncerConfig stopped rendering `tcp_socket_buffer`. " +
        "Restore the patch there and publish a rebuild (README § Patch-only rebuilds), then upgrade @equin/pgbouncer-* here.",
    };
  },
};

export default unixSocketBuffer;
