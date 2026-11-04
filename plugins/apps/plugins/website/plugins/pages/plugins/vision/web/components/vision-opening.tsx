import { WebsiteHero } from "@plugins/apps/plugins/website/plugins/shell/web";

/**
 * The vision page's heading: the vision this page argues, and the question it
 * answers. The page's zoom (`VisionZoom`) dissolves it as the page moves.
 */
export function VisionOpening() {
  return (
    <WebsiteHero
      kind="page"
      lead="A vision for "
      accent="applications"
      lede="What will apps evolve into in the age of agents? A new kind of application, which could not exist before."
    />
  );
}
