import type { ComponentType } from "react";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import type { SiteHealth } from "@plugins/apps/plugins/deploy/plugins/box-link/plugins/link/core";

/**
 * The six states the deployed-site row is drawn in — the prototype's
 * (`proto-1792516777-e95kao`, option group *Deployed site*). Only the row's
 * exhibits name them: a part's `exhibit` draws itself in each from its own
 * fixture, so the row can be looked at without a live box.
 */
export type SiteExhibitState =
  "live" | "deploying" | "behind" | "reconnecting" | "down" | "failed";

/**
 * What every part of a site's row is handed: the deployment, and its health
 * as the row set read it (`deploy.site-health` — the link, the latest run,
 * what it runs against main). A part reads anything else it needs (visitors,
 * the last heartbeat) itself.
 */
export interface SiteLiveProps {
  deploymentId: string;
  site: SiteHealth;
}

/** A part drawn in one of the {@link SiteExhibitState}s, on that state's fixture. */
export interface SiteLiveExhibitProps extends SiteLiveProps {
  state: SiteExhibitState;
}

/**
 * One part of a site's row, contributed by the plugin that owns what it
 * shows. `component` is the live part; `exhibit`, when the live part reads
 * something the fixture `site` does not carry, draws the same view from the
 * owner's own fixture for the state (absent: the exhibit draws `component`
 * on the fixture `site`). Either renders `null` when it has nothing to say
 * for this site now.
 */
export interface SiteLivePart {
  component: ComponentType<SiteLiveProps>;
  exhibit?: ComponentType<SiteLiveExhibitProps>;
}

/**
 * The deployed-site row's extension points (`box-link/site-row`), each a
 * render slot ordered by its reorder config — never a number on the part:
 *
 * - `Glance` — the figure at the end of the row's title line ("7 visitors
 *   now"): what the site is doing, at a glance, the row collapsed or not.
 * - `Section` — a block of the row's body (Visitors, Server, a deploy in
 *   progress), top to bottom.
 * - `Action` — a control of the row's footer (Deploy, Investigate, Retry now,
 *   Open site), left to right.
 */
export const SiteLive = {
  Glance: defineRenderSlot<SiteLivePart>({ docLabel: (p) => p.id }),
  Section: defineRenderSlot<SiteLivePart>({ docLabel: (p) => p.id }),
  Action: defineRenderSlot<SiteLivePart>({ docLabel: (p) => p.id }),
};
