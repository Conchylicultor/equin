# Local socket buffers: a database reply no longer reaches the app 8 KB at a time

Task: "Database replies reach the app 8 KB at a time on macOS" (user decision
D6 = B: bigger buffers, no root). Background: commit 82d278f292 (the
`replyReads` / `replyBytes` measures) and `database/connection`'s CLAUDE.md,
"A reply is read one socket buffer per event-loop turn".

## The cause

On macOS a Unix stream socket's flow window is the **sender's** `SO_SNDBUF`
(`net.local.stream.sendspace` = 8192; the receiver's `SO_RCVBUF` is not
consulted). Bun reads (and writes) a socket once per event-loop turn. So a
reply of N KB costs ~N/8 turns, and a statement of N KB likewise to send. On an
idle loop that is invisible; on a busy one (a backend restarting, ~150 ms per
turn) it is seconds.

Every hop is a Unix socket: app ↔ PgBouncer (`listen_addr =` empty), and
PgBouncer ↔ Postgres. PgBouncer applies `tcp_socket_buffer` only to TCP
sockets (`tune_socket` returns before it for `is_unix`); Postgres sets no
`SO_SNDBUF` on a Unix socket.

## Measured on main (slow-op rows, `replyBytes` / `replyReads`)

Bytes per read over every slow db op that carries the measures: 3.8 KB
(< 64 KB replies), 7.7 KB (64–256 KB), 7.8 KB (256 KB–1 MB), 8.2 KB (1–4 MB),
7.6 KB (> 4 MB) — the 8 KB cap. 643 calls had replies of 256 KB–880 KB (765 s
of slow time), 117 calls 4–6 MB (229 s); the largest, 6.1 MB in 807 reads.

## Before / after (bench, 150 ms event-loop turns)

`$EQUIN_SCRATCH` harness: a `pg` client on a loop busy 150 ms per turn reads
`select repeat('x', N)` and sends `select length($1)` with an N-byte param,
through a scratch PgBouncer on the real cluster (darwinbg tier; the times are
dominated by turn counts, not CPU).

| path | read 768 KB | write 768 KB |
|---|---|---|
| direct to Postgres | 97 reads, 15.5 s | 15.0 s |
| PgBouncer 1.26.1, `tcp_socket_buffer = 1 MiB` (ignored) | 97 reads, 15.1 s | 16.9 s |
| patched, unset | 97 reads, 15.7 s | 16.2 s |
| patched, 256 KiB | 4 reads, 0.83 s | 15.4 s |
| patched, 1 MiB | 2 reads, 0.16 s | 14.7 s |
| patched 1 MiB + app `SO_SNDBUF` 1 MiB | 2 reads, 0.15 s | 0.155 s |
| same, 4 MB reply / param | 10 reads, 0.70 s | 0.60 s |
| patched 4 MiB + app 4 MiB, 4 MB | 9 reads, 0.16 s | 0.15 s |

Raw socket (python sender → Bun reader, 768 KB): 8 KB 96 reads 14.6 s; 64 KB
12 reads 2.0 s; 256 KB 3 reads 0.61 s; 1 MiB 2 reads 0.31 s.

The Postgres → PgBouncer hop stays at Postgres's 8 KB, but PgBouncer's loop
drains it at once: it does not reach the app's turns (the 0.16 s rows include
it). Direct connections (admin, jobs, LISTEN) keep 8 KB from Postgres; they are
not measured (`replyReads` is on the app pools only).

## The size: 1 MiB

The replies that read slowly on main are ≤ 880 KB for ~98% of calls, so one
buffer holds them whole; the 4–6 MB ones go from ~500–800 turns to ~4–6. The
buffer is a cap, not an allocation: the kernel holds bytes only while a reader
lags (mbuf pool here: 262 144 clusters). 4 MiB would make the rare 4–6 MB
replies one turn too, at 4× the worst-case kernel memory per lagging socket;
not worth it for ~1% of calls. Over `kern.ipc.maxsockbuf` (8 MB) setsockopt
fails, and PgBouncer would refuse the connection — 1 MiB is far below.
Linux: Unix-socket default ~208 KB (`wmem_default`), an unprivileged raise is
capped at `wmem_max`, and the raise never lowers a buffer: behaviour there is
unchanged or larger.

