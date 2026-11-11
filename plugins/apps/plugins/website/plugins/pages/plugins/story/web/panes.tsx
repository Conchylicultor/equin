import { Pane, defineRoute } from "@plugins/primitives/plugins/pane/web";
import { websiteApp } from "@plugins/apps/plugins/website/plugins/shell/core";
import { storyPage } from "../core";
import {
  WebsiteChrome,
  WebsiteHeader,
  WebsiteSoon,
} from "@plugins/apps/plugins/website/plugins/shell/web";
import { WebsiteStory } from "./slots";
import { StoryOpening } from "./components/story-opening";

/**
 * The story page at `/website/story` — where equin came from, for a reader who
 * wants the context behind the project.
 *
 * Wears the shared site header (`actions: WebsiteHeader`), so the wordmark and
 * every nav link follow the reader here, and renders every
 * `WebsiteStory.Section` contribution below the opening. Unwritten so far, so
 * the heading is followed by the site's "more details soon" note.
 */
export const storyPane = Pane.define({
  route: defineRoute({ id: "website-story", segment: "story" }),
  app: websiteApp,
  actions: WebsiteHeader,
  title: storyPage.title,
  component: StoryBody,
});

function StoryBody() {
  return (
    <WebsiteChrome pane={storyPane}>
      <StoryOpening />
      <WebsiteSoon />
      <WebsiteStory.Section.Render />
    </WebsiteChrome>
  );
}
