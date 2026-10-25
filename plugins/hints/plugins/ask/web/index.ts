import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { DynamicEnum } from "@plugins/fields/plugins/dynamic-enum/plugins/config/web";
import { useModelChoiceOptions } from "@plugins/conversations/plugins/model-provider/web";
import { HelpMenu } from "@plugins/hints/plugins/help-menu/web";
// Side-effect import, and the composition edge: the element picker's barrel
// stamps every slot contribution with its lineage, which is what the page
// outline a question carries is made of. Wherever this card is, those markers
// are too (without them the outline is regions only).
import "@plugins/primitives/plugins/ui-context/plugins/element-picker/web";
import {
  InlineChip,
  inlineChip,
} from "@plugins/primitives/plugins/text-editor/plugins/inline-chip/web";
import { PAGE_CONTEXT_RE, askConfig } from "../core";
import { AskEquinEntry } from "./components/ask-entry";
import { AskHost } from "./components/ask-host";
import { PageContextChip } from "./components/page-context-chip";

export default {
  description:
    "Ask equin, web half: the ? menu's entry (Ask equin how to… / Back to your question), and the AskHost at Core.Root — a draggable card in the chrome's theme holding one threaded conversation with the help agent (AgentThread; a filed task shows as its live status and title, opening in the Agent Manager), above every tab so it follows the user across apps: suggested questions (plus, for a developer, an Agent instructions row opening the Ask equin config — a header action once a thread runs) and a first-question box when empty (the first send attaches the focused app, route, tab title and the page outline), minimized to a pill with the step it is on and an unseen dot, its position kept edge-anchored and snapped only near a corner, and the newest unseen or working run taken back as the pill once per load. A reply sent from another page carries that page (a <page-context> token after the words, drawn as a chip naming the page). Registers the Ask equin config with both model pickers.",
  contributions: [
    Core.Root({ component: AskHost }),
    HelpMenu.Entry({
      id: "ask",
      label: "Ask equin how to…",
      component: AskEquinEntry,
    }),
    // The page a reply was sent from, in the user's bubble (and the Agent
    // Manager's transcript): transcript only — it is addressed to the agent.
    InlineChip.Tag(
      inlineChip({
        id: "ask-page-context",
        pattern: PAGE_CONTEXT_RE,
        surfaces: ["transcript"],
        modelText: "self-describing",
        component: PageContextChip,
      }),
    ),
    ConfigV2.WebRegister({ descriptor: askConfig }),
    DynamicEnum.Options({
      field: askConfig.fields.model,
      useOptions: useModelChoiceOptions,
    }),
    DynamicEnum.Options({
      field: askConfig.fields.taskModel,
      useOptions: useModelChoiceOptions,
    }),
  ],
} satisfies PluginDefinition;