## What shipped

1. **PgBouncer** (github.com/equinai/pgbouncer-embedded, PR #1):
   `patches/0001-unix-socket-buffer.patch` makes `tune_socket` apply
   `tcp_socket_buffer` (`SO_SNDBUF` and `SO_RCVBUF`) before its Unix-socket
   early return, so it covers client-facing and server-facing Unix sockets.
   The existing key, on purpose: the rendered config stays valid for an
   unpatched binary (it applies it to no socket — we have no TCP listener), so
   no config has to depend on which binary a machine has pinned.
   `build.sh` applies `patches/*.patch` (dry-run first; a patch that stops
   applying fails the build naming itself).
2. **Patch-only releases**: a wrapper version carries a rebuild count in its
   patch — PgBouncer X.Y.Z rebuild R is `X.Y.(Z*100+R)` (`scripts/version.sh`;
   versions ≤ 1.26.1 are as before). Plain `X.Y.Z` stays inside `^` ranges
   (a prerelease suffix sorts below the release and outside `^`), and every
   later upstream release sorts above every rebuild. The workflow takes
   `version` + `rebuild`; the daily run never shadows a rebuild. equin's npm
   updater reads it through `wraps.revisions` (`wrappedRelease`), so a rebuild
   of 1.26.1 never reads as wrapping 1.26.2. Published: 1.26.101.
3. **App side**: `packages/socket-buffer` (`raiseSocketSendBuffer`, bun:ffi
   setsockopt) and the lane pools raise each connection's `SO_SNDBUF` to
   `LOCAL_SOCKET_BUFFER_BYTES` as pg-pool's `onConnect` (`database#machine`,
   through `createDbPool`'s new `onConnect` option): a failure fails that
   acquire, where a throwing `connect` listener — run from pg's socket data
   handler — would have been an uncaught exception.
4. **Config**: `renderPgbouncerConfig` renders `tcp_socket_buffer =
   LOCAL_SOCKET_BUFFER_BYTES` (one constant for both ends).

## Guards

- `pgbouncer:unix-socket-buffer` (check, every build/push): runs the declared
  PgBouncer binary with the rendered config between a fake Postgres (its own
  process) and a client that blocks its loop after its query until the fake
  has handed the whole reply to the kernel (a marker file; at most 3 s — an
  unpatched PgBouncer never lets it finish) plus 200 ms; fails if a 768 KB
  reply takes more than 4 reads (macOS). 1.26.1: 97 reads (fails); 1.26.101: 2.
- `packages/socket-buffer` tests: the raise, never lowering, and a 768 KB
  write fully in flight once raised (still fully queued without it).
- pgbouncer-embedded CI: every build applies the patch or fails.

## Rollout

The binary is pinned per machine (`pgbouncer-binary`): main keeps running
1.26.1 until `./equin deps pin pgbouncer-binary` and a PgBouncer restart
(the health report's Pinned binaries row shows the lag). The config change and
the app-side raise apply at main's next deploy on their own; the read side
needs the switch.

## Upstream proposal (prepared, NOT posted — the user decides)

A short write-up for github.com/pgbouncer/pgbouncer:

> **Apply `tcp_socket_buffer` to Unix-domain sockets too**
>
> On macOS, a Unix stream socket's send buffer defaults to 8 KB
> (`net.local.stream.sendspace`), and for Unix sockets the sender's buffer is
> what bounds the data in flight. PgBouncer applies `tcp_socket_buffer` to TCP
> sockets only (`tune_socket` returns early when `is_unix`), so a client
> connected over the Unix socket receives a large result 8 KB per wakeup. For a
> client with a busy event loop (Node/Bun), a 768 KB result took 97 reads —
> 15 s at 150 ms per loop turn; with the buffer applied, 2 reads and 0.16 s.
>
> The change moves the `SO_SNDBUF`/`SO_RCVBUF` block above the Unix early
> return (patch attached; docs updated). If changing what an existing setting
> does is unwelcome, the same code under a new `unix_socket_buffer` setting
> works equally — happy to send either.
>
> (Opus 5.5, on behalf of <author>)

The patch: `patches/0001-unix-socket-buffer.patch` in pgbouncer-embedded.
