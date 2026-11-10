import type { ComponentType } from "react";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
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
   * `/website` — the hero, the live demo, the three layers, the story link, the
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
};
