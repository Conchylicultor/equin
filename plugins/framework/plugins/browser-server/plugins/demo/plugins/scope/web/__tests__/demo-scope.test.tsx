/**
 * `<DemoScope>` against the real live-state client (`NotificationsClient`
 * under its own `<TransportProvider>`): a pack value and a pack collection
 * render through `useLive`, beside a `Demo.Resource` contribution's value and
 * its later `notify()`; a `Demo.Route` answers through `useFetchEndpoint()`;
 * an unrecorded known key fails `loader-failed` and never reaches the
 * contract-mismatch store; unsupported POSTs throw `EndpointUnsupportedError`
 * with ONE toast and nothing on the error sink; a key served twice, or a pack
 * that does not parse, reaches the error boundary; a page pipeline beside the
 * scope reading the same tuple sees its own backend only.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));
const toasts = vi.hoisted(
  () => [] as { title?: string; description: string }[],
);
vi.mock("@plugins/shell/plugins/toast/web", () => ({
  showToast: (args: { title?: string; description: string }) => {
    toasts.push(args);
  },
}));

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { Component, useEffect, type ReactElement, type ReactNode } from "react";
import { z } from "zod";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import type { DemoScenario } from "@plugins/framework/plugins/browser-server/plugins/demo/core";
import {
  definePack,
  packAll,
  packValue,
  type DemoPack,
} from "@plugins/framework/plugins/browser-server/plugins/demo/core/testing";
import {
  defineEndpoint,
  implement,
} from "@plugins/infra/plugins/endpoints/core";
import {
  EndpointUnsupportedError,
  endpointErrorSink,
  useFetchEndpoint,
  type EndpointErrorInfo,
} from "@plugins/infra/plugins/endpoints/web";
import { floatField } from "@plugins/fields/plugins/float/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
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
import {
  Demo,
  demoResource,
  type DemoBackend,
  type DemoServe,
} from "@plugins/framework/plugins/browser-server/plugins/demo/web";
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
// Known to the page, answered by nothing in the scope.
const missing = liveValue(key("missing"), {
  schema: z.object({ n: z.number() }),
});

const echo = defineEndpoint({
  route: "POST /api/test-demo-scope/echo/:id",
  body: z.object({ n: z.number() }),
  response: z.object({ id: z.string(), doubled: z.number() }),
});
const notHere = defineEndpoint({ route: "POST /api/test-demo-scope/nope" });

const pack = definePack(() => [
  packValue(greeting, { who: "ada" }, { text: "hello ada (demo)" }),
  packAll(tracks, [
    { id: "t2", title: "Two", rank: 2 },
    { id: "t1", title: "One", rank: 1 },
  ]),
]);

const scenarioOf = (p: DemoPack, id = "test"): DemoScenario => ({
  id,
  app: "test-app",
  route: "/",
  pack: () => Promise.resolve({ default: p }),
});

/** The contributed `note` value, its text changeable and announced with `notify()`. */
function noteResource() {
  let text = "first note";
  let served: { notify(): void } | null = null;
  const serve: DemoServe = (s) => {
    const n = s.serveValue(note, {
      source: "external",
      changes: "notified",
      loader: () => ({ text }),
    });
    served = n;
    return [n];
  };
  return {
    serve,
    set(next: string) {
      text = next;
      served!.notify();
    },
  };
}

function plugins(contributions: LoadedPlugin["contributions"]): LoadedPlugin[] {
  return [
    {
      id: "framework.browser-server.demo" as PluginId,
      description: "demo scope fixture",
      slots: Demo,
      contributions: [],
    } as unknown as LoadedPlugin,
    {
      id: "test.demo-contributor" as PluginId,
      description: "contributor fixture",
      contributions,
    } as unknown as LoadedPlugin,
  ];
}

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
  toasts.length = 0;
  endpointErrorSink.register(null);
  console.error = consoleError;
});

/**
 * Render inside an awaited `act`: the scope suspends on its pack (`use()`),
 * and React only retries a suspended render from an act scope that is awaited.
 */
async function renderAsync(ui: ReactElement) {
  let view: ReturnType<typeof render> | undefined;
  await act(async () => {
    view = render(ui);
  });
  return view!;
}

