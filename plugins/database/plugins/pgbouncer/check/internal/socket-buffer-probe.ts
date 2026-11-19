// The `pgbouncer:unix-socket-buffer` check's probe: does the PgBouncer this
// checkout declares, run with the config this checkout renders, hand a client a
// large reply in a few socket reads over a Unix socket?
//
//   probe.ts <pgbouncer binary>                       — the probe (one JSON line)
//   probe.ts server <socket> <bytes> <sent marker>    — the fake Postgres it starts
//
// A fake Postgres (its own process, so it keeps sending while the probe blocks
// its loop) answers any query with one row of <bytes> bytes. The probe sends a
// query through PgBouncer and blocks its own event loop — as a busy backend
// does — until the fake has handed its whole reply to the kernel (a marker
// file), plus SETTLE_MS for PgBouncer to relay its last buffer; then it counts
// the reads the reply takes. With PgBouncer's send buffer at
// LOCAL_SOCKET_BUFFER_BYTES the reply sits in the kernel whole and takes a few
// reads; at macOS's 8 KB default it takes ~97, one per refill.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "@plugins/packages/plugins/timed-fs/core";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPgbouncerConfig } from "@plugins/database/plugins/pgbouncer/core";

export const REPLY_BYTES = 768 * 1024;
const SETTLE_MS = 200;
/**
 * How long the probe blocks waiting for the fake to finish sending. A reply
 * that does not fit in flight never finishes while the client does not read —
 * the very failure probed — so this ends the block, not the probe.
 */
const SENT_WAIT_MS = 3_000;
const PG_PORT = 5999;
const LISTEN_PORT = 6999;
const USER = "probe";

function message(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.write(type, 0, "latin1");
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}
const int32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const cstr = (s: string) => Buffer.from(`${s}\0`, "utf8");
const READY = message("Z", Buffer.from("I"));
const param = (name: string, value: string) =>
  message("S", Buffer.concat([cstr(name), cstr(value)]));

/** The fake Postgres: trust login, and one big row for every query. */
function serve(socketPath: string, bytes: number, sentMarker: string): void {
  const row = message(
    "D",
    Buffer.concat([
      Buffer.from([0, 1]),
      int32(bytes),
      Buffer.alloc(bytes, 120),
    ]),
  );
  const description = message(
    "T",
    Buffer.concat([
      Buffer.from([0, 1]),
      cstr("r"),
      int32(0),
      Buffer.from([0, 0]),
      int32(25),
      Buffer.from([0xff, 0xff]),
      int32(-1),
      Buffer.from([0, 0]),
    ]),
  );
  const reply = Buffer.concat([
    description,
    row,
    message("C", cstr("SELECT 1")),
    READY,
  ]);
  createServer((s: Socket) => {
    let buf = Buffer.alloc(0);
    let started = false;
    s.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (!started) {
          if (buf.length < 8) return;
          const len = buf.readInt32BE(0);
          if (buf.length < len) return;
          const code = buf.readInt32BE(4);
          buf = buf.subarray(len);
          if (code === 80877103) {
            s.write("N"); // SSLRequest: no TLS here
            continue;
          }
          started = true;
          s.write(
            Buffer.concat([
              message("R", int32(0)),
              param("server_version", "18.0"),
              param("client_encoding", "UTF8"),
              param("standard_conforming_strings", "on"),
              message("K", Buffer.concat([int32(1), int32(2)])),
              READY,
            ]),
          );
          continue;
        }
        if (buf.length < 5) return;
        const len = buf.readInt32BE(1);
        if (buf.length < len + 1) return;
        const type = String.fromCharCode(buf[0]!);
        buf = buf.subarray(len + 1);
        // Once every byte is in the kernel, PgBouncer has read all but the
        // last socket buffer of it: say so through the marker.
        if (type === "Q") s.write(reply, () => writeFileSync(sentMarker, ""));
        if (type === "X") s.end();
      }
    });
  }).listen(socketPath, () => process.stdout.write("ready\n"));
}

const endsReady = (all: Buffer) =>
  all.length >= READY.length && all.subarray(-READY.length).equals(READY);

/**
 * Read from `s` until a ReadyForQuery ends what arrived, counting reads. A
 * socket that closes or errors first rejects, naming what it had sent — never
 * a wait for the check's timeout.
 */
