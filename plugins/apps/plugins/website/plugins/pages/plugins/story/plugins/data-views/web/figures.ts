import { websitePagePart } from "@plugins/apps/plugins/website/plugins/shell/web";
import { storyPage } from "@plugins/apps/plugins/website/plugins/pages/plugins/story/core";

// Each figure is its own chunk, fetched only where the story page is shown
// (`websitePagePart`): the site's code loads as one app, so a static figure
// was downloaded and evaluated on every page of it. The three share one module
// (`./components/data-view-figure`), so one chunk.

const figures = () => import("./components/data-view-figure");

/** <NotionDataView>: a Notion-like reading list on the data view. */
export const NotionDataView = websitePagePart(storyPage, () =>
  figures().then((m) => m.NotionDataView),
);

/** <ClaudeBefore>: Claude's two surfaces, two partial data views. */
export const ClaudeBefore = websitePagePart(storyPage, () =>
  figures().then((m) => m.ClaudeBefore),
);

/** <ClaudeAfter>: the same two surfaces on one data view. */
export const ClaudeAfter = websitePagePart(storyPage, () =>
  figures().then((m) => m.ClaudeAfter),
);
