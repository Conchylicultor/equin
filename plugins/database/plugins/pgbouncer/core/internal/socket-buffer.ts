// The kernel send buffer of every local socket a database reply or statement
// crosses: PgBouncer's own (both towards the app and towards Postgres, rendered
// as `tcp_socket_buffer`) and the app pools' (`database#machine` raises them on
// connect). One number, so the two ends cannot disagree.
//
// Why: on a macOS Unix stream socket the SENDER's SO_SNDBUF bounds what is in
// flight, and it defaults to 8 KB (`net.local.stream.sendspace`). Bun reads a
// socket once per event-loop turn, so a 768 KB reply took 97 reads — 15.1 s on
// a loop whose turns take 150 ms (a backend restarting) — and a 768 KB
// statement 16.9 s to leave the app. With 1 MiB at both ends: 2 reads, 0.16 s,
// and 0.16 s (measured 2026-11-19 through PgBouncer 1.26.1 + the Unix-socket
// patch, research/2026-11-19-global-local-socket-buffers.md).
//
// Why 1 MiB: on main the replies that read slowly were ≤ 880 KB in ~98% of
// calls (slow-op rows' `replyBytes`, 7 days), so one buffer holds them whole;
// the rare 4–6 MB ones go from ~500–800 turns to ~4–6. The buffer is a cap,
// not an allocation — the kernel holds bytes only while a reader lags. Over
// macOS's `kern.ipc.maxsockbuf` (8 MB by default) a setsockopt fails, and
// PgBouncer would then refuse the connection: keep it well under. Linux caps it
// at `net.core.wmem_max` and its Unix-socket default (~208 KB) is already
// larger than macOS's, so there it changes little and never shrinks anything.
export const LOCAL_SOCKET_BUFFER_BYTES = 1024 * 1024;
