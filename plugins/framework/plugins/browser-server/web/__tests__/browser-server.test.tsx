/**
 * The real live-state client (`NotificationsProvider` under a
 * `<TransportProvider>`, the path the app takes) against a `createBrowserServer`
 * through `browserServerTransport`: a served value and an external collection
 * (window and `:rows`) resolve and the channel reads open; a socket replay
 * restates every sub in one `sub-batch`; an unserved known key — present at
 * creation or registered later — fails as `loader-failed` and never reaches the
 * contract-mismatch store; an `implement()` route answers through the
 * transport's `fetch`; an unmatched request is a 409 (API) or a 404; a
 * `notify` on a `"notified"` collection lands a keyed delta in the client.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { act, render, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { z } from "zod";
import {
  defineEndpoint,
  implement,
} from "@plugins/infra/plugins/endpoints/core";
import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import { liveText } from "@plugins/network/plugins/live/plugins/filter/core";
import { useLive, useLiveRow } from "@plugins/network/plugins/live/web";
import {
  NotificationsProvider,
  useNotificationsChannelStatuses,
  useResourceContractMismatches,
} from "@plugins/primitives/plugins/live-state/web";
import type {
  Transport,
  TransportSocket,
} from "@plugins/primitives/plugins/networking/web";
import { TransportProvider } from "@plugins/primitives/plugins/networking/web/testing";
import {
  EndpointError,
  fetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web";
import {
  createBrowserServer,
  type BrowserServer,
  type BrowserServerPeer,
  type BrowserServerSocket,
} from "../../core/internal/browser-server";
import { browserServerTransport } from "../browser-server-transport";

let seq = 0;
const key = (name: string) => `test.browser-server.${name}.${seq++}`;

const Row = z.object({ id: z.string(), title: z.string(), rank: z.number() });
type Row = z.infer<typeof Row>;

const greeting = liveValue(key("greeting"), {
  schema: z.object({ text: z.string() }),
  params: ["who"],
});
const tasks = liveCollection(key("tasks"), {
  row: Row,
  id: "id",
  filterable: { title: liveText() },
  sortable: ["rank", "title"],
  default: { orderBy: [["rank", "asc"]], limit: 10 },
  maxLimit: 50,
});
// Known to the page, served by nothing.
const missingValue = liveValue(key("missing-value"), {
  schema: z.object({ n: z.number() }),
});
const missingCollection = liveCollection(key("missing-collection"), {
  row: Row,
  id: "id",
  filterable: { title: liveText() },
  sortable: ["rank"],
  default: { orderBy: [["rank", "asc"]], limit: 10 },
  maxLimit: 50,
});

const echo = defineEndpoint({
  route: "POST /api/test-echo/:id",
  body: z.object({ n: z.number() }),
  response: z.object({ id: z.string(), doubled: z.number() }),
});
// Declared, never implemented here.
const notHere = defineEndpoint({ route: "POST /api/x" });
const centralRead = defineEndpoint({
  route: "GET /api/central-resources/:key",
  response: z.unknown(),
});

/** The `EndpointError` a request rejected with. */
async function endpointError(p: Promise<unknown>): Promise<EndpointError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof EndpointError) return err;
    throw err;
  }
  throw new Error("expected the request to fail, but it succeeded");
}

