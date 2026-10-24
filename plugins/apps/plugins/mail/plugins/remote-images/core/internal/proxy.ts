// Same-origin, SSRF-guarded proxy for remote images embedded in email HTML.
// Email `<img src="https://…">` is never loaded directly (privacy: tracking
// pixels, IP leakage) — the reading pane rewrites each remote src to this proxy
// URL, and only once the user opts into "Display images" for that message. The
// handler (`remote-images/machine`: `safeFetch` dials the validated IP through
// Bun's fetch, so it needs the computer) fetches and streams back only
// `image/*` responses.

import { z } from "zod";
import {
  assetPath,
  blob,
  defineEndpoint,
  type AssetPath,
} from "@plugins/infra/plugins/endpoints/core";

/** The proxy route: `GET /api/mail/image?url=<remote>`. Desktop-only. */
export const getMailImage = defineEndpoint({
  route: "GET /api/mail/image",
  query: z.object({ url: z.string() }),
  response: blob(),
  needsMachine: { feature: "Displaying an email's remote images" },
});

/**
 * The proxied image for a remote image URL. An `<img src>` inside the email's
 * HTML string loads it by URL, so its src comes from `assetUrlOver` /
 * `useAssetUrl` (`endpoints/web`), `unavailable` on a host without the computer.
 */
export function mailImageProxyAsset(remoteUrl: string): AssetPath {
  return assetPath(getMailImage, {}, { url: remoteUrl });
}
