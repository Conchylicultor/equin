import { z } from "zod";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";

/**
 * The handoff from a conversation's browser session to an e2e script.
 *
 * `browser_attach` opens a tab in the session, marks it, and hands the agent a
 * ticket; `./singularity run <script>.ts --attach <ticket>` connects to the
 * shared browser through `endpoint` (Playwright's `browser.bind()` pipe, whose
 * connections share every context and leave them open on disconnect), finds
 * the tab by `marker`, drives it, and leaves it there for the agent to pick up.
 *
 * Self-contained, so nothing is stored or swept: a ticket whose browser or tab
 * is gone fails at connect or at the marker lookup, and the answer is a new one.
 */
export interface AttachTicket {
  v: 1;
  /** The bound browser's pipe path. */
  endpoint: string;
  /** The URL the tab was left at when the ticket was issued — how a script finds it. */
  marker: string;
  /** The session's tab id (`t3`), named back to the agent at teardown. */
  tab: string;
  /** The deploy the session drives, `http://<namespace>.localhost:9000`. */
  origin: string;
  /** The backend's Playwright version: a client must match it to connect. */
  playwright: string;
}

const ticketSchema: ZodParser<AttachTicket> = z.object({
  v: z.literal(1),
  endpoint: z.string().min(1),
  marker: z.string().min(1),
  tab: z.string().min(1),
  origin: z.string().url(),
  playwright: z.string().min(1),
});

/** `about:blank#attach-<nonce>`: the URL a ticket's tab waits at. */
export function attachMarker(nonce: string): string {
  return `about:blank#attach-${nonce}`;
}

export function encodeAttachTicket(ticket: AttachTicket): string {
  const bytes = new TextEncoder().encode(JSON.stringify(ticket));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Throws on anything that is not a ticket `encodeAttachTicket` made. */
export function decodeAttachTicket(raw: string): AttachTicket {
  let json: unknown;
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    throw new Error(
      `--attach: not a ticket (${err instanceof Error ? err.message : String(err)}). ` +
        "Copy it whole from browser_attach's answer.",
      { cause: err },
    );
  }
  const parsed = ticketSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `--attach: malformed ticket (${parsed.error.message}). Ask browser_attach for a new one.`,
    );
  }
  return parsed.data;
}