/** A browser server over an in-memory row store, its frames and sockets observable. */
function setup() {
  const rows = new Map<string, Row>([
    ["a", { id: "a", title: "A", rank: 1 }],
    ["b", { id: "b", title: "B", rank: 2 }],
    ["c", { id: "c", title: "C", rank: 3 }],
  ]);
  const ordered = () => [...rows.values()].sort((x, y) => x.rank - y.rank);
  const unservedReads: string[] = [];
  let servedTasks: {
    notify(change?: { ids: readonly string[] }): void;
  } | null = null;
  const server = createBrowserServer({
    serve: (s) => {
      const tasksServed = s.serveCollection(tasks, {
        source: "external",
        changes: "notified",
        // `rank` is a number: its `$key` text, zero-padded so text order is its order.
        keyText: { rank: (n) => String(n).padStart(4, "0") },
        window: (q) => ordered().slice(0, q.limit),
        rows: (ids) =>
          ids.flatMap((id) => {
            const r = rows.get(id);
            return r === undefined ? [] : [r];
          }),
      });
      servedTasks = tasksServed;
      return [
        s.serveValue(greeting, {
          source: "external",
          changes: { fixed: { reason: "test fixture" } },
          loader: ({ who }) => ({ text: `hello ${who}` }),
        }),
        tasksServed,
      ];
    },
    routes: [
      [
        echo.route,
        implement(echo, ({ params, body }) => ({
          id: params.id,
          doubled: body.n * 2,
        })),
      ],
    ],
    unserved: (k) => {
      unservedReads.push(k);
      return new Error(`not served here: ${k}`);
    },
  });

  // Every client frame, and a hand on the live server end so a test can
  // drop it and reconnect (what a server restart does to a real socket).
  const sent: string[] = [];
  let live: { peer: BrowserServerPeer; end: BrowserServerSocket } | null = null;
  const observed: BrowserServer = {
    id: server.id,
    request: (req) => server.request(req),
    dispose: () => server.dispose(),
    connect(peer) {
      live = { peer, end: server.connect(peer) };
      return {
        send(frame) {
          sent.push(frame);
          live!.end.send(frame);
        },
        close(code, reason) {
          live!.end.close(code, reason);
        },
      };
    },
  };
  const base = browserServerTransport(observed);
  const sockets = new Map<string, TransportSocket>();
  const transport: Transport = {
    ...base,
    openSocket(url, options) {
      const socket = base.openSocket(url, options);
      sockets.set(url, socket);
      return socket;
    },
  };
  // The server end drops and a fresh one connects; the client's socket sees
  // a new connection open — as a real socket does after a server restart.
  const reconnect = () => {
    const current = live!;
    current.end.close(1012, "restart");
    current.end = server.connect(current.peer);
    sockets
      .get(transport.socketUrl("/ws/notifications"))!
      .onopen?.(new Event("open"));
  };
  return {
    server,
    transport,
    unservedReads,
    rows,
    sent,
    reconnect,
    notifyTasks: (change?: { ids: readonly string[] }) =>
      servedTasks!.notify(change),
  };
}

function Scoped({
  transport,
  children,
}: {
  transport: Transport;
  children: ReactNode;
}) {
  return (
    <TransportProvider transport={transport}>
      <NotificationsProvider>{children}</NotificationsProvider>
    </TransportProvider>
  );
}

/** Report the latest value of `read` through `onRead` after every render. */
function Probe<T>({ read, onRead }: { read: () => T; onRead: (v: T) => void }) {
  const value = read();
  useEffect(() => {
    onRead(value);
  });
  return null;
}

const subFrames = (sent: string[]) =>
  sent
    .map((f) => JSON.parse(f) as { op: string; entries?: unknown[] })
    .filter((f) => f.op === "sub" || f.op === "sub-batch");

