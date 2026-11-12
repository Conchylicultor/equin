import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { WebsiteStory } from "@plugins/apps/plugins/website/plugins/pages/plugins/story/web";
import { StoryEssay } from "./components/story-essay";

export default {
  description:
    "The story essay on the story page (WebsiteStory.Section): first contact with agents and the skills that taught them to think more like us (the skills graph, the update skill in full), the friction loop that built the agent manager (Me → Friction → My job, a new friction landing on the line, a head full of agents, and the clickable friction chain that unwinds), a world without friction (the backlog that never fills, the review desk), the restart after Google (two screenshots, opened in the image viewer) and the data view as one primitive reused everywhere (a Notion-like reading list, Claude's two surfaces before, and rebuilt on one data view after).",
  contributions: [
    WebsiteStory.Section({
      id: "essay",
      label: "Story essay",
      component: StoryEssay,
    }),
  ],
} satisfies PluginDefinition;
