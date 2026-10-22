/**
 * `<DemoScope>` against the real live-state client (`NotificationsClient`
 * under its own `<TransportProvider>`), its scenario's host an in-realm
 * "worker" (`channelHost` over `inRealmServer`, the same port protocol a real
 * Web Worker speaks — jsdom cannot start one): a served value and collection
 * render through `useLive`, and a `notify()` lands; a key the host does not
 * serve fails `loader-failed` and never reaches the contract-mismatch store;
 * an unsupported POST is a plain `EndpointError`, reported (a gap the build's
 * coverage guard missed — nothing hides it); a POST the host serves is
 * answered; a host whose boot throws reaches the error boundary; a page
 * pipeline beside the scope reading the same tuple sees its own backend only.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { Component, useEffect, type ReactElement, type ReactNode } from "react";
import { z } from "zod";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import type { BrowserServer } from "@plugins/framework/plugins/browser-server/core";
import {
  channelHost,
  inRealmServer,
  type InRealmServerOptions,
} from "@plugins/framework/plugins/browser-server/core/testing";
import type { DemoScenario } from "@plugins/framework/plugins/browser-server/plugins/demo/core";
import {
  defineEndpoint,
  implement,
} from "@plugins/infra/plugins/endpoints/core";
import {
  EndpointError,
  endpointErrorSink,
  useFetchEndpoint,
  type EndpointErrorInfo,
} from "@plugins/infra/plugins/endpoints/web";
import { floatField } from "@plugins/fields/plugins/float/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import {
  liveCollection,
  liveValue,
  serveCollectionOn,
  serveValueOn,
} from "@plugins/network/plugins/live/core";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  NotificationsProvider,
  useResourceContractMismatches,
} from "@plugins/primitives/plugins/live-state/web";
import {
  TransportProvider,
  type Transport,
  type TransportSocket,
} from "@plugins/primitives/plugins/networking/web";
import { renderWithTransport } from "@plugins/primitives/plugins/networking/web/testing";
import { DemoScope } from "../components/demo-scope";

let seq = 0;
const key = (name: string) => `test.demo-scope.${name}.${seq++}`;

const greeting = liveValue(key("greeting"), {
  schema: z.object({ text: z.string() }),
  params: ["who"],
});
const tracks = liveCollection(key("tracks"), {
  fields: { title: textField({ label: "Title" }) },
  carry: { fields: { id: textField(), rank: floatField() } },
  id: "id",
  all: { orderBy: [["rank", "asc"]], unbounded: { reason: "test fixture" } },
});
const note = liveValue(key("note"), { schema: z.object({ text: z.string() }) });
// Declared, served by no host.
const missing = liveValue(key("missing"), {
  schema: z.object({ n: z.number() }),
});

const echo = defineEndpoint({
  route: "POST /api/test-demo-scope/echo/:id",
  body: z.object({ n: z.number() }),
  response: z.object({ id: z.string(), doubled: z.number() }),
});
const notHere = defineEndpoint({ route: "POST /api/test-demo-scope/nope" });

// In the collection's order (`rank`): an external `all` loader answers the
// whole ordered set.
const TRACKS = [
  { id: "t1", title: "One", rank: 1 },
  { id: "t2", title: "Two", rank: 2 },
];
const FIXED = { fixed: { reason: "test fixture" } } as const;

/** The story: a greeting per person, the tracks, the echo route — and `more`. */
function storyServer(more?: InRealmServerOptions["serve"]): BrowserServer {
  return inRealmServer({
    serve: (rt) => {
      serveValueOn(
        rt,
        greeting,
        {
          source: "external",
          changes: FIXED,
          loader: ({ who }: { who: string }) => ({
            text: `hello ${who} (demo)`,
          }),
        },
        { sources: "external" },
      );
      serveCollectionOn(rt, tracks, {
        source: "external",
        changes: FIXED,
        all: () => TRACKS,
        rows: (ids) => TRACKS.filter((t) => ids.includes(t.id)),
      });
      more?.(rt);
    },
    routes: [
      [
        echo.route,
        implement(echo, ({ params, body }) => ({
          id: params.id,
          doubled: body.n * 3,
        })),
      ],
    ],
  });
}

/** The fixture plugins the scope's composition names. */
const SCOPE_PLUGINS = ["test.demo-contributor"];

