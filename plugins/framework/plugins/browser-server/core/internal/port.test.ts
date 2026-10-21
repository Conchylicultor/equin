/**
 * A browser server across a real MessageChannel: the page side
 * (`portBrowserServer`) reads, subscribes and gets acks from a server served by
 * the worker side (`serveOverPort`) exactly as it would in-process; a boot that
 * throws rejects the page side with the worker's error.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { liveValue, serveValueOn } from "@plugins/network/plugins/live/core";
import {
  PROTOCOL,
  type ServerFrame,
} from "@plugins/packages/plugins/resource-protocol/core";
import { inRealmServer } from "../testing";
import type { BrowserServer } from "./browser-server";
import { PortHostBootError, portBrowserServer, serveOverPort } from "./port";

let seq = 0;
const key = (name: string) => `test.browser-server-port.${name}.${seq++}`;

const greeting = liveValue(key("greeting"), {
  schema: z.object({ text: z.string() }),
  params: ["who"],
});
function greetingServer(prefix: string): BrowserServer {
  return inRealmServer({
    serve: (rt) => {
      serveValueOn(
        rt,
        greeting,
        {
          source: "external",
          changes: { fixed: { reason: "test fixture" } },
          loader: ({ who }: { who: string }) => ({ text: `${prefix} ${who}` }),
        },
        { sources: "external" },
      );
    },
  });
}

const BOOT = {
  plugins: 3,
  stages: [{ name: "graph", ms: 12 }],
  slowest: [{ label: "onReadyBlocking:db", ms: 9 }],
};

/** A worker-side server behind one end of a fresh channel; the page side on the other. */
async function overChannel(worker: BrowserServer, keys: string[]) {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();
  void serveOverPort(channel.port2, async () => ({
    server: worker,
    keys: new Set(keys),
    boot: BOOT,
  }));
  return portBrowserServer(channel.port1);
}

/** Every frame a socket receives, and a wait for the first one matching. */
function recorder() {
  const frames: ServerFrame[] = [];
  const waiters: Array<() => void> = [];
  return {
    frames,
    peer: {
      deliver(frame: string) {
        frames.push(JSON.parse(frame) as ServerFrame);
        for (const w of waiters.splice(0)) w();
      },
      closed() {},
    },
    async next(pred: (f: ServerFrame) => boolean): Promise<ServerFrame> {
      for (;;) {
        const hit = frames.find(pred);
        if (hit !== undefined) return hit;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
}

const sub = (id: number, k: string, params: Record<string, string>) =>
  JSON.stringify({
    op: "sub",
    id,
    key: k,
    params,
    tabId: "tab",
    build: "dev",
    protocol: PROTOCOL,
  });

describe("a browser server over a port", () => {
  test("reads and subscribes like the server it carries", async () => {
    const { server, keys, boot, readyAtMs } = await overChannel(
      greetingServer("hello"),
      [greeting.key],
    );
    expect([...keys]).toEqual([greeting.key]);
    expect(boot).toEqual(BOOT);
    expect(readyAtMs).toBeGreaterThanOrEqual(0);

    const res = await server.request(
      new Request(`http://x/api/resources/${greeting.key}?who=ada`),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { value: unknown }).value).toEqual({
      text: "hello ada",
    });

    const r = recorder();
    const socket = server.connect(r.peer);
    socket.send(sub(1, greeting.key, { who: "bob" }));
    const ack = await r.next((f) => f.kind === "sub-ack");
    expect(ack).toMatchObject({
      key: greeting.key,
      value: { text: "hello bob" },
    });
    socket.close();
    server.dispose();
  });

  test("a boot that throws rejects the page side with the worker's error", async () => {
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    const served = serveOverPort(channel.port2, async () => {
      throw new Error("migration 42 failed");
    });
    const page = portBrowserServer(channel.port1);
    const [workerErr, pageErr] = await Promise.all([
      served.then(
        () => null,
        (e: unknown) => e,
      ),
      page.then(
        () => null,
        (e: unknown) => e,
      ),
    ]);
    expect((workerErr as Error).message).toBe("migration 42 failed");
    expect(pageErr).toBeInstanceOf(PortHostBootError);
    expect((pageErr as PortHostBootError).message).toContain(
      "migration 42 failed",
    );
  });
});
