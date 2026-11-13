import { WebsiteHero } from "@plugins/apps/plugins/website/plugins/shell/web";

/** The privacy page's heading: who counts the visits, and for what. */
export function PrivacyOpening() {
  return (
    <WebsiteHero
      kind="page"
      lead="Your "
      accent="privacy"
      lede="equin.ai counts its own visits, on its own server, to learn which pages work. No ads, no third parties, nothing sold or shared."
    />
  );
}
