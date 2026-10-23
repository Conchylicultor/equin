import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { defineShortcut } from "@plugins/primitives/plugins/shortcuts/web";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { HintHost } from "./components/hint-host";
import { hintsTheme } from "./internal/hints-theme";
import {
  dispatchTour,
  isTourRunning,
  pressNextKey,
} from "./internal/engine-store";
import { Hints } from "./slots";

export { Hints } from "./slots";
export { useHintAnchor, useHintAnchorPulse } from "./internal/anchor-registry";
export { emitHintSignal } from "./internal/signal-bus";
export {
  setTourData,
  startTour,
  useHintMoment,
  useTourRun,
} from "./internal/engine-store";
export type { TourRunView } from "./internal/engine-store";
export { useHints, useTours } from "./internal/registry";
export { useHintSeen, useResetHints } from "./internal/seen";
export { useHintCatalog } from "./internal/use-catalog";
export type { HintCatalogEntry } from "./internal/catalog";
export type { AnyTour } from "./internal/tour-machine";

export default {
  description:
    "The hints engine, web half: Hints.Hint / Hints.Tour declarations, useHintAnchor (ref registration, holding a floating toolbar open while its tip shows), useHintMoment (a tip shown once at its moment, lowest order first, one at a time), startTour / autoStart, emitHintSignal, the seen state and catalog reads — and the one HintHost at Core.Root drawing the active tip (halo + card) or the tour's welcome card / spotlit step on one persistent stage — every change of scene a CSS transition of the same elements — in the hints' own fixed theme (the same look in every app), every tour end pulsing ? and toasting where the tour lives.",
  slots: Hints,
  contributions: [
    Core.Root({ component: HintHost }),
    ThemeEngine.FixedTheme(hintsTheme),
    defineShortcut({
      id: "hints.tour-end",
      keys: "Escape",
      label: "End the tour",
      group: "Hints",
      priority: 10,
      when: isTourRunning,
      // A page the tour lands on may focus a text field (the Agent Manager's
      // composer): Esc is not a key a field types, so it still ends the tour.
      // A field or popover that handles Esc itself (Improve's draft closing)
      // prevents it first, and the shortcut stands down.
      enableInInputs: true,
      handler: () => dispatchTour({ type: "end", outcome: "dismissed" }),
    }),
    defineShortcut({
      id: "hints.tour-next",
      keys: "ArrowRight",
      label: "Next tour step",
      group: "Hints",
      priority: 10,
      when: isTourRunning,
      handler: pressNextKey,
    }),
    defineShortcut({
      id: "hints.tour-back",
      keys: "ArrowLeft",
      label: "Previous tour step",
      group: "Hints",
      priority: 10,
      when: isTourRunning,
      handler: () => dispatchTour({ type: "back" }),
    }),
  ],
} satisfies PluginDefinition;
