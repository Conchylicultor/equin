import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { WebsiteLearnLink } from "@plugins/apps/plugins/website/plugins/shell/web";
import { storyPane } from "../panes";

/**
 * "Story" in the shared site header's Learn menu. Opens the story page.
 */
export function StoryNavItem() {
  const openPane = useOpenPane();
  return (
    <WebsiteLearnLink
      label="Story"
      gloss="How equin came to be"
      {...openPane.link(storyPane, {}, { mode: "root" })}
    />
  );
}