describe("browser server ⇄ the real live-state client", () => {
  it("serves a value and an external collection (window + :rows); the channel reads open", async () => {
    const { transport, server } = setup();
    const seen: Record<string, unknown> = {};
    const view = render(
      <Scoped transport={transport}>
        <Probe
          read={() => useLive(greeting, { who: "ada" })}
          onRead={(r) =>
            (seen.greeting = r.status === "ready" ? r.data.text : r.status)
          }
        />
        <Probe
          read={() => useLive(tasks)}
          onRead={(r) =>
            (seen.window =
              r.status === "ready" ? r.data.map((x) => x.id) : r.status)
          }
        />
        <Probe
          read={() => useLiveRow(tasks, "b")}
          onRead={(r) =>
            (seen.row =
              r.status === "ready" && r.found ? r.row.title : r.status)
          }
        />
        <Probe
          read={() => useNotificationsChannelStatuses().worktree}
          onRead={(s) => (seen.channel = s)}
        />
      </Scoped>,
    );
    await waitFor(() => {
      expect(seen.greeting).toBe("hello ada");
      expect(seen.window).toEqual(["a", "b", "c"]);
      expect(seen.row).toBe("B");
      expect(seen.channel).toBe("open");
    });
    view.unmount();
    server.dispose();
  });

  it("a reconnect replays every sub in ONE sub-batch, and values stay correct", async () => {
    const { transport, server, sent, reconnect } = setup();
    const seen: Record<string, unknown> = {};
    const view = render(
      <Scoped transport={transport}>
        <Probe
          read={() => useLive(greeting, { who: "bo" })}
          onRead={(r) =>
            (seen.greeting = r.status === "ready" ? r.data.text : r.status)
          }
        />
        <Probe
          read={() => useLive(tasks)}
          onRead={(r) =>
            (seen.window =
              r.status === "ready" ? r.data.map((x) => x.id) : r.status)
          }
        />
      </Scoped>,
    );
    await waitFor(() => {
      expect(seen.greeting).toBe("hello bo");
      expect(seen.window).toEqual(["a", "b", "c"]);
    });
    const before = sent.length;
    act(() => reconnect());
    await waitFor(() => {
      const replay = subFrames(sent.slice(before));
      expect(replay.map((f) => f.op)).toEqual(["sub-batch"]);
      expect(replay[0]!.entries).toHaveLength(2);
    });
    // The replayed subs are answered on the new connection; values unchanged.
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(seen.greeting).toBe("hello bo");
    expect(seen.window).toEqual(["a", "b", "c"]);
    view.unmount();
    server.dispose();
  });

  it(
    "an unserved known key fails as loader-failed — at creation or registered later — never a contract mismatch",
    { timeout: 15_000 },
    async () => {
      const { transport, server, unservedReads } = setup();
      // Registered after the server: a lazy plugin's descriptor.
      const late = liveValue(key("late"), {
        schema: z.object({ n: z.number() }),
      });
      const seen: Record<string, unknown> = {};
      const failure = (r: {
        status: string;
        error?: { kind: string; message: string } | null;
      }) =>
        r.status === "error" && r.error
          ? `${r.error.kind}: ${r.error.message}`
          : r.status;
      const view = render(
        <Scoped transport={transport}>
          <Probe
            read={() => useLive(missingValue)}
            onRead={(r) => (seen.value = failure(r))}
          />
          <Probe
            read={() => useLiveRow(missingCollection, "a")}
            onRead={(r) => (seen.row = failure(r))}
          />
          <Probe
            read={() => useLive(late)}
            onRead={(r) => (seen.late = failure(r))}
          />
          <Probe
            read={() => useResourceContractMismatches()}
            onRead={(m) => (seen.mismatches = m)}
          />
        </Scoped>,
      );
      // The client answers a WS sub-error with an HTTP read, retried once
      // (TanStack's 1 s backoff) before the read settles as failed.
      // The runtime never ships a loader's own message to the client (a
      // server failure is reported, not exposed), so the read names the key
      // and the kind; the `unserved` error is what the loader threw.
      await waitFor(
        () => {
          expect(seen.value).toMatch(/^loader-failed: .*500 \(loader-failed\)/);
          expect(seen.row).toMatch(/^loader-failed: .*500 \(loader-failed\)/);
          expect(seen.late).toMatch(/^loader-failed: .*500 \(loader-failed\)/);
        },
        { timeout: 5000 },
      );
      expect(String(seen.value)).toContain(missingValue.key);
      expect(String(seen.late)).toContain(late.key);
      expect(new Set(unservedReads)).toEqual(
        new Set([missingValue.key, missingCollection.rows.key, late.key]),
      );
      expect(seen.mismatches).toEqual([]);
      view.unmount();
      server.dispose();
    },
  );

  it("an implement() route answers through transport.fetch, its args parsed by the endpoint's schemas", async () => {
    const { transport, server } = setup();
    const opts = { transport, report: false } as const;
    expect(
      await fetchEndpoint(echo, { id: "x7" }, { ...opts, body: { n: 21 } }),
    ).toEqual({ id: "x7", doubled: 42 });
    const bad = await endpointError(
      fetchEndpoint(
        echo,
        { id: "x7" },
        { ...opts, body: { n: "not a number" } as unknown as { n: number } },
      ),
    );
    expect(bad.status).toBe(400);
    server.dispose();
  });

  it("an unmatched API request is 409 unsupported; any other path a 404", async () => {
    const { transport, server } = setup();
    const opts = { transport, report: false } as const;
    const api = await endpointError(fetchEndpoint(notHere, {}, opts));
    expect(api.status).toBe(409);
    expect(api.body).toEqual({
      reason: "unsupported",
      method: "POST",
      path: "/api/x",
    });
    // A central read is not hosted here: unmatched too.
    const central = await endpointError(
      fetchEndpoint(centralRead, { key: "auth.state" }, opts),
    );
    expect(central.status).toBe(409);
    const page = await transport.fetch("/some/page");
    expect(page.status).toBe(404);
    expect(await page.text()).toContain("/some/page");
    server.dispose();
  });

  it("notify on a notified external collection lands a keyed delta in the client cache", async () => {
    const { transport, server, rows, notifyTasks } = setup();
    const seen: Record<string, unknown> = {};
    const view = render(
      <Scoped transport={transport}>
        <Probe
          read={() => useLive(tasks)}
          onRead={(r) =>
            (seen.window =
              r.status === "ready" ? r.data.map((x) => x.title) : r.status)
          }
        />
        <Probe
          read={() => useLiveRow(tasks, "c")}
          onRead={(r) =>
            (seen.row =
              r.status === "ready" && r.found ? r.row.title : r.status)
          }
        />
      </Scoped>,
    );
    await waitFor(() => {
      expect(seen.window).toEqual(["A", "B", "C"]);
      expect(seen.row).toBe("C");
    });
    rows.set("c", { id: "c", title: "C2", rank: 0 });
    act(() => notifyTasks({ ids: ["c"] }));
    await waitFor(() => {
      expect(seen.window).toEqual(["C2", "A", "B"]);
      expect(seen.row).toBe("C2");
    });
    view.unmount();
    server.dispose();
  });
});

