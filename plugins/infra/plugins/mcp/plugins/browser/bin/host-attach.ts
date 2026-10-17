import { readFileSync } from "node:fs";
import {
  attachMarker,
  encodeAttachTicket,
} from "../core";
import { bindEndpoint, openTab, type Session, type Tab } from "./host-session";

/**
 * The Playwright this host runs, as resolved from here — a connecting
 * script must run the same version (the harness compares it before connecting,
 * so a mismatch is a sentence, not a protocol error).
 */
function playwrightVersion(): string {
  const path = Bun.resolveSync("playwright/package.json", import.meta.dir);
  const { version } = JSON.parse(readFileSync(path, "utf8")) as {
    version?: string;
  };
  if (!version) throw new Error(`${path} names no version`);
  return version;
}

/**
 * Open a fresh tab in the session, park it at a one-off marker URL, and hand
 * back the ticket an e2e script attaches with (`--attach <ticket>`).
 */
export async function issueAttachTicket(
  session: Session,
): Promise<{ ticket: string; tab: Tab }> {
  const endpoint = await bindEndpoint();
  const tab = await openTab(session);
  const marker = attachMarker(crypto.randomUUID());
  await tab.page.goto(marker);
  const ticket = encodeAttachTicket({
    v: 1,
    endpoint,
    marker,
    tab: tab.id,
    origin: session.target.origin,
    playwright: playwrightVersion(),
  });
  return { ticket, tab };
}
