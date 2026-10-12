/**
 * A `NotificationsProvider` under a `<TransportProvider>` mounts a pipeline of
 * that transport's own: two subtrees reading the SAME (key, params) through two
 * transports each see their own backend's value, open their own sockets (under
 * their own URLs) and keep their own causal-floor registries — and the last
 * provider leaving tears its pipeline down.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { render, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { z } from "zod";
import {
  NotificationsProvider,
  useLiveRegistries,
  useLiveSocketKindOf,
  useResource,
} from "@plugins/primitives/plugins/live-state/web";
import type { LiveRegistries } from "../notifications-client";
import type {
  Transport,
  TransportSocket,
} from "@plugins/primitives/plugins/networking/web";
import { TransportProvider } from "@plugins/primitives/plugins/networking/web/testing";
import {
  registerResourceDescriptor,
  type ResourceDescriptor,
} from "@plugins/primitives/plugins/live-state/core";

const descriptor: ResourceDescriptor<{ who: string }> = {
  key: "test.scoped-pipeline.value",
  schema: z.object({ who: z.string() }),
  validateParams: () => {},
};
registerResourceDescriptor(descriptor as ResourceDescriptor<unknown>);

/**
 * A transport whose socket and HTTP reads answer every subscription with
 * `who`, stamped with a watermark — a minimal in-memory backend.
 */
function backend(who: string, watermark: string) {
  const opened: string[] = [];
  let closed = 0;
  const transport: Transport = {
    socketUrl: (path) => `test-${who}:${path}`,
    openSocket(url) {
      opened.push(url);
      const socket: TransportSocket = {
        onopen: null,
        onmessage: null,
        attachedTabs: 1,
        connection: `${who}-conn`,
        setLastWill: () => {},
        close: () => {
          closed++;
        },
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
                    value: { who },
                    version: 1,
                    watermark,
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
    // The cold-start prime and the fallback read: `GET /api/resources/<key>`.
    fetch: (input) => {
      const url = String(input);
      if (!url.startsWith("/api/resources/"))
        return Promise.reject(new Error(`${who}: unexpected request ${url}`));
      return Promise.resolve(
        new Response(
          JSON.stringify({ value: { who }, version: 1, watermark }),
          {
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    },
    assetUrl: (path) => `test-${who}:${path}`,
  };
  return { transport, opened, closed: () => closed };
}

const seen: Record<string, { value?: string; registries?: LiveRegistries }> =
  {};

function Reader({ name }: { name: string }) {
  const result = useResource(descriptor);
  const registries = useLiveRegistries();
  const kindOf = useLiveSocketKindOf();
  const value = result.status === "ready" ? result.data.who : undefined;
  useEffect(() => {
    seen[name] = { value, registries };
  }, [name, value, registries]);
  // Both readers classify transport A's socket: only A's pipeline owns it.
  return (
    <span data-testid={name}>{kindOf("test-a:/ws/notifications") ?? ""}</span>
  );
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

describe("scoped live-state pipeline", () => {
  it("keeps two transports' reads, sockets and registries apart", async () => {
    const a = backend("a", "100");
    const b = backend("b", "200");
    const view = render(
      <>
        <Scoped transport={a.transport}>
          <Reader name="a" />
        </Scoped>
        <Scoped transport={b.transport}>
          <Reader name="b" />
        </Scoped>
      </>,
    );

    await waitFor(() => {
      expect(seen.a?.value).toBe("a");
      expect(seen.b?.value).toBe("b");
    });
    // Each pipeline opened its own socket, under its own transport's URL, and
    // recognises only its own socket on the shared ws-status bus.
    expect(a.opened).toEqual(["test-a:/ws/notifications"]);
    expect(b.opened).toEqual(["test-b:/ws/notifications"]);
    expect(view.getByTestId("a").textContent).toBe("worktree");
    expect(view.getByTestId("b").textContent).toBe("");
    // Each pipeline adopted its own backend's watermark for the same tuple.
    expect(seen.a!.registries).not.toBe(seen.b!.registries);
    expect(seen.a!.registries!.watermarks.get(descriptor.key)).toBe("100");
    expect(seen.b!.registries!.watermarks.get(descriptor.key)).toBe("200");

    view.unmount();
    await waitFor(() => {
      expect(a.closed()).toBe(1);
      expect(b.closed()).toBe(1);
    });
  });
});
