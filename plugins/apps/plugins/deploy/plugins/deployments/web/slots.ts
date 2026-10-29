import type { ComponentType, ReactNode } from "react";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { defineDetailSections } from "@plugins/primitives/plugins/detail-sections/web";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import { defineTabbedView } from "@plugins/primitives/plugins/tabbed-view/web";
import type { Deployment } from "../core";

/**
 * The site's Settings tab: **one slot whose sections are contributions** — the
 * record (`deployments`' General and Install), the secrets (`approvals`), the
 * composition (`composition`) and the Danger zone (`deployments`). Every section
 * starts open: Settings is a page you read down, not a stack you dig into.
 *
 * Named for the record it edits (it predates the site page, and its slot id is
 * the persisted order key, so renaming it would reset every user's order).
 * `inset: "none"`: the site page already places its content on the tabs' edge.
 */
export const DeploymentDetail = defineDetailSections<{
  deploymentId: string;
}>({ inset: "none" });

/**
 * What every piece of the site page is handed: the site's resolved row. The
 * page resolves it once (the pane's `useResolve`), so a header action or a strip
 * cell never re-reads it or renders a loading state of its own for it.
 */
export interface SiteProps {
  deployment: Deployment;
}

/**
 * The site page's tabs (Overview · Analytics · Messages · Deployments ·
 * Settings), each a contribution of the plugin that owns its content. The active
 * one is the URL's `:tab?` (bare = the first available, Overview). A tab that
 * does not apply to this site (Analytics for a composition that ships no
 * collector) declares `useAvailable` and is simply absent.
 */
export const SiteTabs = defineTabbedView<{ deploymentId: string }>(
  "deploy.site",
  { strip: "underline" },
);

/** One part of the site page's header or production strip. */
export interface SitePart {
  component: ComponentType<SiteProps>;
}

/**
 * The site page's header: the site's identity (mark, hostname, status pill,
 * hostnames, composition) is `deployments`' own; the buttons trailing it are
 * contributions — Deploy (`remote-deploy`), Test locally (`local-serve`).
 */
export const SiteHeader = {
  Action: defineRenderSlot<SitePart>({ docLabel: (p) => p.id }),
};

/** One cell of the production strip: a small label over its value. */
export interface SiteStripCellContribution extends SitePart {
  /** The cell's caption ("Running", "Server"). */
  label: string;
}

/**
 * The production strip under the header: what is live, at a glance — Status,
 * Running, Deployed, Bundle (`remote-deploy`), Server (`deployments`). Always
 * visible, whatever tab is open.
 */
export const SiteStrip = {
  Cell: defineRenderSlot<SiteStripCellContribution>({
    docLabel: (p) => p.label,
  }),
};

/** How loud a banner is. */
export type SiteBannerTone = "info" | "warning" | "destructive";

/**
 * What one banner says, when it has something to say. The host draws it (one
 * row under the strip: icon, `title` in the foreground, `body` after it, then
 * `actions`), plus `detail` full-width below — a deploy's steps and log tail.
 */
export interface SiteBannerSpec {
  tone: SiteBannerTone;
  icon: IconRef;
  /** The lead, in the foreground ("main is 12 commits ahead"). */
  title: ReactNode;
  /** The rest of the sentence, muted. */
  body?: ReactNode;
  /** Trailing buttons. */
  actions?: ReactNode;
  /** Full-width content under the row. */
  detail?: ReactNode;
}

/**
 * A banner's answer: the banner to draw, `null` when it has nothing to flag,
 * or `"pending"` while the read it decides from has not landed — the chain
 * stops there, so a lower-ranked banner never paints and then gets replaced
 * once a higher one's data arrives.
 */
export type SiteBannerAnswer = SiteBannerSpec | null | "pending";

export interface SiteBannerContribution {
  id: string;
  /** The banner this site needs now (see `SiteBannerAnswer`). */
  useBanner: Hook<(props: SiteProps) => SiteBannerAnswer>;
}

/**
 * The ONE thing about this site that needs attention, under the strip:
 * deploying (steps + log tail), failed, a secret waiting on approval, behind
 * main. The host draws the FIRST contribution, in slot order, whose `useBanner`
 * answers non-null — so the order config ranks what wins when several apply.
 */
export const SiteBanner = defineRenderSlot<SiteBannerContribution>({
  docLabel: (p) => p.id,
});

/** Which Overview column a card sits in: the wide `main` one or the 340px `side` rail. */
export type SiteOverviewColumn = "main" | "side";

export interface SiteOverviewCardContribution extends SitePart {
  column: SiteOverviewColumn;
}

/**
 * The Overview tab: everything about the site at a glance, each card one click
 * from its tab. A card paints its own `SiteCard` (title, header link, body); the
 * host only places it in its column, in slot order. The host's own card is
 * Checks (over {@link SiteCheck}).
 */
export const SiteOverview = {
  Card: defineRenderSlot<SiteOverviewCardContribution>({
    docLabel: (p) => p.id,
  }),
};

/** A check's verdict. `pending` = not known yet (drawn as such, never as ok). */
export type SiteCheckState = "ok" | "warn" | "fail" | "pending";

export interface SiteCheckResult {
  state: SiteCheckState;
  /** What is checked ("Server reachable"). */
  label: string;
  /** The evidence, one line ("SSH verified · checked 3 min ago"). */
  detail: ReactNode;
  /** Where a not-ok check is fixed — drawn as a Fix button. */
  fix?: LinkTarget;
}

export interface SiteCheckContribution {
  id: string;
  /** This site's verdict, or `null` when the check does not apply to it. */
  useCheck: Hook<(props: SiteProps) => SiteCheckResult | null>;
}

/** The Overview's Checks card: one row per contribution, in slot order. */
export const SiteCheck = defineRenderSlot<SiteCheckContribution>({
  docLabel: (p) => p.id,
});
