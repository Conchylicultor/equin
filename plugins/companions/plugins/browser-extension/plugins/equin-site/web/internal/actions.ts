import {
  isLocalAppUrl,
  isPublicSiteUrl,
  localAppUrl,
  localSiteUrl,
  PUBLIC_SITE_ORIGIN,
  publicSiteUrl,
} from "@plugins/apps/plugins/website/plugins/shell/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type { PageAction } from "@plugins/companions/plugins/browser-extension/core";
import { pagePort } from "@plugins/infra/plugins/launcher/plugins/gateway-port/core";

const publicHost = new URL(PUBLIC_SITE_ORIGIN).hostname;
/**
 * The local gateway's port: the panel's own — the popup frames it from the
 * local gateway, so the page's location names this account's port.
 */
const localPort = (): number => pagePort(window.location);
const localHost = new URL(localAppUrl(localPort())).hostname;
const swapIcon = { symbol: symbol("swap-horiz"), color: "indigo" } as const;

/** On equin.ai: the same page on the local instance. */
export const openLocally: PageAction = {
  id: "open-locally",
  site: { label: publicHost, matches: isPublicSiteUrl },
  icon: swapIcon,
  title: "Open locally",
  subtitle: () => `${publicHost} → ${localHost}`,
  run: (url, host) => host.navigate(localSiteUrl(url, localPort())),
};

/** On any local equin page: equin.ai (the same page for a website page, else its home). */
export const openOnPublicSite: PageAction = {
  id: "open-on-public-site",
  site: { label: "equin (local)", matches: isLocalAppUrl },
  icon: swapIcon,
  title: `Open on ${publicHost}`,
  subtitle: () => `${localHost} → ${publicHost}`,
  run: (url, host) => host.navigate(publicSiteUrl(url)),
};
