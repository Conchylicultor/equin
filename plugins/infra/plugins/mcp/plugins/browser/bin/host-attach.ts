import { readFileSync } from "node:fs";
import { attachMarker, encodeAttachTicket } from "../core";
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
  // A script resolves its own routes against the build it checked; with no
  // build there is none for it to check, so there is nothing to attach to.
  if (session.target.kind !== "deploy") {
    throw new Error(
      `No deploy is registered for this conversation's checkout (${session.target.checkout}), and an e2e script drives one. ` +
        "Run `./singularity build` there first.",
    );
  }
  const { origin } = session.target;
  const endpoint = await bindEndpoint();
  const tab = await openTab(session);
  const marker = attachMarker(crypto.randomUUID());
  await tab.page.goto(marker);
  const ticket = encodeAttachTicket({
    v: 1,
    endpoint,
    marker,
    tab: tab.id,
    origin,
    playwright: playwrightVersion(),
  });
  return { ticket, tab };
}
