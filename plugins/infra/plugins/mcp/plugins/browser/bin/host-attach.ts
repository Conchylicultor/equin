import playwrightPackage from "playwright/package.json" with { type: "json" };
import { attachMarker, encodeAttachTicket } from "../core";
import { bindEndpoint, openTab, type Session, type Tab } from "./host-session";

/**
 * The Playwright this host runs, as resolved from here — a connecting
 * script must run the same version (the harness compares it before connecting,
 * so a mismatch is a sentence, not a protocol error).
 */
function playwrightVersion(): string {
  // Imported, not resolved from this file's location: in the host's bundle
  // `playwright` is an external beside the bundle, and this resolves there
  // exactly as `import("playwright")` does.
  const { version } = playwrightPackage as { version?: string };
  if (!version) throw new Error("playwright/package.json names no version");
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
        "Run `./equin build` there first.",
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