const scenarioOf = (
  boot: () => BrowserServer | Promise<BrowserServer> = storyServer,
  id = "test",
): DemoScenario => ({
  id,
  app: "test-app",
  route: "/",
  host: { id, home: null, plugins: SCOPE_PLUGINS, start: channelHost(boot) },
});

/** A `note` value the host serves, its text changeable and announced with `notify()`. */
function noteServer() {
  let text = "first note";
  let notify: (() => void) | null = null;
  const serve = (
    rt: Parameters<NonNullable<InRealmServerOptions["serve"]>>[0],
  ) => {
    const served = serveValueOn(
      rt,
      note,
      { source: "external", changes: "notified", loader: () => ({ text }) },
      { sources: "external" },
    );
    notify = () => served.notify!();
  };
  return {
    serve,
    set(next: string) {
      text = next;
      notify!();
    },
  };
}

const PLUGINS: LoadedPlugin[] = [
  {
    id: "test.demo-contributor" as PluginId,
    description: "contributor fixture",
    contributions: [],
  } as unknown as LoadedPlugin,
];

class Boundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    return this.state.error ? (
      <p data-testid="boundary">{this.state.error.message}</p>
    ) : (
      this.props.children
    );
  }
}

/** Report the latest value of `read` through `onRead` after every render. */
function Probe<T>({ read, onRead }: { read: () => T; onRead: (v: T) => void }) {
  const value = read();
  useEffect(() => {
    onRead(value);
  });
  return null;
}

const textOf = (r: { status: string; data?: { text: string } }) =>
  r.status === "ready" ? r.data!.text : r.status;

const consoleError = console.error;
afterEach(() => {
  cleanup();
  endpointErrorSink.register(null);
  console.error = consoleError;
});

/** Render inside an awaited `act`, so the scope's server effect has run. */
async function renderAsync(ui: ReactElement) {
  let view: ReturnType<typeof render> | undefined;
  await act(async () => {
    // The page's transport, as the app root mounts one above every scope.
    view = renderWithTransport(ui);
  });
  return view!;
}

/** The scope's `fetchEndpoint`, once the host is ready. */
async function scopedFetch(scenario: DemoScenario) {
  let fetchIn: ReturnType<typeof useFetchEndpoint> | null = null;
  await renderAsync(
    <PluginProvider plugins={PLUGINS}>
      <DemoScope scenario={scenario}>
        <Probe read={() => useFetchEndpoint()} onRead={(f) => (fetchIn = f)} />
      </DemoScope>
    </PluginProvider>,
  );
  await waitFor(() => expect(fetchIn).not.toBeNull());
  return fetchIn!;
}

