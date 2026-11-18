import { ResourceError } from "@plugins/network/plugins/live/plugins/live-state/web";
import type { LiveReader } from "@plugins/network/plugins/live/web";
import { ugTab } from "../../shared/resources";

/** What a person is told when UG's own API failed the read. */
const UG_UNAVAILABLE_MESSAGE = "Ultimate Guitar is unavailable right now.";

/**
 * A failed UG read, as the user should read it. A loader failure of a UG
 * value is UG's mobile API breaking (a status, a changed shape, the network
 * between the desktop and UG) — the server already files it as a report, with
 * the status and tab — so the person sees one sentence, never a raw status.
 * Everything else (a refusal, an outdated tab, the local server unreachable)
 * is already worded for the user and passes through unchanged.
 */
export function ugReadError(err: unknown): Error {
  if (err instanceof ResourceError && err.kind === "loader-failed") {
    return new Error(UG_UNAVAILABLE_MESSAGE, { cause: err });
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * The one read of a UG tab from an event (the URL loader, the import dialog,
 * a song link): `readLive(ugTab, { url })`, its failure worded by
 * {@link ugReadError}.
 */
export async function readUgTab(readLive: LiveReader, url: string) {
  try {
    return await readLive(ugTab, { url });
  } catch (err) {
    throw ugReadError(err);
  }
}
