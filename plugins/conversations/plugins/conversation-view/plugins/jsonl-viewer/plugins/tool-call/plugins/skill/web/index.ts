import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { SkillInputSchema, SkillToolView } from "./components/skill-tool-view";

export default {
  description:
    "Renders Skill tool calls with skill name, args preview, and injected context.",
  contributions: [
    JsonlViewerTool.Renderer({
      match: "Skill",
      icon: symbol("auto-awesome"),
      input: SkillInputSchema,
      component: SkillToolView,
    }),
  ],
} satisfies PluginDefinition;
