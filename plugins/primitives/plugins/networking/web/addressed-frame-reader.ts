// The SharedWorker's reader of an addressed frame — the grammar is
// `core/addressed-frame.ts`'s (`RS <address>(,<address>)* RS <body>`). Spelled
// again here because the worker is bundled whole from this plugin's `web/` and
// `shared/` only (web-artifacts hashes nothing else into its address), so it
// cannot inline `core/`. `__tests__/shared-websocket.test.ts` pins this reader
// against core's writer and reader.

const RS = "\u001e";

/** The frame's addresses (`null`: every consumer) and its body. */
export function readFrameAddress(data: string): {
  to: readonly string[] | null;
  body: string;
} {
  if (!data.startsWith(RS)) return { to: null, body: data };
  const end = data.indexOf(RS, 1);
  if (end < 0) throw new Error("shared-ws: unterminated frame address");
  return { to: data.slice(1, end).split(","), body: data.slice(end + 1) };
}
