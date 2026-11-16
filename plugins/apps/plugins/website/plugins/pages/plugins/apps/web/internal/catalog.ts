// The apps' screenshots, taken by `plugins/apps/plugins/website/e2e/app-screenshots.ts`
// and cut down to card size (640px JPEG): a web artifact inlines every image it
// imports, so the files stay small. An app the live demo carries is shot in the
// demo, at its staged `shot` place (`APP_DEMO_PLACES`); only apps whose
// screenshot is fit to publish have one; the rest are drawn.
import type { ImportedImage } from "@plugins/framework/plugins/image-import/core";
import { APPS as CATALOG, type CatalogEntry } from "../../core";
import agentsShot from "../shots/app-agents.jpg";
import chordShot from "../shots/app-chord.jpg";
import desktopShot from "../shots/app-desktop.jpg";
import filesShot from "../shots/app-files.jpg";
import isleShot from "../shots/app-isle.jpg";
import mapsShot from "../shots/app-maps.jpg";
import pagesShot from "../shots/app-pages.jpg";
import prototypesShot from "../shots/app-prototypes.jpg";
import sonataShot from "../shots/app-sonata.jpg";

export interface CatalogApp extends CatalogEntry {
  /** The app's screenshot (its URL and size); the card draws a stand-in without one. */
  shot?: ImportedImage;
}

/** Each app's screenshot, by catalog id. */
const SHOTS: Readonly<Record<string, ImportedImage>> = {
  agents: agentsShot,
  prototypes: prototypesShot,
  pages: pagesShot,
  sonata: sonataShot,
  maps: mapsShot,
  chord: chordShot,
  files: filesShot,
  desktop: desktopShot,
  isle: isleShot,
};

/** The catalog (core/), each app with its screenshot. */
export const APPS: readonly CatalogApp[] = CATALOG.map((app) => ({
  ...app,
  shot: SHOTS[app.id],
}));
