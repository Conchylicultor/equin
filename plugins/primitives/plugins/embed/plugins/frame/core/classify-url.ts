import {
  isContentHost,
  namespaceFromHost,
} from "@plugins/infra/plugins/namespace/core";

/**
 * What a URL a person pasted may be framed as.
 *
 * - `foreign` — an http(s) page on another site: framed as that site, which
 *   is its own origin (a video player needs its own storage, so it keeps
 *   `allow-same-origin` — on ITS origin, never ours).
 * - `refused` — anything that would run as, or next to, equin: an equin
 *   namespace (the app itself, with the owner's authority), the content host,
 *   loopback or an IP literal (another local server), or a scheme that is not
 *   a web page (`javascript:`, `data:`, `blob:`, `file:`). `reason` is the
 *   sentence the surface shows.
 */
export type FrameUrlClass =
  { kind: "foreign"; url: string } | { kind: "refused"; reason: string };

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function classifyFrameUrl(raw: string): FrameUrlClass {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (err) {
    if (err instanceof TypeError) {
      return { kind: "refused", reason: "This is not a web address." };
    }
    throw err;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      kind: "refused",
      reason: `A ${url.protocol} address is not a web page, so it can't be embedded.`,
    };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (namespaceFromHost(url.host) !== null || isContentHost(url.host)) {
    return {
      kind: "refused",
      reason:
        "equin pages can't be embedded: inside a frame they would run with your full authority.",
    };
  }
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.startsWith("[") ||
    host.includes(":") ||
    IPV4.test(host)
  ) {
    return {
      kind: "refused",
      reason:
        "Pages served from this computer or an IP address can't be embedded.",
    };
  }
  return { kind: "foreign", url: url.href };
}
