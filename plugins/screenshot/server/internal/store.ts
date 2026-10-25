import { serveValue } from "@plugins/network/plugins/live/server";
import { screenshotImage } from "../../shared/image";

const ONE_HOUR_MS = 60 * 60 * 1000;

interface Entry {
  png: Uint8Array<ArrayBuffer>;
  createdAt: number;
}

const store = new Map<string, Entry>();

/** The ids some tab is subscribed to (the runtime's 0→1 / N→0): never expired. */
const held = new Set<string>();

function gc(now: number) {
  for (const [id, entry] of store) {
    if (held.has(id)) continue;
    if (now - entry.createdAt > ONE_HOUR_MS) store.delete(id);
  }
}

/**
 * The stored PNG, served whole as a bytes value. `notified` by the one write
 * that can turn a `missing` answer into bytes: `put`, which notifies its id.
 * An image an editor tab is subscribed to is never expired (`gc` skips it), so
 * that tab's re-read — a reconnect, a refetch — still finds it; a tab opened
 * after expiry reads `missing`, as the endpoint answered 404. What this
 * process cannot keep is an image lost to a restart: the editor then keeps
 * drawing the copy it last read (the read's `stale`).
 */
export const screenshotImageServed = serveValue(screenshotImage, {
  source: "external",
  changes: "notified",
  whileSubscribed: ({ id }) => {
    held.add(id);
    return () => {
      held.delete(id);
    };
  },
  loader: ({ id }) => {
    const png = store.get(id)?.png;
    if (png === undefined) {
      throw screenshotImage.refuse(
        "missing",
        `No screenshot is stored under ${id}`,
      );
    }
    return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
  },
});

export function put(id: string, png: Uint8Array<ArrayBuffer>): void {
  const now = Date.now();
  gc(now);
  store.set(id, { png, createdAt: now });
  screenshotImageServed.notify({ id });
}