describe("<DemoScope>", () => {
  it("serves the host's keys through the real client; a notify lands", async () => {
    const noted = noteServer();
    const seen: Record<string, unknown> = {};
    await renderAsync(
      <PluginProvider plugins={PLUGINS}>
        <DemoScope scenario={scenarioOf(() => storyServer(noted.serve))}>
          <Probe
            read={() => useLive(greeting, { who: "ada" })}
            onRead={(r) => (seen.greeting = textOf(r))}
          />
          <Probe
            read={() => useLive(tracks)}
            onRead={(r) =>
              (seen.tracks =
                r.status === "ready" ? r.data.map((t) => t.id) : r.status)
            }
          />
          <Probe
            read={() => useLive(note)}
            onRead={(r) => (seen.note = textOf(r))}
          />
        </DemoScope>
      </PluginProvider>,
    );
    await waitFor(() => {
      expect(seen.greeting).toBe("hello ada (demo)");
      expect(seen.tracks).toEqual(["t1", "t2"]);
      expect(seen.note).toBe("first note");
    });
    act(() => noted.set("second note"));
    await waitFor(() => expect(seen.note).toBe("second note"));
  });

  it(
    "a key the host does not serve fails loader-failed; the contract-mismatch store stays empty",
    { timeout: 15_000 },
    async () => {
      console.error = () => {};
      const seen: Record<string, unknown> = {};
      await renderAsync(
        <PluginProvider plugins={PLUGINS}>
          <DemoScope scenario={scenarioOf()}>
            <Probe
              read={() => useLive(missing)}
              onRead={(r) =>
                (seen.missing =
                  r.status === "error"
                    ? `${r.error.kind}: ${r.error.message}`
                    : r.status)
              }
            />
            <Probe
              read={() => useResourceContractMismatches()}
              onRead={(m) => (seen.mismatches = m)}
            />
          </DemoScope>
        </PluginProvider>,
      );
      await waitFor(
        () =>
          expect(seen.missing).toBe(
            `loader-failed: ${missing.key} is not served by this host`,
          ),
        { timeout: 5000 },
      );
      expect(seen.mismatches).toEqual([]);
    },
  );

  it("an unsupported POST is a plain EndpointError, reported", async () => {
    const reported: EndpointErrorInfo[] = [];
    endpointErrorSink.register((r) => reported.push(r));
    const fetchIn = await scopedFetch(scenarioOf());
    await expect(fetchIn(notHere, {})).rejects.toBeInstanceOf(EndpointError);
    expect(reported).toEqual([
      {
        route: "POST /api/test-demo-scope/nope",
        status: 409,
        body: {
          reason: "unsupported",
          method: "POST",
          path: "/api/test-demo-scope/nope",
        },
      },
    ]);
  });

  it("a POST the host serves is answered", async () => {
    const fetchIn = await scopedFetch(scenarioOf());
    expect(await fetchIn(echo, { id: "x" }, { body: { n: 2 } })).toEqual({
      id: "x",
      doubled: 6,
    });
  });

  it("a host whose boot throws reaches the error boundary", async () => {
    console.error = () => {};
    const view = await renderAsync(
      <PluginProvider plugins={PLUGINS}>
        <Boundary>
          <DemoScope
            scenario={scenarioOf(() => {
              throw new Error("migration 42 failed");
            }, "failing")}
          >
            <p>never</p>
          </DemoScope>
        </Boundary>
      </PluginProvider>,
    );
    await waitFor(() =>
      expect(view.getByTestId("boundary").textContent).toContain(
        "migration 42 failed",
      ),
    );
    expect(view.queryByText("never")).toBeNull();
  });

  it("a page pipeline beside the scope reading the same tuple sees only its own backend", async () => {
    const page = pageBackend();
    const seen: Record<string, unknown> = {};
    await renderAsync(
      <PluginProvider plugins={PLUGINS}>
        <TransportProvider transport={page}>
          <NotificationsProvider>
            <Probe
              read={() => useLive(greeting, { who: "ada" })}
              onRead={(r) => (seen.page = textOf(r))}
            />
          </NotificationsProvider>
        </TransportProvider>
        <DemoScope scenario={scenarioOf()}>
          <Probe
            read={() => useLive(greeting, { who: "ada" })}
            onRead={(r) => (seen.demo = textOf(r))}
          />
        </DemoScope>
      </PluginProvider>,
    );
    await waitFor(() => {
      expect(seen.page).toBe("from the page");
      expect(seen.demo).toBe("hello ada (demo)");
    });
  });
});

/** A minimal in-memory backend answering every subscription `{ text: "from the page" }`. */
function pageBackend(): Transport {
  const value = { text: "from the page" };
  return {
    socketUrl: (path) => `test-page:${path}`,
    openSocket() {
      const socket: TransportSocket = {
        onopen: null,
        onmessage: null,
        attachedTabs: 1,
        connection: "page-conn",
        setLastWill: () => {},
        close: () => {},
        send(data) {
          const msg = JSON.parse(data) as {
            op: string;
            key?: string;
            params?: Record<string, string>;
            entries?: { key: string; params: Record<string, string> }[];
          };
          const subs =
            msg.op === "sub"
              ? [{ key: msg.key!, params: msg.params ?? {} }]
              : msg.op === "sub-batch"
                ? (msg.entries ?? [])
                : [];
          for (const sub of subs) {
            queueMicrotask(() =>
              socket.onmessage?.(
                new MessageEvent("message", {
                  data: JSON.stringify({
                    kind: "sub-ack",
                    key: sub.key,
                    params: sub.params,
                    value,
                    version: 1,
                  }),
                }),
              ),
            );
          }
        },
      };
      queueMicrotask(() => socket.onopen?.(new Event("open")));
      return socket;
    },
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify({ value, version: 1 }), {
          headers: { "Content-Type": "application/json" },
        }),
      ),
    servesUrls: true,
    machine: true,
    telemetry: false,
  };
}
