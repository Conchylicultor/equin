/**
 * The socket lifecycle the client reacts to runs as marked tasks
 * (`primitives/perfs/task-marks`), nested under the shared socket's own port
 * mark: a tab frozen in the open's replay, or in a status subscriber, names it
 * (`frozenIn`) instead of only "(anonymous) (MessagePort.onmessage)".
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock(
  "@plugins/primitives/plugins/log-channels/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    clientLog: () => {},
  }),
);

import { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { onTaskMark } from "@plugins/primitives/plugins/perfs/plugins/task-marks/web";
import { createTransportHub } from "@plugins/primitives/plugins/networking/web/testing";
import { NotificationsClient } from "../notifications-client";

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("NotificationsClient — task marks", () => {
  const clients: NotificationsClient[] = [];
  let uninstall: () => void = () => {};
  let begun: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    begun = [];
    uninstall = onTaskMark({
      begin: (source, describe) => {
        const t = describe();
        begun.push(`${source} ${t.what} [${t.detail}]`);
        return begun.length;
      },
      end: () => {},
    });
  });

  afterEach(() => {
    uninstall();
    for (const c of clients.splice(0)) c.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("a reconnect's open, its replay and its batch send are marked under the port's status", async () => {
    const hub = createTransportHub();
    const client = new NotificationsClient(new QueryClient(), {
      makeSocket: hub.makeSocket(hub.tab()),
    });
    clients.push(client);
    client.connect();
    await flush();
    client.observe("k", {}, undefined, {
      schema: z.object({ status: z.string() }),
    });
    begun = [];
    hub.server.all()[0]!.open();
    await flush();

    const open =
      "networking port status open > onopen > live-state:open worktree";
    expect(begun).toContain(`${open} [1 subs]`);
    expect(begun).toContain(`${open} > replay subs [1 subs]`);
    expect(begun).toContain(
      `${open} > replay subs > send sub-batch [1 entries]`,
    );
    // The client's ws-status subscriber, named, and the fan-out under it.
    expect(
      begun.some((b) =>
        b.startsWith(
          "networking port status open > ws-status open → live-state",
        ),
      ),
    ).toBe(true);
  });

  test("a status listener of the client is named by its place in the set", async () => {
    const hub = createTransportHub();
    const client = new NotificationsClient(new QueryClient(), {
      makeSocket: hub.makeSocket(hub.tab()),
    });
    clients.push(client);
    client.subscribeStatus(() => {});
    client.connect();
    await flush();
    begun = [];
    hub.server.all()[0]!.open();
    await flush();
    expect(
      begun.some((b) =>
        b.startsWith(
          "networking port status open > ws-status open → live-state > live-state:status listeners #0",
        ),
      ),
    ).toBe(true);
  });
});