function readUntilReady(
  s: Socket,
): Promise<{ reads: number; bytes: number; all: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let reads = 0;
    const settle = (fn: () => void) => {
      s.off("data", onData);
      s.off("error", onError);
      s.off("close", onClose);
      fn();
    };
    const onData = (c: Buffer) => {
      reads++;
      chunks.push(c);
      const all = Buffer.concat(chunks);
      if (endsReady(all))
        settle(() => resolve({ reads, bytes: all.length, all }));
    };
    const onError = (err: Error) => settle(() => reject(err));
    const onClose = () =>
      settle(() =>
        reject(
          new Error(
            `pgbouncer closed the connection before ReadyForQuery: ${Buffer.concat(chunks).toString("latin1").slice(0, 200)}`,
          ),
        ),
      );
    s.on("data", onData);
    s.on("error", onError);
    s.on("close", onClose);
  });
}

async function probe(binary: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pgb-probe-"));
  const sentMarker = join(dir, "sent");
  const children: { kill(): void }[] = [];
  try {
    const server = spawn(
      process.execPath,
      [
        import.meta.path,
        "server",
        join(dir, `.s.PGSQL.${PG_PORT}`),
        String(REPLY_BYTES),
        sentMarker,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    children.push(server);
    await new Promise<void>((resolve, reject) => {
      server.stdout!.once("data", () => resolve());
      server.once("exit", (code) =>
        reject(new Error(`fake Postgres exited (${code})`)),
      );
    });

    const { ini, userlist } = renderPgbouncerConfig({
      baseUser: USER,
      socketDir: dir,
      pgPort: PG_PORT,
      listenPort: LISTEN_PORT,
      userlistFile: join(dir, "userlist.txt"),
      pidFile: join(dir, "pgbouncer.pid"),
      maxConnections: 1000,
    });
    writeFileSync(join(dir, "userlist.txt"), userlist);
    writeFileSync(
      join(dir, "pgbouncer.ini"),
      `${ini}logfile = ${join(dir, "pgbouncer.log")}\n`,
    );
    const bouncer = spawn(binary, [join(dir, "pgbouncer.ini")], {
      stdio: "ignore",
    });
    children.push(bouncer);
    let exited: string | null = null;
    bouncer.once("exit", (code, signal) => (exited = signal ?? `code ${code}`));

    const path = join(dir, `.s.PGSQL.${LISTEN_PORT}`);
    let client: Socket | null = null;
    for (let i = 0; i < 100 && client === null; i++) {
      if (exited !== null)
        throw new Error(
          `pgbouncer exited (${exited}); see ${dir}/pgbouncer.log`,
        );
      client = await new Promise<Socket | null>((resolve) => {
        const s = connect(path);
        s.once("connect", () => resolve(s));
        s.once("error", () => resolve(null));
      });
      if (client === null) await Bun.sleep(50);
    }
    if (client === null)
      throw new Error("pgbouncer never accepted on its socket");

    const login = readUntilReady(client);
    const startup = Buffer.concat([
      int32(196608),
      cstr("user"),
      cstr(USER),
      cstr("database"),
      cstr("probe"),
      Buffer.from([0]),
    ]);
    client.write(Buffer.concat([int32(startup.length + 4), startup]));
    const loggedIn = await login;
    if (loggedIn.all[0] !== "R".charCodeAt(0))
      throw new Error(
        `pgbouncer refused the login: ${loggedIn.all.toString("latin1").slice(0, 200)}`,
      );

    const reply = readUntilReady(client);
    client.write(message("Q", cstr("select big")), () => {
      // Block the loop as a busy backend does, until the fake has sent the
      // whole reply and PgBouncer has had SETTLE_MS to relay its last buffer
      // — everything PgBouncer can put in flight is then in the kernel when
      // this loop next reads — or SENT_WAIT_MS passed: the reply did not fit
      // in flight, and the reads below show it.
      const deadline = Date.now() + SENT_WAIT_MS;
      while (!existsSync(sentMarker) && Date.now() < deadline) Bun.sleepSync(5);
      Bun.sleepSync(SETTLE_MS);
    });
    const { reads, bytes } = await reply;
    if (bytes <= REPLY_BYTES)
      throw new Error(
        `the reply ended after ${bytes} bytes, not the ${REPLY_BYTES}-byte row`,
      );
    client.destroy();
    process.stdout.write(`${JSON.stringify({ reads, bytes })}\n`);
  } finally {
    for (const c of children) c.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [first, ...rest] = process.argv.slice(2);
  if (first === "server") serve(rest[0]!, Number(rest[1]), rest[2]!);
  else await probe(first!);
}
