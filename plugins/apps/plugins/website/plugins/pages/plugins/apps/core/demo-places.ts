/**
 * Where each gallery app opens in the homepage's live demo — an app-rooted
 * location inside the demo (`/sonata/song/<id>;bar=12`), keyed by the
 * catalog's app id. The website's `e2e/app-screenshots.ts` photographs that
 * frame for the gallery card's picture; the card itself (a "Try it live" link)
 * opens the homepage, where the demo starts from its own beginning.
 *
 * Only apps the demo carries (`website/demos/workspace`) have one; the ids
 * below are the demo's seeded ones (its story, `story/core`), written as text
 * because the site never bundles the story. A frame worth publishing is a
 * real use of the app — a song in the piano roll, a page with every block —
 * not its empty landing.
 */
export const APP_DEMO_PLACES: Readonly<Record<string, string>> = {
  // The practice-timer agent, waiting for review.
  agents: "/agents/c/conv-demo-practice-timer",
  prototypes: "/prototypes",
  // "Block tour": one of every block.
  pages: "/pages/page/block-1760000000-demo30",
  // Chopin's Nocturne Op. 48 No. 1 in the piano roll, a few bars in.
  sonata: "/sonata/song/song-1792900000-demo04;bar=12",
  // Demo's home folder, a note previewed beside it.
  files: "/files/browse/~;fs=browser/preview/This%20week.md",
  maps: "/places",
};
