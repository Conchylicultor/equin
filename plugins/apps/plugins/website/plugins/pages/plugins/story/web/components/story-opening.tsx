import { WebsiteHero } from "@plugins/apps/plugins/website/plugins/shell/web";

/**
 * The story page's heading — "Building equin", the words the homepage's story
 * link offers ("how equin was built"), so following the link confirms rather
 * than re-introduces.
 */
export function StoryOpening() {
  return (
    <WebsiteHero
      kind="page"
      lead="Building "
      accent="equin"
      lede="I worked 8 years at Google Brain/DeepMind as an AI research engineer. Then, one week, I tried Claude Opus (4.6), and everything changed. One month later, I quit Google to build an agentic project on my own. This is my reflection on how I got here."
    />
  );
}
