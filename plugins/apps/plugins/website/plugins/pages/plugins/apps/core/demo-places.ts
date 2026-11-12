/** A gallery app the homepage's live demo carries. */
export interface AppDemoPlace {
  /**
   * The app's home — its base path (`/sonata`): the card's "Try it live"
   * opens the demo maximized there (`/about/at/<home>;full=1`), where a
   * visitor starts using it. Text, not the app's descriptor: importing an
   * app's shell would pull it into the website composition's bundle.
   */
  readonly home: string;
  /**
   * The staged frame the card's picture is taken at — an app-rooted location
   * inside the demo (`/sonata/song/<id>;bar=12`), photographed by the
   * website's `e2e/app-screenshots.ts`. Never where the card opens: a frame
   * picked for a picture is not where someone trying the app begins.
   */
  readonly shot: string;
}

/**
 * Every gallery app the homepage's live demo carries
 * (`website/demos/workspace`), keyed by the catalog's app id.
 *
 * Every `shot` lies under its `home`. The ids in `shot` are the demo's seeded ones (its story, `story/core`),
 * written as text because the site never bundles the story. A frame worth
 * publishing is a real use of the app — a song in the piano roll, a page with
 * every block — not its empty landing.
 */
export const APP_DEMO_PLACES: Readonly<Record<string, AppDemoPlace>> = {
  // The practice-timer agent, waiting for review.
  agents: { home: "/agents", shot: "/agents/c/conv-demo-practice-timer" },
  prototypes: { home: "/prototypes", shot: "/prototypes" },
  // "Block tour": one of every block.
  pages: { home: "/pages", shot: "/pages/page/block-1760000000-demo30" },
  // Chopin's Nocturne Op. 48 No. 1 in the piano roll, a few bars in.
  sonata: {
    home: "/sonata",
    shot: "/sonata/song/song-1792900000-demo04;bar=12",
  },
  // Demo's home folder, a note previewed beside it.
  files: {
    home: "/files",
    shot: "/files/browse/~;fs=browser/preview/This%20week.md",
  },
  maps: { home: "/places", shot: "/places" },
};
