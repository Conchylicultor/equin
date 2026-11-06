// An addressed frame: a server text frame that names which of a shared
// socket's consumers it is for. The SharedWorker holding a socket for many
// tabs reads the address off the front and posts the body only to the ports
// it names — a tab never receives, let alone parses, a frame answering another
// tab's subscription. A frame with no address is for every consumer.
//
// Grammar: `RS <address>(,<address>)* RS <body>` (RS = U+001E, the ASCII
// record separator). No JSON text starts with a control character, so an
// unaddressed frame is never mistaken for one, and reading the address costs
// two `indexOf`s — the body is never parsed. Addresses are opaque ids (a
// realm's holder id) and may contain neither RS nor a comma.
//
// The SharedWorker, bundled from this plugin's `web/` and `shared/` only,
// reads it with its own copy (`web/addressed-frame-reader.ts`), pinned against
// this module by `web/__tests__/shared-websocket.test.ts`.

const RS = "\u001e";

/** `body` addressed to `to` (at least one address). */
export function addressFrame(to: Iterable<string>, body: string): string {
  let list = "";
  for (const a of to) {
    if (a === "" || a.includes(RS) || a.includes(",")) {
      throw new Error(`addressFrame: invalid address ${JSON.stringify(a)}`);
    }
    list = list === "" ? a : `${list},${a}`;
  }
  if (list === "") throw new Error("addressFrame: no address");
  return `${RS}${list}${RS}${body}`;
}

/** A frame as read off the wire: its addresses (`null`: every consumer) and its body. */
export interface ReadFrame {
  readonly to: readonly string[] | null;
  readonly body: string;
}

/** Splits a frame into its address list and body; an unaddressed frame is its own body. */
export function readAddressedFrame(data: string): ReadFrame {
  if (!data.startsWith(RS)) return { to: null, body: data };
  const end = data.indexOf(RS, 1);
  if (end < 0) throw new Error("readAddressedFrame: unterminated address");
  return { to: data.slice(1, end).split(","), body: data.slice(end + 1) };
}
