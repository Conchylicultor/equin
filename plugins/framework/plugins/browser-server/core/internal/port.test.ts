/**
 * A browser server across a real MessageChannel: the page side
 * (`portBrowserServer`) reads, subscribes and gets acks from a server served by
 * the worker side (`serveOverPort`) exactly as it would in-process; a boot that
 * throws rejects the page side with the worker's error; a port attached to the
 * worker answers requests too, the page's own sockets untouched; what the
 * boot reports before it is ready (plugins loaded) reaches the page.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { liveValue, serveValueOn } from "@plugins/network/plugins/live/core";
import {
  PROTOCOL,
  type ServerFrame,
} from "@plugins/network/plugins/live/plugins/resource-protocol/core";
import { onTaskMark } from "@plugins/primitives/plugins/perfs/plugins/task-marks/core";
import { crashFieldsOf } from "@plugins/packages/plugins/error-subject/core";
import { inRealmServer } from "../testing";
import type { BrowserServer } from "./browser-server";
import {
  PortHostBootError,
  attachPort,
  portBrowserServer,
  portRequester,
  serveHost,
  serveOverPort,
  type HostServerError,
  type PortEnd,
} from "./port";
import { reportingLoads, type HostProgress } from "./boot-progress";

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
    errors: () => {},
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

  test("a failed boot names its cause: one report per cause, not one for every boot failure", async () => {
    const pageError = async (fail: () => never): Promise<PortHostBootError> => {
      const channel = new MessageChannel();
      channel.port1.start();
      channel.port2.start();
      // The worker's own rejection is the cause the page receives: awaited
      // beside it, as the boot test above does.
      const [, page] = await Promise.all([
        serveOverPort(channel.port2, async () => fail()).then(
          () => {
            throw new Error("booted");
          },
          (e: unknown) => e,
        ),
        portBrowserServer(channel.port1).then(
          () => {
            throw new Error("booted");
          },
          (e: unknown) => e as PortHostBootError,
        ),
      ]);
      return page;
    };
    class UnknownError extends Error {
      override name = "UnknownError";
    }
    const blob = await pageError(() => {
      throw new UnknownError(
        "Error preparing Blob/File data to be stored in object store",
      );
    });
    const fetch1 = await pageError(() => {
      throw new TypeError(
        "Failed to fetch dynamically imported module: /artifacts/a.0123456789abcdef/index.js",
      );
    });
    const fetch2 = await pageError(() => {
      throw new TypeError(
        "Failed to fetch dynamically imported module: /artifacts/a.fedcba9876543210/index.js",
      );
    });
    const blobScope = crashFieldsOf(blob).scope;
    expect(blobScope).toBe(
      "UnknownError › Error preparing Blob/File data to be stored in object store",
    );
    // Another cause, another report.
    expect(crashFieldsOf(fetch1).scope).not.toBe(blobScope);
    // The same cause, whatever ids its message carries, one report.
    expect(crashFieldsOf(fetch1).scope).toBe(crashFieldsOf(fetch2).scope);
  });

  test("an attached port answers requests beside the page's own port", async () => {
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    void serveOverPort(channel.port2, async () => ({
      server: greetingServer("hi"),
      keys: new Set([greeting.key]),
      boot: BOOT,
      errors: () => {},
    }));
    const { server } = await portBrowserServer(channel.port1);
    const r = recorder();
    const socket = server.connect(r.peer);
    socket.send(sub(1, greeting.key, { who: "page" }));
    await r.next((f) => f.kind === "sub-ack");

    // Another realm's channel (a frame-serving Service Worker's), handed over.
    const side = new MessageChannel();
    attachPort(channel.port1, side.port1);
    const request = portRequester(side.port2);
    side.port2.start();
    const res = await request(
      new Request(`http://sw/api/resources/${greeting.key}?who=frame`),
    );
    expect(((await res.json()) as { value: unknown }).value).toEqual({
      text: "hi frame",
    });

    // The page's socket still serves.
    socket.send(sub(2, greeting.key, { who: "again" }));
    const again = await r.next(
      (f) => f.kind === "sub-ack" && JSON.stringify(f).includes("again"),
    );
    expect(again).toMatchObject({ value: { text: "hi again" } });
    socket.close();
    server.dispose();
    side.port2.close();
  });
});

describe("a worker the browser restarted under the page", () => {
  test("its new instance, handed the page's port, tells the page so instead of dropping the page's frames", async () => {
    // 2026-11-18, equin.ai on desktop Safari: subs unanswered on an open
    // in-browser server socket — WebKit relaunched the host's SharedWorker
    // and re-sent `connect` with the page's port, so the frames of a socket
    // the old instance had opened reached one that never opened it.
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    // The worker's side of the port, as whichever instance currently holds it.
    let instance: (event: MessageEvent) => void = () => {};
    channel.port2.addEventListener("message", (event) => instance(event));
    const handedTo = (): PortEnd => ({
      postMessage: (msg, transfer) =>
        channel.port2.postMessage(msg, transfer ?? []),
      addEventListener: (_type, listener) => {
        instance = listener;
      },
    });
    const boot = async () => ({
      server: greetingServer("hi"),
      keys: new Set([greeting.key]),
      boot: BOOT,
      errors: () => {},
    });

    serveHost({ accept: (serve) => serve(handedTo()), boot });
    const page = await portBrowserServer(channel.port1);
    const r = recorder();
    const socket = page.server.connect(r.peer);
    socket.send(sub(1, greeting.key, { who: "before" }));
    await r.next((f) => f.kind === "sub-ack");

    // The browser restarts the worker: a fresh instance is handed the port.
    serveHost({ accept: (serve) => serve(handedTo()), boot });
    socket.send(sub(2, greeting.key, { who: "after" }));
    expect(await page.ended).toBe("restarted");
  });

  test("a frame on a conn the new instance never opened is caught even after a late inputs re-declaration", async () => {
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    let instance: (event: MessageEvent) => void = () => {};
    channel.port2.addEventListener("message", (event) => instance(event));
    const handedTo = (): PortEnd => ({
      postMessage: (msg, transfer) =>
        channel.port2.postMessage(msg, transfer ?? []),
      addEventListener: (_type, listener) => {
        instance = listener;
      },
    });
    const boot = async () => ({
      server: greetingServer("hi"),
      keys: new Set([greeting.key]),
      boot: BOOT,
      errors: () => {},
    });
    serveHost({ accept: (serve) => serve(handedTo()), boot });
    const page = await portBrowserServer(channel.port1);
    const r = recorder();
    const socket = page.server.connect(r.peer);
    socket.send(sub(1, greeting.key, { who: "before" }));
    await r.next((f) => f.kind === "sub-ack");

    serveHost({ accept: (serve) => serve(handedTo()), boot });
    page.declareInputs(["late.supply"]);
    socket.send(sub(2, greeting.key, { who: "after" }));
    expect(await page.ended).toBe("restarted");
  });
});

describe("boot progress", () => {
  test("the plugins a boot loads before it is ready reach the page", async () => {
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    const entries = reportingLoads([
      { loader: () => Promise.resolve({ default: 1 }) },
      { loader: () => Promise.resolve({ default: 2 }) },
    ]);
    void serveOverPort(channel.port2, async () => {
      for (const entry of entries) await entry.loader();
      return {
        server: greetingServer("hi"),
        keys: new Set<string>(),
        boot: BOOT,
        errors: () => {},
      };
    });
    const seen: HostProgress[] = [];
    await portBrowserServer(channel.port1, {
      onProgress: (progress) => seen.push(progress),
    });
    expect(seen.at(-1)?.plugins).toEqual({ loaded: 2, total: 2 });
  });
});

describe("server errors", () => {
  test("an error the host caught — during its boot or after — reaches the page with its stack", async () => {
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    let raise!: (error: HostServerError) => void;
    const caught = (message: string): HostServerError => ({
      message,
      stack: `Error: ${message}\n    at loader (bytes.ts:1:1)`,
      errorType: "NotReadableError",
      scope: null,
    });
    void serveOverPort(channel.port2, async () => ({
      server: greetingServer("hi"),
      keys: new Set<string>(),
      boot: BOOT,
      errors: (forward) => {
        // One caught before the page could hear it: replayed, as the sink holds it.
        forward(caught("during boot"));
        raise = forward;
      },
    }));
    const heard: HostServerError[] = [];
    let heardSecond!: () => void;
    const second = new Promise<void>((resolve) => (heardSecond = resolve));
    await portBrowserServer(channel.port1, {
      onServerError: (error) => {
        heard.push(error);
        if (heard.length === 2) heardSecond();
      },
    });
    raise(caught("after ready"));
    await second;
    expect(heard.map((e) => e.message)).toEqual(["during boot", "after ready"]);
    expect(heard[1]).toEqual(caught("after ready"));
  });
});

describe("task marks", () => {
  test("each host message the page handles is a marked task naming what it was", async () => {
    const heard: string[] = [];
    const uninstall = onTaskMark({
      begin: (source, describe) => {
        const { what, detail } = describe();
        heard.push(`${source} ${what} [${detail}]`);
        return null;
      },
      end: () => {},
    });
    try {
      const { server } = await overChannel(greetingServer("hi"), [
        greeting.key,
      ]);
      const url = `http://x/api/resources/${greeting.key}?who=ada`;
      const res = await server.request(new Request(url));
      expect(res.status).toBe(200);
      expect(heard).toContain("browser-server ready [1 keys]");
      const response = heard.find((h) =>
        h.startsWith("browser-server response ["),
      );
      expect(response).toContain(` 200 `);
      expect(response).toContain(`· GET ${url}`);
      server.dispose();
    } finally {
      uninstall();
    }
  });
});
