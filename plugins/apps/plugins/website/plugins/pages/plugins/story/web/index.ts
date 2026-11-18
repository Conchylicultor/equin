import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { Website } from "@plugins/apps/plugins/website/plugins/shell/web";
import { storyPane } from "./panes";
import { WebsiteStory } from "./slots";
import { StoryNavItem } from "./components/story-nav-item";

export { storyPane } from "./panes";
export { WebsiteStory } from "./slots";

export default {
  description:
    "The story page of the equin website: the /about/story pane answering 'how did equin come to be?', its entry in the header's Learn menu, and the WebsiteStory.Section slot the story is written into.",
  contributions: [
    // This pane BORROWS the shared site header (`actions: WebsiteHeader`), so it
    // mints no slot of its own and is deliberately absent from `slots:` — the
    // header is declared once, by `apps.website.shell`.
    Pane.Register({ pane: storyPane }),
    Website.LearnEntry({
      id: "story",
      label: "Story",
      component: StoryNavItem,
    }),
  ],
  slots: { ...WebsiteStory },
} satisfies PluginDefinition;
