import { Pane, defineRoute } from "@plugins/primitives/plugins/pane/web";
import { websiteApp } from "@plugins/apps/plugins/website/plugins/shell/core";
import { storyPage } from "../core";
import {
  WebsiteHeader,
  websitePagePart,
} from "@plugins/apps/plugins/website/plugins/shell/web";

/**
 * The story page at `/about/story` — where equin came from, for a reader who
 * wants the context behind the project.
 *
 * Wears the shared site header (`actions: WebsiteHeader`), so the wordmark and
 * every nav link follow the reader here, and renders every
 * `WebsiteStory.Section` contribution below the opening — the story itself is
 * written there (`story/essay`). The body is its own chunk, fetched only where
 * the page is shown.
 */
export const storyPane = Pane.define({
  route: defineRoute({ id: "website-story", segment: "story" }),
  app: websiteApp,
  actions: WebsiteHeader,
  title: storyPage.title,
  component: websitePagePart(storyPage, () =>
    import("./components/story-body").then((m) => m.StoryBody),
  ),
});
