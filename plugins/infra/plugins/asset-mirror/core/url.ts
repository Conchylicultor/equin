/**
 * The mirror's base URL as a plain string, for a consumer that runs on the
 * page's own server only and has no transport to resolve an
 * {@link assetMirrorBase} over — Sonata's sample engines, whose instrument
 * factories are handed no transport. Anything a browser host scopes must use
 * `assetMirrorBase` + `useAssetUrl` instead: this file spells `/api/…` by hand,
 * so the browser-host coverage guard refuses a scoped reader of it (a raw URL
 * cannot declare `needsMachine`). `url.test.ts` holds it to the declared route.
 */
export const ASSET_MIRROR_PREFIX = "/api/asset-mirror";

/**
 * Same-origin base URL for a registered mirror's files on the page's own
 * server: append `/<file>` to fetch a single file.
 */
export function assetMirrorUrl(id: string): string {
  return `${ASSET_MIRROR_PREFIX}/${id}`;
}
