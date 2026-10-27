import { useTransport } from "@plugins/primitives/plugins/networking/web";

/**
 * Whether a present page can open in a browser tab of its own here. The page
 * is an address on THIS page's origin, so it shows this subtree's prototypes
 * only when the subtree's server is the page's own (`servesUrls`). Under an
 * in-browser server (the demo) that tab would boot the page's real app on its
 * real data, so the new-tab actions are not offered at all.
 */
export function useOpensBrowserTab(): boolean {
  return useTransport().servesUrls;
}
