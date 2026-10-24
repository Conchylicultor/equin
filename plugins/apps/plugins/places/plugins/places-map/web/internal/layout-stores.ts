import { z } from "zod";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { DEFAULT_DRAFT_TTL } from "@plugins/primitives/plugins/persistent-draft/web";

/**
 * The Places screen's layout, remembered per device (`useDraft`): which
 * chrome is out over the map. Never part of a preset — a preset is a filter,
 * and the same filter is read on the map alone or beside its list.
 */

/** Whether the tag sidebar is unfolded (presets, tag filter, tree); folded, its header alone names the active preset. */
export const sidebarOpenStore = defineStore({
  owner: "places.sidebar-open",
  label: "Places sidebar shown",
  area: "local",
  cap: "1 KB",
  ttl: DEFAULT_DRAFT_TTL,
  whenFull: "refuse",
  schema: z.boolean(),
});

/** How the side panel shows the active preset's places, or that it is hidden. */
export const PanelLayoutSchema = z.enum(["list", "gallery", "hidden"]);
export type PanelLayout = z.infer<typeof PanelLayoutSchema>;

export const panelLayoutStore = defineStore({
  owner: "places.panel-layout",
  label: "Places side panel layout",
  area: "local",
  cap: "1 KB",
  ttl: DEFAULT_DRAFT_TTL,
  whenFull: "refuse",
  schema: PanelLayoutSchema,
});

/** Which places the side panel lists: those the map shows, or every one of the preset. */
export const PanelScopeSchema = z.enum(["in-view", "all"]);
export type PanelScope = z.infer<typeof PanelScopeSchema>;

export const panelScopeStore = defineStore({
  owner: "places.panel-scope",
  label: "Places side panel scope",
  area: "local",
  cap: "1 KB",
  ttl: DEFAULT_DRAFT_TTL,
  whenFull: "refuse",
  schema: PanelScopeSchema,
});
