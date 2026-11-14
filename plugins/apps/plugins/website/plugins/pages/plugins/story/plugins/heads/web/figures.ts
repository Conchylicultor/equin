import { websitePagePart } from "@plugins/apps/plugins/website/plugins/shell/web";
import { storyPage } from "@plugins/apps/plugins/website/plugins/pages/plugins/story/core";

// Each figure is its own chunk, fetched only where the story page is shown
// (`websitePagePart`): the site's code loads as one app, so a static figure
// was downloaded and evaluated on every page of it.

/** <MindOverload>: agents crowding into one head (`./components/mind-overload`). */
export const MindOverload = websitePagePart(storyPage, () =>
  import("./components/mind-overload").then((m) => m.MindOverload),
);

/** <ReviewDesk>: ideas reviewed one at a time (`./components/review-desk`). */
export const ReviewDesk = websitePagePart(storyPage, () =>
  import("./components/review-desk").then((m) => m.ReviewDesk),
);
