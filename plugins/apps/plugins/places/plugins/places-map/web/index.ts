import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
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
  PlacesPicksSchema,
  SEARCH_TOOL,
} from "@plugins/apps/plugins/places/plugins/ask/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { agentToolName } from "@plugins/infra/plugins/mcp/core";
import { PicksToolView } from "./components/picks-tool-view";
import { PageItemPin, pageItemPinMark } from "./components/page-item-pin";
import { PAGE_ITEM_PIN_TYPE } from "./internal/page-item";
import {
  PageOverlayItemActions,
  SavePageItemAction,
} from "./components/page-overlay-panel";

export default {
  description:
    "The Places app's index pane (/places): every saved place on one full-bleed map whose views are filter presets (All places, then the user's own — edits are drafts until saved, ⌥1–9 switch), with its chrome floating on the map — the tag sidebar (the presets with their counts and dirty dots, the tag filter as AND-ed rows of OR-ed tags with the preset's Reset / Save as new / Update, the tag tree with faceted counts; folded, the header alone, titled by a dropdown of the presets), the side panel (the preset's places in view or all, as a list or a gallery, hover-linked with their pins, a selected place's card drilled into it), the \"Search or add places\" bar (your places filtered live, Google's hits around the map's view as cards to save and as ghost pins hover-linked with them, the camera never moving; Ask Sonnet hands a question to a background run shown as a thread in a card docked on the right — the newest picks as Google cards with photos, why they fit, what makes them special and their sources, earlier answers folded, as numbered pins — its progress as a pill in the bar that shows and hides the card, and the recent questions in the panel to reopen), the selected place's card or a Google place's detail card — plus the saved-place pin (a drop near, a round badge far out with each spot's size beside it), the Google result's ghost pin, Sonnet's numbered pick pin, the thread's step labels for the Ask Sonnet tools, and the transcript row of places_show_picks (the numbered picks beside a mini map, hover-linked). Its ;page param, /places;page=<pageId>, lays one page's places over the same map, read live (page-overlay): the page's saved places numbered, the rest dimmed, the page's places not saved yet as numbered ghost pins, the camera framed on the page, the map never remounted — and a panel in the side panel's spot listing them in page order (hover-linked with their pins, each place's card drilled in, Save and Save all with one Undo, × back to the plain map).",
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
      match: PAGE_ITEM_PIN_TYPE,
      component: PageItemPin,
      mark: pageItemPinMark,
    }),
    PageOverlayItemActions({ id: "save", component: SavePageItemAction }),
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
      icon: symbol("location-on"),
      input: PlacesPicksSchema,
      component: PicksToolView,
    }),
  ],
  slots: {
    "places-map": placesMapPane,
    pageOverlayItemActions: PageOverlayItemActions,
  },
} satisfies PluginDefinition;
