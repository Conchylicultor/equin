import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { partyConfig } from "../core";

export { PartyStage } from "./components/party-stage";

export default {
  description:
    "Keyboard Party's stage: every key plays its own animation and sound (letters bring a picture, a word and speech; digits count; space, Enter, arrows, Backspace and modifiers each have their own effect), with a bead trail of recent keys, a full-screen keyboard lock and the party settings.",
  contributions: [ConfigV2.WebRegister({ descriptor: partyConfig })],
} satisfies PluginDefinition;