describe("createBrowserServer", () => {
  it("serving a key twice — or registering one the unserved fallback holds — fails loudly", () => {
    expect(() =>
      createBrowserServer({
        serve: (s) => [
          s.serveValue(greeting, {
            source: "external",
            changes: "notified",
            loader: () => ({ text: "x" }),
          }),
          s.serveValue(greeting, {
            source: "external",
            changes: "notified",
            loader: () => ({ text: "y" }),
          }),
        ],
        unserved: (k) => new Error(k),
      }),
    ).toThrow(/duplicate key/);
  });

  it("a value of the central origin is not served here", () => {
    const central = liveValue(key("central"), {
      schema: z.object({ n: z.number() }),
      origin: "central",
    });
    expect(() =>
      createBrowserServer({
        serve: (s) => [
          // @ts-expect-error — a central value: this host serves worktree values.
          s.serveValue(central, {
            source: "external",
            changes: "notified",
            loader: () => ({ n: 1 }),
          }),
        ],
        unserved: (k) => new Error(k),
      }),
    ).toThrow(/central value/);
  });

  it("a frame after close throws; close is idempotent; dispose closes every socket", () => {
    const server = createBrowserServer({
      serve: () => [],
      unserved: (k) => new Error(k),
    });
    const closedBy: string[] = [];
    const end = server.connect({
      deliver: () => {},
      closed: () => closedBy.push("first"),
    });
    end.close();
    end.close();
    expect(() => end.send(JSON.stringify({ op: "unsub-tab" }))).toThrow(
      /closed socket/,
    );
    const other = server.connect({
      deliver: () => {},
      closed: (code) => closedBy.push(`other:${code}`),
    });
    server.dispose();
    expect(() => other.send("{}")).toThrow(/closed socket/);
    // Only the socket the SERVER closed is told so.
    expect(closedBy).toEqual(["other:1001"]);
  });
});
