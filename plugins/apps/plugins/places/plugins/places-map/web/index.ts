import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { GeoMap } from "@plugins/map/web";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { placesMapPane } from "./panes";
import { SavedPlacePin, savedPlaceMark } from "./components/saved-place-pin";
import { placePresentation } from "./internal/fields";
import { SAVED_PLACE_PIN_TYPE } from "./internal/place-visual";
import {
  GoogleResultPin,
  googleResultMark,
} from "./components/google-result-pin";
import { GOOGLE_RESULT_PIN_TYPE } from "./internal/google-result";
import { AskPickPin, askPickMark } from "./components/ask-pick-pin";
import { ASK_PICK_PIN_TYPE } from "./internal/ask-pick";
import { PicksStepLabel, SearchStepLabel } from "./components/ask-step-labels";
import { AgentThreadSlots } from "@plugins/conversations/plugins/agent-thread/web";
import {
  PICKS_TOOL,
  SEARCH_TOOL,
} from "@plugins/apps/plugins/places/plugins/ask/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { agentToolName } from "@plugins/infra/plugins/mcp/core";
import { PicksToolView } from "./components/picks-tool-view";

export default {
  description:
    "The Places app's index pane (/places): every saved place in one full-bleed DataView (Map, Gallery, List) with its chrome floating on the map — the tag sidebar owning the tag half of the view filter (include / exclude, any / all, faceted counts), the \"Search or add places\" bar (your places filtered live, Google's hits around the map's view as cards to save and as ghost pins hover-linked with them, the camera never moving; Ask Sonnet hands a question to a background run shown in the panel as a thread, its picks as Google cards with why they fit and as numbered pins, its progress as a pill in the bar), the selected place's card — plus the saved-place pin (a drop near, a round badge far out with each spot's size beside it), the Google result's ghost pin, Sonnet's numbered pick pin, the thread's step labels for the Ask Sonnet tools, and the transcript row of places_show_picks (the numbered picks beside a mini map, hover-linked).",
  contributions: [
    Pane.Register({ pane: placesMapPane }),
    placePresentation,
    GeoMap.Pin({
      match: SAVED_PLACE_PIN_TYPE,
      component: SavedPlacePin,
      mark: savedPlaceMark,
    }),
    GeoMap.Pin({
      match: GOOGLE_RESULT_PIN_TYPE,
      component: GoogleResultPin,
      mark: googleResultMark,
    }),
    GeoMap.Pin({
      match: ASK_PICK_PIN_TYPE,
      component: AskPickPin,
      mark: askPickMark,
    }),
    AgentThreadSlots.StepLabel({
      match: SEARCH_TOOL,
      component: SearchStepLabel,
    }),
    AgentThreadSlots.StepLabel({
      match: PICKS_TOOL,
      component: PicksStepLabel,
    }),
    JsonlViewerTool.Renderer({
      match: agentToolName(PICKS_TOOL),
      component: PicksToolView,
    }),
  ],
  slots: { "places-map": placesMapPane },
} satisfies PluginDefinition;
