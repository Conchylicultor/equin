import type { Transport } from "@plugins/primitives/plugins/networking/web";
import type { ContentPath } from "../../core";
// `ASSET_PATH`: with asset-src.ts and asset-url.ts, this module is the one reader of an asset's path.
import { ASSET_PATH, unavailableMessage } from "../../core";

/**
 * The URL a content frame (`ContentFrame`, `primitives/embed/frame`) loads a
 * piece of untrusted content at:
 * - `ready` — `url` on the transport's content serving (the content host,
 *   `<item>.content.localhost/<ns>/…`, for the page's own server); `isolated`
 *   says whether that is off the page's origin (`false` only where the
 *   transport declares, with its reason, that same-origin is safe);
 * - `unavailable` — the route needs the computer and none is behind the
 *   transport (`message` says so in the one sentence every surface uses);
 * - `unsupported` — nothing serves this transport's content by URL here.
 */
export type ContentUrl =
  | ReadyContentUrl
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "unsupported"; readonly message: string };

declare const readyContentUrlBrand: unique symbol;

/**
 * A content document's URL, minted only by {@link contentUrlOver} — the one
 * thing `ContentFrame` frames, so a frame granted `allow-same-origin` can only
 * ever be on the transport's content serving, never an app origin.
 */
export interface ReadyContentUrl {
  readonly [readyContentUrlBrand]: true;
  readonly kind: "ready";
  readonly url: string;
  /** Off the page's origin (the content host); `false` only where declared safe. */
  readonly isolated: boolean;
}

/** What a content frame shows where nothing serves its document by URL. */
const UNSUPPORTED_MESSAGE =
  "This page can't show live content here — it is served on equin's content host, which this address does not reach (a deployed site), or this browser has no Service Workers (a private window).";

/** {@link ContentUrl} of `content` on `transport`. */
export function contentUrlOver(
  transport: Transport,
  content: ContentPath,
): ContentUrl {
  if (content.needsMachine !== null && !transport.machine) {
    return {
      kind: "unavailable",
      message: unavailableMessage(content.needsMachine),
    };
  }
  if (transport.content === null) {
    return { kind: "unsupported", message: UNSUPPORTED_MESSAGE };
  }
  return {
    kind: "ready",
    url: transport.content.url(content.item, content[ASSET_PATH]),
    isolated: transport.content.kind === "content-host",
  } as ReadyContentUrl;
}
