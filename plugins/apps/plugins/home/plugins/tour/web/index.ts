import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { Hints } from "@plugins/hints/web";
import { ActionBarTracker } from "./components/action-bar-tracker";
import { HandoffTracker } from "./components/handoff-tracker";
import { homeTour } from "./internal/tour";

export default {
  description:
    "Home's onboarding tour (Hints.Tour, primary, auto-started once): the welcome card, then the app gallery, the toolbar (hover to unfold while it floats; Next while docked), Improve — 'Try it' opens it with a first request filled in, sending moves on — the Agent Manager tile, and inside the Agent Manager the row of the conversation that request started ('Here's your request' / 'Your request is ready' → Open it). Until that conversation exists the handoff card waits centered, with Finish tour. Two Core.Root trackers feed the tour page-only data: the request's conversation (from the filed task, while the tour is near it) and whether the toolbar floats or is docked.",
  contributions: [
    Hints.Tour({ tour: homeTour }),
    Core.Root({ component: HandoffTracker }),
    Core.Root({ component: ActionBarTracker }),
  ],
} satisfies PluginDefinition;
