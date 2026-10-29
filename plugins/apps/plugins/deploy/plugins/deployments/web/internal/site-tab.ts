import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { deployApp } from "@plugins/apps/plugins/deploy/plugins/shell/core";
import { sitePane } from "../panes";

/**
 * Switch the site page's tab in place: rewrites the pane's own `:tab?` param —
 * same instance, no remount — so a tab is an address (`/deploy/site/<id>/analytics`).
 * Only callable inside the site page (it throws elsewhere, as `useSetParams` does).
 */
export function useSetSiteTab(): (tab: string) => void {
  const { deploymentId } = sitePane.useParams();
  const setParams = sitePane.useSetParams();
  return (tab) => setParams({ deploymentId, tab });
}

/**
 * A link to one tab of the site page this is rendered on, as data — a check's
 * Fix, a card's "Open analytics", a banner's "Review secret". A plain click
 * switches the tab in place; ⌘/middle-click opens that tab in a new browser tab.
 */
export function useSiteTabLink(tab: string): LinkTarget {
  const { deploymentId } = sitePane.useParams();
  const setTab = useSetSiteTab();
  return {
    open: () => setTab(tab),
    href: () => sitePane.link(deployApp, { deploymentId, tab }),
  };
}
