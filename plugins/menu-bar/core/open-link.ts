/**
 * The URL scheme the equin app registers (`CFBundleURLTypes`, declared by the
 * menu-bar login service): macOS hands its links to the menu-bar helper.
 * Mirrored by `SCHEME` in `rust/src/open_link.rs` — KEEP IN SYNC.
 */
export const OPEN_LINK_SCHEME = "equin";

/**
 * The link that asks the helper to open `pageUrl` in the installed app's own
 * window (`equin://open?url=<page>`, parsed by `rust/src/open_link.rs`).
 */
export function openLink(pageUrl: string): string {
  return `${OPEN_LINK_SCHEME}://open?url=${encodeURIComponent(pageUrl)}`;
}