describe("<DemoScope>", () => {
  it("serves the pack and the contributions through the real client; a contribution notifies", async () => {
    const contributed = noteResource();
    const seen: Record<string, unknown> = {};
    let fetchIn: ReturnType<typeof useFetchEndpoint> | null = null;
    await renderAsync(
      <PluginProvider
        plugins={plugins([
          demoResource("note", contributed.serve),
          Demo.Route({
            route: [
              echo.route,
              implement(echo, ({ params, body }) => ({
                id: params.id,
                doubled: body.n * 2,
              })),
            ],
          }),
        ])}
      >
        <DemoScope scenario={scenarioOf(pack)}>
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
          <Probe
            read={() => useFetchEndpoint()}
            onRead={(f) => (fetchIn = f)}
          />
        </DemoScope>
      </PluginProvider>,
    );
    await waitFor(() => {
      expect(seen.greeting).toBe("hello ada (demo)");
      expect(seen.tracks).toEqual(["t1", "t2"]);
      expect(seen.note).toBe("first note");
    });
    act(() => contributed.set("second note"));
    await waitFor(() => expect(seen.note).toBe("second note"));
    expect(await fetchIn!(echo, { id: "x" }, { body: { n: 21 } })).toEqual({
      id: "x",
      doubled: 42,
    });
  });

  it(
    "an unrecorded known key fails loader-failed; the contract-mismatch store stays empty",
    { timeout: 15_000 },
    async () => {
      const seen: Record<string, unknown> = {};
      await renderAsync(
        <PluginProvider plugins={plugins([])}>
          <DemoScope scenario={scenarioOf(pack)}>
            <Probe
              read={() => useLive(missing)}
              onRead={(r) =>
                (seen.missing = r.status === "error" ? r.error.kind : r.status)
              }
            />
            <Probe
              read={() => useResourceContractMismatches()}
              onRead={(m) => (seen.mismatches = m)}
            />
          </DemoScope>
        </PluginProvider>,
      );
      await waitFor(() => expect(seen.missing).toBe("loader-failed"), {
        timeout: 5000,
      });
      expect(seen.mismatches).toEqual([]);
    },
  );

  it("unsupported POSTs throw EndpointUnsupportedError, toast once, report nothing", async () => {
    const reported: EndpointErrorInfo[] = [];
    endpointErrorSink.register((r) => reported.push(r));
    let fetchIn: ReturnType<typeof useFetchEndpoint> | null = null;
    await renderAsync(
      <PluginProvider plugins={plugins([])}>
        <DemoScope scenario={scenarioOf(pack)}>
          <Probe
            read={() => useFetchEndpoint()}
            onRead={(f) => (fetchIn = f)}
          />
        </DemoScope>
      </PluginProvider>,
    );
    await waitFor(() => expect(fetchIn).not.toBeNull());
    for (let i = 0; i < 2; i++) {
      await expect(fetchIn!(notHere, {})).rejects.toBeInstanceOf(
        EndpointUnsupportedError,
      );
    }
    expect(toasts).toEqual([
      {
        title: "Not available in the demo",
        description: "POST /api/test-demo-scope/nope is not part of this demo.",
      },
    ]);
    expect(reported).toEqual([]);
  });

  it("a key served by both the pack and a contribution throws, naming both", async () => {
    console.error = () => {};
    const view = await renderAsync(
      <PluginProvider
        plugins={plugins([
          demoResource("greeter", (s) => [
            s.serveValue(greeting, {
              source: "external",
              changes: "notified",
              loader: () => ({ text: "again" }),
            }),
          ]),
        ])}
      >
        <Boundary>
          <DemoScope scenario={scenarioOf(pack, "twice")}>
            <p>never</p>
          </DemoScope>
        </Boundary>
      </PluginProvider>,
    );
    await waitFor(() =>
      expect(view.getByTestId("boundary").textContent).toBe(
        `demo scope "twice": "${greeting.key}" is served by both the pack of "twice" and Demo.Resource "greeter".`,
      ),
    );
  });

  it("a backend's own route is answered beside its serves", async () => {
    let fetchIn: ReturnType<typeof useFetchEndpoint> | null = null;
    const backend: DemoBackend = {
      serve: () => [],
      routes: [
        [
          echo.route,
          implement(echo, ({ params, body }) => ({
            id: params.id,
            doubled: body.n * 3,
          })),
        ],
      ],
    };
    await renderAsync(
      <PluginProvider
        plugins={plugins([
          Demo.Resource({ id: "echoer", useBackend: () => backend }),
        ])}
      >
        <DemoScope scenario={scenarioOf(pack, "backend-route")}>
          <Probe
            read={() => useFetchEndpoint()}
            onRead={(f) => (fetchIn = f)}
          />
        </DemoScope>
      </PluginProvider>,
    );
    await waitFor(() => expect(fetchIn).not.toBeNull());
    expect(await fetchIn!(echo, { id: "x" }, { body: { n: 2 } })).toEqual({
      id: "x",
      doubled: 6,
    });
  });

  it("a route answered by both a Demo.Route and a backend throws, naming both", async () => {
    console.error = () => {};
    const handler = implement(echo, ({ params }) => ({
      id: params.id,
      doubled: 0,
    }));
    const backend: DemoBackend = {
      serve: () => [],
      routes: [[echo.route, handler]],
    };
    const view = await renderAsync(
      <PluginProvider
        plugins={plugins([
          Demo.Route({ route: [echo.route, handler] }),
          Demo.Resource({ id: "echoer", useBackend: () => backend }),
        ])}
      >
        <Boundary>
          <DemoScope scenario={scenarioOf(pack, "route-twice")}>
            <p>never</p>
          </DemoScope>
        </Boundary>
      </PluginProvider>,
    );
    await waitFor(() =>
      expect(view.getByTestId("boundary").textContent).toBe(
        `demo scope "route-twice": route "${echo.route}" is answered by both a Demo.Route and Demo.Resource "echoer".`,
      ),
    );
  });

  it("a pack that does not parse reaches the error boundary", async () => {
    console.error = () => {};
    const bad = definePack(() => [
      packValue(greeting, { who: "bo" }, {
        text: 42,
      } as unknown as { text: string }),
    ]);
    const view = await renderAsync(
      <PluginProvider plugins={plugins([])}>
        <Boundary>
          <DemoScope scenario={scenarioOf(bad)}>
            <p>never</p>
          </DemoScope>
        </Boundary>
      </PluginProvider>,
    );
    await waitFor(() =>
      expect(view.getByTestId("boundary").textContent).toContain(greeting.key),
    );
  });

  it("a page pipeline beside the scope reading the same tuple sees only its own backend", async () => {
    const page = pageBackend();
    const seen: Record<string, unknown> = {};
    await renderAsync(
      <PluginProvider plugins={plugins([])}>
        <TransportProvider transport={page}>
          <NotificationsProvider>
            <Probe
              read={() => useLive(greeting, { who: "ada" })}
              onRead={(r) => (seen.page = textOf(r))}
            />
          </NotificationsProvider>
        </TransportProvider>
        <DemoScope scenario={scenarioOf(pack)}>
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
    assetUrl: (path) => `test-page:${path}`,
  };
}
