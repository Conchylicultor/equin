import type { ComponentType } from "react";
import {
  defineRenderSlot,
  defineWrapperSlot,
} from "@plugins/primitives/plugins/slot-render/web";
import { definePaneHeaderSlot } from "@plugins/primitives/plugins/pane/web";

/**
 * The shared site header — ONE pane header slot worn by every website pane, so
 * the nav persists across the whole site and is authored in one place: one
 * contribution list, one reorder directive, one `⋯`.
 *
 * A pane borrows it with `Pane.define({ actions: WebsiteHeader })`; its
 * `pane.Actions` then IS this slot. It is declared exactly ONCE, by this plugin
 * (`slots: { header: WebsiteHeader }`), and the borrowing panes are deliberately
 * absent from their own plugins' `slots:` records — declaring one slot under two
 * names is what the declaration pass rejects.
 *
 * The shell contributes the wordmark; page plugins contribute their nav links
 * (use `<WebsiteNavLink/>` for the standard look). Which of them lead and which
 * trail is the slot's reorder config — see
 * `config/apps/website/shell/header.jsonc`, where the wordmark sits ahead of the
 * spacer and the nav packs against the trailing edge.
 */
export const WebsiteHeader = definePaneHeaderSlot();

export const Website = {
  /**
   * Landing-page bands, rendered top-to-bottom on the index pane at
   * `/about` — the hero, the live demo, the three layers, the story link, the
   * contact band. Each
   * section owns its full-width band (compose `WebsiteBand`).
   *
   * Reading order is authored in `config/apps/website/shell/section.jsonc`, NOT
   * inherited from the plugin load order: a page's bands are a sequence someone
   * wrote, and plugin topology has no opinion about which paragraph comes first.
   */
  Section: defineRenderSlot<{ label: string; component: ComponentType }>({
    docLabel: (p) => p.label,
  }),
  /**
   * What floats over every page of the site, above the page that scrolls
   * under it — the consent prompt. Rendered once by the app's surface
   * (`WebsiteLayout`), so it stays put while the visitor moves between pages,
   * inside a `SurfaceOverlay`: never part of the page's document (a static
   * render draws no overlay). Each contribution places itself in the
   * overlay's box (absolute, in a corner) and takes its own clicks
   * (`pointer-events: auto` — the overlay lets the rest through to the page).
   */
  Layer: defineRenderSlot<{ label: string; component: ComponentType }>({
    docLabel: (p) => p.label,
  }),
  /**
   * What lives across every page of the site: wrappers folded around the
   * pages by the app's surface (`WebsiteLayout`), kept while the visitor
   * moves between them — state a page switch must not end (the live demo's
   * store and server). A resident renders `children` (the pages) and may
   * mount beside them what it keeps; it shows itself, where it does, through
   * a portal into the page that asks for it.
   */
  Resident: defineWrapperSlot<{ label: string }>({
    docLabel: (p) => p.label,
  }),
  /**
   * The footer's quiet links, beside the address and the source — a page that
   * belongs in the small print rather than in the header (Privacy). Each
   * renders one `WebsiteFooterLink`.
   */
  FooterLink: defineRenderSlot<{ label: string; component: ComponentType }>({
    docLabel: (p) => p.label,
  }),
};
