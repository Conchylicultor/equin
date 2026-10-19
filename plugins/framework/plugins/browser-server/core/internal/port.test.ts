/**
 * A browser server across a real MessageChannel: the page side
 * (`portBrowserServer`) reads, subscribes and gets acks from a server served by
 * the worker side (`serveOverPort`) exactly as it would in-process; a boot that
 * throws rejects the page side with the worker's error; and
 * `composeBrowserServers` routes reads and subscriptions — a split `sub-batch`
 * included — to the server owning each key.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  PROTOCOL,
  type ServerFrame,
} from "@plugins/packages/plugins/resource-protocol/core";
import { createBrowserServer, type BrowserServer } from "./browser-server";
import { composeBrowserServers } from "./compose";
import { PortHostBootError, portBrowserServer, serveOverPort } from "./port";

let seq = 0;
const key = (name: string) => `test.browser-server-port.${name}.${seq++}`;

const greeting = liveValue(key("greeting"), {
  schema: z.object({ text: z.string() }),
  params: ["who"],
});
const farewell = liveValue(key("farewell"), {
  schema: z.object({ text: z.string() }),
});

function greetingServer(prefix: string): BrowserServer {
  return createBrowserServer({
    serve: (s) => [
      s.serveValue(greeting, {
        source: "external",
        changes: { fixed: { reason: "test fixture" } },
        loader: ({ who }) => ({ text: `${prefix} ${who}` }),
      }),
    ],
    unserved: (k) => new Error(`not served here: ${k}`),
  });
}

function farewellServer(): BrowserServer {
  return createBrowserServer({
    serve: (s) => [
      s.serveValue(farewell, {
        source: "external",
        changes: { fixed: { reason: "test fixture" } },
        loader: () => ({ text: "bye" }),
      }),
    ],
    unserved: (k) => new Error(`not served here: ${k}`),
  });
}

/** A worker-side server behind one end of a fresh channel; the page side on the other. */
async function overChannel(worker: BrowserServer, keys: string[]) {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();
  void serveOverPort(channel.port2, async () => ({
    server: worker,
    keys: new Set(keys),
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
    const { server, keys } = await overChannel(greetingServer("hello"), [
      greeting.key,
    ]);
    expect([...keys]).toEqual([greeting.key]);

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

describe("composeBrowserServers", () => {
  test("routes reads, subs and a split sub-batch to each key's server", async () => {
    const worker = await overChannel(greetingServer("from worker"), [
      greeting.key,
    ]);
    const page = farewellServer();
    const composed = composeBrowserServers([worker], page);

    const read = async (k: string, query = "") => {
      const res = await composed.request(
        new Request(`http://x/api/resources/${k}${query}`),
      );
      return ((await res.json()) as { value: unknown }).value;
    };
    expect(await read(greeting.key, "?who=ada")).toEqual({
      text: "from worker ada",
    });
    expect(await read(farewell.key)).toEqual({ text: "bye" });

    const r = recorder();
    const socket = composed.connect(r.peer);
    socket.send(
      JSON.stringify({
        op: "sub-batch",
        tabId: "tab",
        build: "dev",
        protocol: PROTOCOL,
        complete: true,
        entries: [
          { id: 1, key: greeting.key, params: { who: "bob" } },
          { id: 2, key: farewell.key, params: {} },
        ],
      }),
    );
    const g = await r.next(
      (f) => f.kind === "sub-ack" && f.key === greeting.key,
    );
    const f = await r.next(
      (f) => f.kind === "sub-ack" && f.key === farewell.key,
    );
    expect(g).toMatchObject({ value: { text: "from worker bob" } });
    expect(f).toMatchObject({ value: { text: "bye" } });
    socket.close();
    composed.dispose();
  });
});
