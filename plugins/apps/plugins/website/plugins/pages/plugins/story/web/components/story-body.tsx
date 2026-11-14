import { WebsiteChrome } from "@plugins/apps/plugins/website/plugins/shell/web";
import { storyPane } from "../panes";
import { WebsiteStory } from "../slots";
import { StoryOpening } from "./story-opening";

/**
 * The story page's body: the opening, then every `WebsiteStory.Section`
 * contribution below it inside `WebsiteChrome`. Its own chunk
 * (`websitePagePart`), fetched only where the page is shown.
 */
export function StoryBody() {
  return (
    <WebsiteChrome pane={storyPane}>
      <StoryOpening />
      <WebsiteStory.Section.Render />
    </WebsiteChrome>
  );
}
