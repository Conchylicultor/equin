import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { raiseSocketSendBuffer, socketBufferSizes } from "./socket-buffer";

const MiB = 1024 * 1024;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** A connected Unix-socket pair whose server side never reads. */
async function unixPair(): Promise<{ client: Socket; peer: Socket }> {
  const dir = mkdtempSync(join(tmpdir(), "socket-buffer-"));
  const path = join(dir, "s.sock");
  let peer!: Socket;
  const server: Server = createServer((s) => {
    peer = s;
    s.pause();
  });
  await new Promise<void>((r) => server.listen(path, r));
  const client = connect(path);
  await new Promise<void>((r) => client.once("connect", () => r()));
  while (peer === undefined) await Bun.sleep(1);
  cleanups.push(() => {
    client.destroy();
    peer.destroy();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { client, peer };
}

describe("raiseSocketSendBuffer", () => {
  test("raises SO_SNDBUF to at least the asked size", async () => {
    const { client } = await unixPair();
    const r = raiseSocketSendBuffer(client, MiB);
    expect(socketBufferSizes(client).send).toBe(r.after);
    // macOS keeps the value set; Linux reports twice what it kept, capped at
    // net.core.wmem_max — never below its ~208 KB default.
    if (process.platform === "darwin") expect(r.after).toBe(MiB);
    else expect(r.after).toBeGreaterThanOrEqual(r.before);
  });

  test("never lowers a buffer already larger", async () => {
    const { client } = await unixPair();
    raiseSocketSendBuffer(client, 2 * MiB);
    const r = raiseSocketSendBuffer(client, 64 * 1024);
    expect(r.after).toBe(r.before);
  });

  // The behaviour it exists for: with the raised buffer the kernel takes a
  // 768 KB write at once, though the reader has not read a byte — so the
  // write leaves the process in one event-loop turn, not ~96. Without the
  // raise the whole write is still queued here (macOS's 8 KB default).
  // macOS only: Linux caps an unprivileged raise at net.core.wmem_max.
  test.skipIf(process.platform !== "darwin")(
    "a 768 KB write fits in flight once raised",
    async () => {
      const { client } = await unixPair();
      raiseSocketSendBuffer(client, MiB);
      client.write(Buffer.alloc(768 * 1024));
      await Bun.sleep(20);
      expect(client.writableLength).toBe(0);
    },
  );

  test("a socket that is not connected is refused loudly", () => {
    const s = connect(join(tmpdir(), "socket-buffer-missing.sock"));
    s.on("error", () => {});
    cleanups.push(() => s.destroy());
    expect(() => raiseSocketSendBuffer(s, MiB)).toThrow(/file descriptor/);
  });
});
