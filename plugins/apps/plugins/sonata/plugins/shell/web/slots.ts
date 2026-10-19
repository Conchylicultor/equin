import type { ComponentType } from "react";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import {
  defineMountSlot,
  defineRenderSlot,
} from "@plugins/primitives/plugins/slot-render/web";
import {
  defineDetailSections,
  type DetailSection,
} from "@plugins/primitives/plugins/detail-sections/web";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import type {
  Annotation,
  Capability,
  Projection,
} from "@plugins/apps/plugins/sonata/plugins/score/core";

/**
 * A Sonata section is scoped to the OPEN SONG, which every contributor already
 * reads from the player scope (`useSession()` / `useSongDocument()`) — so the
 * pane threads no entity props at all.
 */
type SonataSectionProps = Record<string, never>;

/**
 * The one field the generic detail-sections contract knows nothing about: which
 * zone of the section column a panel belongs to. `"editor"` panels (a source's
 * own editor) render above the `"player"` panels (readouts, mixer) — a pure
 * render-time split across the column's two `.Render` zones, since `subId` does
 * not partition reorder (the persisted layout is keyed by the base slot id).
 * Defaults to the player zone when omitted.
 */
export interface SonataSectionArea {
  area?: "editor" | "player";
}

/**
 * One panel in the player's right-hand section column — a `DetailSection` (the
 * shared detail-pane contract: `label`, `icon`, `component`, `actions`,
 * `summary`, `useAvailable`, `useDefaultOpen`) plus Sonata's own
 * `area`. The chrome, the collapsed-by-default open state, and the
 * `useAvailable` gate all live in the primitive — see
 * `primitives/detail-sections/CLAUDE.md` before adding one, in particular that a
 * collapsed body is genuinely UNMOUNTED, so work that must outlive the panel
 * belongs in a headless `Sonata.Effect` (or `SonataSession.Effect`).
 */
export type SonataSection = DetailSection<SonataSectionProps> &
  SonataSectionArea;

// The player's column is an INSPECTOR: flat, rule-divided, chevron-free
// sections running edge to edge beside the display, not a stack of cards.
const sonataSections = defineDetailSections<
  SonataSectionProps,
  SonataSectionArea
>({ chrome: "inspector" });

/**
 * The per-section chrome, for the section column's host (`library`'s
 * `SectionPane`). The column owns its own layout — two `area`-filtered
 * `.Render` zones inside one `SonataSectionStack` — so it paints each section
 * through this instead of the primitive's single-stack `Host`.
 */
export const SonataSectionItem = sonataSections.SectionItem;

/**
 * The stack the section column's zones sit in — the inspector rhythm (no gap,
 * no inset; the sections' own rules divide them), owned by the primitive so the
 * column never hand-sets a gap or padding of its own.
 */
export const SonataSectionStack = sonataSections.SectionStack;

/**
 * One section's persisted open state — the same value its card reads — for the
 * section rail, which opens the picked section as it expands into the panel.
 */
export const useSonataSectionOpen = sonataSections.useSectionOpen;

/**
 * The Sonata app's extension axes — what a display hosts and what the app
 * surface shows around a player:
 *
 *  - Overlay  (rich visual)— capability-filtered geometry, rendered via `renderIsolated`.
 *  - TransportOverlay (state visual) — capability-filtered, scroll-synced overlays driven by transport state (loop region).
 *  - TransportEdge (state visual) — capability-filtered, screen-anchored edge-clamped overlays for off-screen transport boundaries (loop A/B edge indicator).
 *  - PitchAxis             — decorations in a display's pitch-axis gutter (the keyboard).
 *  - Hud / ViewOption      — screen-anchored chips over a display, and the per-lens prefs they surface.
 *  - Home                  — the app landing surface (the song library).
 *  - Effect                — headless app-scoped effects.
 *  - Section               — the player's free-floating panels (current-chord readout, …).
 *
 * The layers below the app own their own axes: the song document its inputs
 * (`SonataDocument.Source` / `.Analyzer` / `.SongSetting`), the playback
 * session its per-session wrappers and effects (`SonataSession.Provider` /
 * `.Effect`), the player its lenses and transport strip
 * (`SonataPlayer.Display` / `.Transport`). The player's header bar is the
 * player pane's own `Actions` slot (library). The audio Instrument axis lives
 * in its own leaf (`audio/instruments`, `SonataAudio.Instrument`).
 */
