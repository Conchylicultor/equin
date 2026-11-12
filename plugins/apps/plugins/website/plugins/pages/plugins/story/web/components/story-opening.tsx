import { WebsiteHero } from "@plugins/apps/plugins/website/plugins/shell/web";

/**
 * The story page's heading — "Building equin", answering the homepage's story
 * link ("Curious how equin came to be?").
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
