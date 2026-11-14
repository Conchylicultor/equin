import { getMirroredFile } from "@plugins/infra/plugins/asset-mirror/core";
import { endpointPath } from "@plugins/infra/plugins/endpoints/server";
import { FILM_POSTER_FILE, websiteMediaSource } from "../../core";

/**
 * The head tag that starts the showcase film's poster downloading at t0:
 * `<link rel="preload" as="image">` at the exact URL `useAssetSrc` hands the
 * `<video poster>` on the page's own server, so the poster's request is
 * answered from the preload instead of starting once React has drawn the
 * hero. The poster is the landing page's largest paint; without this its
 * 210 KB were requested only after the first commit, landing LCP 0.7 s (fast
 * 4G) to 2.8 s (slow 4G) after the page was ready.
 *
 * A server-rendered `<link>` is the one place a route's string belongs
 * (`endpointPath`): it is the page's own server, never a demo scope's.
 */
export function showcasePosterPreload(): string {
  const href = endpointPath(getMirroredFile, {
    id: websiteMediaSource.id,
    file: FILM_POSTER_FILE,
  });
  return `<link rel="preload" as="image" href="${href}">`;
}
