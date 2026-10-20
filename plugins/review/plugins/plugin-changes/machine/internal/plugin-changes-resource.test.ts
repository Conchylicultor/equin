import { afterAll, describe, expect, mock, test } from "bun:test";
import {
  notificationsWsHandler,
  routeTableChange,
  type ResourceParams,
} from "@plugins/framework/plugins/server-core/core";
import * as workspaceServer from "@plugins/conversations/plugins/workspace/server";

// review.plugin-changes recomputes on its `edited-files` tuple (the mapped
// recomputeOn edge), but that cascade reaches only the edited-files tuples
// someone holds. A write that moves a conversation's worktree must still reach
// a plugin-changes tuple whose edited-files twin nobody subscribes — which is
// why it declares its own `reads`. This suite registers the REAL served value
// on the server-core runtime, subscribes it alone, and routes a
// `conversations` write through `routeTableChange` (the change feed's entry).
//
// The worktree lookup is the only DB read: it is stubbed (an unknown
// conversation, so the loader returns before any git) and counts its calls —
// one per plugin-changes load, since edited-files is never loaded here.

const realWorkspaceServer = { ...workspaceServer };
let lookups = 0;
void mock.module("@plugins/conversations/plugins/workspace/server", () => ({
  ...realWorkspaceServer,
  findWorkspaceOfConversation: () => {
    lookups++;
    return Promise.resolve({ found: false });
  },
}));

const { pluginChangesServed } = await import("./plugin-changes-resource");

interface Frame {
  kind: string;
  key?: string;
}

/** A socket on the server-core runtime, recording every frame. */
function attach() {
  const frames: Frame[] = [];
  const handler = notificationsWsHandler as unknown as {
    open(ws: unknown): void;
    message(ws: unknown, raw: string): void;
    close(ws: unknown, code: number, reason: string): void;
  };
  const ws = {
    send(raw: string) {
      const frame = JSON.parse(raw) as Frame;
      if (frame.kind !== "ping") frames.push(frame);
    },
  };
  handler.open(ws);
  return {
    async subscribe(key: string, params: ResourceParams): Promise<void> {
      handler.message(ws, JSON.stringify({ op: "sub", key, params }));
      await until(
        () => frames.some((f) => f.kind === "sub-ack" && f.key === key),
        `sub-ack ${key}`,
      );
    },
    close: () => handler.close(ws, 1000, "test"),
  };
}

/** Wait (bounded) for a condition the async loaders will make true. */
async function until(cond: () => boolean, what: string): Promise<void> {
  // Past the value's 3 s throttle window.
  const deadline = Date.now() + 8000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("review.plugin-changes — its own reads", () => {
  const socket = attach();
  afterAll(() => socket.close());

  test(
    "a conversations write recomputes a subscribed tuple whose edited-files tuple nobody holds",
    async () => {
      await socket.subscribe(pluginChangesServed.key, {
        conversationId: "conv-test-plugin-changes",
      });
      await until(() => lookups >= 1, "the first load");
      const before = lookups;
      routeTableChange({
        source: "feed",
        table: "conversations",
        op: "U",
        ids: ["conv-test-plugin-changes"],
        keys: null,
        unchanged: null,
      });
      await until(() => lookups > before, "the routed recompute");
      // Let any further flush land: one reload, the plugin-changes one.
      await new Promise((r) => setTimeout(r, 50));
      expect(lookups).toBe(before + 1);
    },
    { timeout: 15_000 },
  );
});
