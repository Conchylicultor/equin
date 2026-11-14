import { websitePagePart } from "@plugins/apps/plugins/website/plugins/shell/web";
import { storyPage } from "@plugins/apps/plugins/website/plugins/pages/plugins/story/core";

/**
 * <SkillsGraph> as its own chunk, fetched only where the story page is shown
 * (`websitePagePart`): the site's code loads as one app, so a static figure
 * was downloaded and evaluated on every page of it.
 */
export const SkillsGraph = websitePagePart(storyPage, () =>
  import("./components/skills-graph").then((m) => m.SkillsGraph),
);
