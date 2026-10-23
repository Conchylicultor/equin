import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ActionBar } from "@plugins/shell/plugins/action-bar/web";
import { HelpButton } from "./components/help-button";
import {
  AskEquinEntry,
  ReadGuideEntry,
  ReplayTourEntry,
  ShowTipsAgainEntry,
} from "./components/entries";
import { HelpMenu } from "./slots";

export { HelpMenu } from "./slots";
export type { HelpMenuEntryContribution } from "./slots";
export { useCloseHelpMenu } from "./internal/close-menu";

export default {
  description:
    'The ? "Getting started" menu on the global action bar — the hints engine\'s help anchor, ringed while a tour end pulses it — rendering the open HelpMenu.Entry slot: Replay the tour (the primary tour), Show tips again (resets every declared tip), Read the guide (equin.ai, new tab) and Ask equin how to… (a launch form filed under Help).',
  slots: HelpMenu,
  contributions: [
    ActionBar.Item({ id: "help", component: HelpButton }),
    HelpMenu.Entry({
      id: "replay-tour",
      label: "Replay the tour",
      component: ReplayTourEntry,
    }),
    HelpMenu.Entry({
      id: "show-tips",
      label: "Show tips again",
      component: ShowTipsAgainEntry,
    }),
    HelpMenu.Entry({
      id: "read-guide",
      label: "Read the guide",
      component: ReadGuideEntry,
    }),
    HelpMenu.Entry({
      id: "ask",
      label: "Ask equin how to…",
      component: AskEquinEntry,
    }),
  ],
} satisfies PluginDefinition;