export const Sonata = {
  // RICH VISUAL — geometry-anchored overlays, capability-filtered. The host
  // renders an overlay only when `requires ⊆ display.capabilities` and the Score
  // has annotations of its `annotationType` (filters on generic fields only).
  Overlay: defineSlot<{
    id: string;
    annotationType: string;
    requires: Capability[];
    component: ComponentType<{
      projection: Projection;
      annotations: Annotation[];
    }>;
  }>({ docLabel: (p) => p.id }),

  // STATE OVERLAY — projection-anchored, scroll-synced overlays driven by
  // transport / shared state rather than score annotations (the A–B practice
  // loop region; future selection bands, bookmarks, count-in markers). Like
  // `Overlay` it anchors to the projection's geometry and scrolls WITH the
  // content; unlike `Overlay` it is NOT annotation-gated — the host renders it
  // whenever `requires ⊆ display.capabilities`, and the component reads its own
  // state via `useSession()`. Capability-filtered so it only mounts on displays
  // that publish the geometry it needs (e.g. `"time-axis"`).
  TransportOverlay: defineSlot<{
    id: string;
    requires: Capability[];
    component: ComponentType<{ projection: Projection }>;
  }>({ docLabel: (p) => p.id }),

  // EDGE INDICATOR — screen-anchored (NOT scroll-synced) transport-state overlays
  // clamped to the lane edges. Unlike TransportOverlay (which scrolls glued to the
  // notes inside the scroll layer), the host mounts these OUTSIDE the scroll layer so
  // they stay pinned at the lane's top/bottom edge — for indicating where an off-screen
  // transport boundary (e.g. an A–B loop edge above/below the lookahead) sits.
  // Capability-filtered like TransportOverlay; the component reads its own transport
  // state via useSession() and the live cursor via useCursorSelector().
  TransportEdge: defineSlot<{
    id: string;
    requires: Capability[];
    component: ComponentType<{ projection: Projection }>;
  }>({ docLabel: (p) => p.id }),

  // PITCH AXIS — decorations rendered in a display's pitch-axis gutter (the
  // piano keyboard, future fretboards / pitch rulers). Capability-filtered like
  // Overlay: the host renders one only when `requires ⊆ display.capabilities`.
  // Anchors via the published projection (`keys` / `pitchToX`).
  PitchAxis: defineSlot<{
    id: string;
    requires: Capability[];
    component: ComponentType<{ projection: Projection }>;
  }>({ docLabel: (p) => p.id }),

  // HOME — the app landing surface (song library). Single render slot; the
  // library plugin contributes its gallery here and paints it in its index pane.
  Home: defineRenderSlot<{ component: ComponentType }>({
    docLabel: (p) => p.id,
  }),

  // EFFECT — headless, always-mounted APP-scoped side effects. Components
  // contributed here render nothing; they observe the open song and the
  // playback state and run effects (keyboard shortcuts, recording a play,
  // persisting a source's edits). Mounted once inside the app provider and the
  // player scope, so contributors may `useSonataApp()` and `useSession()`. An
  // effect that must run wherever a song plays (audio) is a
  // `SonataSession.Effect` instead, and one that runs wherever a player is
  // shown (Space / ←→) is a `SonataPlayer.Effect`.
  Effect: defineMountSlot({
    docLabel: (p) => p.id,
  }),

  // HUD — screen-anchored heads-up overlays painted over a display, pinned to its
  // viewport corner (current-key chip, …). Unlike `Overlay`, which anchors to the
  // projection's geometry and scrolls with the content, a HUD stays fixed and
  // reads the session's cursor / score via `useSession()`. Display-agnostic: any
  // display hosts it with `.Render`; capability-free since it needs no projection.
  Hud: defineRenderSlot<{ component: ComponentType }>({
    docLabel: (p) => p.id,
  }),

  // VIEW OPTIONS — per-lens display prefs surfaced as quick controls inside a
  // player HUD chip (the look, note names, key labels, …). Each contributor
  // hands a config_v2 descriptor (optionally a `fields` subset); the host chip
  // renders those fields generically via FieldRenderer. Collection-consumer
  // clean — the host reads the slot and never names a contributor. Lives here
  // (not piano-roll) so leaf contributors' configs can be surfaced without the
  // display ⇄ primitive import cycle.
  //
  // A row here is a choice the user makes, so an option that would be inert
  // under another option's value does not belong in the slot as a second row —
  // it belongs folded INTO that option's values. There is deliberately no
  // "hide me when …" predicate: the look absorbed the keyboard's flat/realistic
  // switch for exactly this reason (see `look/core/config.ts`), leaving nothing
  // that needs one.
  //
  // `displays` scopes an option to its owning lens(es): the View popover shows
  // ONLY the active `SonataPlayer.Display`'s options plus globals, so a lens never
  // surfaces controls that do nothing for it (e.g. the look inside Notation).
  // It is a list of display ids (matching a `SonataPlayer.Display` `id`) or the
  // literal `"global"` for options that apply to every lens. REQUIRED — forcing
  // each option to declare its scope makes "leaks into every lens" impossible by
  // construction rather than a filter a new contributor can forget.
  ViewOption: defineSlot<{
    id: string;
    /** Owning lens(es): display ids, or `"global"` to show in every lens. */
    displays: string[] | "global";
    config: ConfigDescriptor;
    /** Optional subset/order of field keys; default = all descriptor fields. */
    fields?: string[];
  }>({
    docLabel: (p) => p.id,
  }),

  // VIEW SECTION — a lens's own block in the same View options panel, for a
  // control that is not a config field (the piano roll's effect switches,
  // grouped by tier). Rendered after the `ViewOption` fields, scoped by
  // `displays` exactly like them. The component paints control-panel members
  // (sections, rows) — never a surface of its own; the panel around it does.
  ViewSection: defineSlot<{
    id: string;
    /** Owning lens(es): display ids, or `"global"` to show in every lens. */
    displays: string[] | "global";
    component: ComponentType;
  }>({
    docLabel: (p) => p.id,
  }),

  // SECTION — panels in the player's right-hand column, each a collapsible
  // `SectionCard` painted by the host. Produced by `defineDetailSections`, which
  // emits the slot id `sonata.section` verbatim — the SAME string this slot has
  // always had, and the one `reorderDirectiveDescriptor` uses as its config_v2
  // config name (`config/apps/sonata/shell/sonata.section.jsonc`). Never change
  // the factory id: it would silently reset every user's persisted section order
  // and their per-section collapsed state (keyed `sonata.section.<id>.open`).
  Section: sonataSections.Section,
};
