/**
 * Constructing a `NotificationsClient` — or rendering the provider tree it
 * backs — opens no socket. The socket opens on first need: an explicit
 * `connect()` (the page's boot hoist, `NotificationsProvider`'s effect) or the
 * first `observe()`. So a static render (`renderToStaticMarkup`, which runs no
 * effect) reads a boot-hydrated value with no socket at all, while a live
 * mount still opens exactly one.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@plugins/primitives/plugins/log-channels/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    clientLog: () => {},
  }),
);

import { render } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { z } from "zod";
import {
  ensureNotificationsClient,
  hydrateResource,
  NotificationsProvider,
  useResource,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { NotificationsClient } from "../notifications-client";
import {
  TransportProvider,
  type Transport,
  type TransportSocket,
} from "@plugins/primitives/plugins/networking/web";
import {
  registerResourceDescriptor,
  type ResourceDescriptor,
} from "@plugins/network/plugins/live/plugins/live-state/core";

const descriptor: ResourceDescriptor<{ who: string }> = {
  key: "test.lazy-socket.value",
  schema: z.object({ who: z.string() }),
  validateParams: () => {},
};
registerResourceDescriptor(descriptor as ResourceDescriptor<unknown>);

/** A socket that never opens and records what it was sent. */
function inertSocket(): TransportSocket {
  return {
    onopen: null,
    onmessage: null,
    attachedTabs: 1,
    connection: null,
    setLastWill: () => {},
    close: () => {},
    send: () => {},
  };
}

function recordingTransport() {
  const opened: string[] = [];
  const transport: Transport = {
    socketUrl: (path) => `test-lazy:${path}`,
    openSocket(url) {
      opened.push(url);
      return inertSocket();
    },
    fetch: (input) =>
      Promise.reject(new Error(`unexpected request ${String(input)}`)),
    servesUrls: true,
    requestTiming: false,
    content: null,
    machine: true,
    telemetry: false,
  };
  return { transport, opened };
}

const clients: NotificationsClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.destroy();
});

function newClient(opened: string[]): NotificationsClient {
  const client = new NotificationsClient(new QueryClient(), {
    makeSocket: (url) => {
      opened.push(url);
      return inertSocket();
    },
  });
  clients.push(client);
  return client;
}

describe("NotificationsClient — the socket opens on first need", () => {
  it("construction opens no socket; the first observe() opens the worktree one", () => {
    const opened: string[] = [];
    const client = newClient(opened);
    expect(opened).toEqual([]);
    expect(client.getStatus()).toBe("connecting");

    client.observe(descriptor.key, {}, undefined, {
      schema: descriptor.schema,
    });
    expect(opened).toEqual(["/ws/notifications"]);

    // connect() after the fact reuses the channel.
    client.connect();
    expect(opened).toEqual(["/ws/notifications"]);
  });

  it("connect() opens it ahead of any subscribe, once", () => {
    const opened: string[] = [];
    const client = newClient(opened);
    client.connect();
    client.connect();
    expect(opened).toEqual(["/ws/notifications"]);
    client.observe(descriptor.key, {}, undefined, {
      schema: descriptor.schema,
    });
    expect(opened).toEqual(["/ws/notifications"]);
  });

  it("a static render of the provider tree reads a hydrated value with no socket; a live mount opens one", () => {
    const { transport, opened } = recordingTransport();
    // The page's pipeline: built on the default QueryClient hydrateResource
    // seeds — built, not connected.
    ensureNotificationsClient(transport);
    hydrateResource(descriptor, undefined, { who: "hydrated" });

    function Reader() {
      const r = useResource(descriptor);
      return <span>{r.status === "ready" ? r.data.who : r.status}</span>;
    }
    const tree = (
      <TransportProvider transport={transport}>
        <NotificationsProvider>
          <Reader />
        </NotificationsProvider>
      </TransportProvider>
    );

    expect(renderToStaticMarkup(tree)).toBe("<span>hydrated</span>");
    expect(opened).toEqual([]);

    const view = render(tree);
    expect(opened).toEqual(["test-lazy:/ws/notifications"]);
    view.unmount();
  });
});
