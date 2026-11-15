import type { AppTileColor } from "@plugins/apps-core/plugins/app-icon/plugins/tile-colors/core";
import {
  appIcon,
  type AppIcon,
} from "@plugins/apps-core/plugins/app-icon/core";
import { symbol, type SymbolRef } from "@plugins/ui/plugins/icons/core";
// The apps' screenshots, taken by `plugins/apps/plugins/website/e2e/app-screenshots.ts`
// and cut down to card size (640px JPEG): a web artifact inlines every image it
// imports, so the files stay small. An app the live demo carries is shot in the
// demo, at its staged `shot` place (`APP_DEMO_PLACES`); only apps whose
// screenshot is fit to publish have one; the rest are drawn.
import type { ImportedImage } from "@plugins/framework/plugins/image-import/core";
import agentsShot from "../shots/app-agents.jpg";
import chordShot from "../shots/app-chord.jpg";
import desktopShot from "../shots/app-desktop.jpg";
import filesShot from "../shots/app-files.jpg";
import isleShot from "../shots/app-isle.jpg";
import mapsShot from "../shots/app-maps.jpg";
import pagesShot from "../shots/app-pages.jpg";
import prototypesShot from "../shots/app-prototypes.jpg";
import sonataShot from "../shots/app-sonata.jpg";

export type AppCategoryId = "harness" | "daily" | "tools" | "surfaces" | "next";

export interface AppCategory {
  id: AppCategoryId;
  name: string;
  /** The line beside the group's heading. */
  body: string;
}

export interface CatalogApp {
  id: string;
  name: string;
  category: AppCategoryId;
  /** The glyph the app's own definition declares (`defineApp({ icon: symbol(…) })`), so the card wears the icon the rail draws. */
  icon: SymbolRef;
  /**
   * The id of the app's own definition (`defineApp({ id })`), `null` for an
   * app not built yet. Text, not the descriptor: importing an app's shell
   * would pull it into the website's composition.
   */
  appId: string | null;
  /**
   * The app's tile colour — a copy of its definition's `iconColor`, so the
   * site draws the tile the app draws (`AppIconTile`); `catalog.test.ts`
   * holds the two equal.
   */
  color: AppTileColor;
  description: string;
  /** One short line, for where the description does not fit (the homepage's app shelf). */
  summary?: string;
  /** The app's screenshot (its URL and size); the card draws a stand-in without one. */
  shot?: ImportedImage;
  /** Not built yet: drawn dimmed, with no Install. */
  soon?: boolean;
}

/** The gallery's groups, in reading order. */
export const CATEGORIES: readonly AppCategory[] = [
  {
    id: "harness",
    name: "The harness",
    body: "The apps used to build equin itself",
  },
  { id: "daily", name: "Daily life", body: "The apps used every day" },
  { id: "tools", name: "Tools", body: "Small utilities the others lean on" },
  // Not apps of their own kind: two ways to hold every other app at once.
  {
    id: "surfaces",
    name: "Home screens",
    body: "The workspace to organize your apps",
  },
  { id: "next", name: "Coming next", body: "Being built now" },
];

/**
 * Every app equin ships, and the ones being built — a closed list, plain data.
 * Adding an app to equin does not add it here: the site is a written page, and
 * this is its copy.
 */
export const APPS: readonly CatalogApp[] = [
  {
    id: "agents",
    appId: "agent-manager",
    color: "sky",
    shot: agentsShot,
    name: "Agent manager",
    category: "harness",
    icon: symbol("chat-bubble"),
    summary: "Agents working through a task tree",
    description:
      "Nested tasks, each worked on by an agent in its own copy of the code. equin's version of Cursor.",
  },
  {
    id: "prototypes",
    appId: "prototypes",
    color: "violet",
    shot: prototypesShot,
    name: "Prototypes",
    category: "harness",
    icon: symbol("dashboard-customize"),
    summary: "Mockups beside the real app",
    description:
      "Mockups beside the real app they mock, with versions and variants. equin's version of Claude Design.",
  },
  {
    id: "deploy",
    appId: "deploy",
    color: "teal",
    name: "Deploy",
    category: "harness",
    icon: symbol("cloud"),
    description: "A self-hosted PaaS. It deploys the site you are reading.",
  },
  {
    id: "pages",
    appId: "pages",
    color: "blue",
    shot: pagesShot,
    name: "Pages",
    category: "daily",
    icon: symbol("description"),
    summary: "Notion-like editor and agentic wiki",
    description:
      "A Notion-like editor and agentic wiki: blocks, databases, backlinks, and agents writing beside you.",
  },
  {
    id: "sonata",
    appId: "sonata",
    color: "emerald",
    shot: sonataShot,
    name: "Sonata",
    category: "daily",
    icon: symbol("piano"),
    summary: "Learn piano from any song",
    description:
      "Learn piano from any song: a piano roll, chords broken down, and practice that adapts to you.",
  },
  {
    id: "events",
    appId: "events",
    color: "orange",
    name: "Events",
    category: "daily",
    icon: symbol("event"),
    description:
      "Social events from many sources, in one place, on a map and a calendar.",
  },
  {
    id: "maps",
    appId: "places",
    color: "green",
    shot: mapsShot,
    name: "Maps",
    category: "daily",
    icon: symbol("location-on"),
    summary: "Every place you love, on one map",
    description:
      "The places you want to go and have been, on one map, sorted by a tree of tags.",
  },
  {
    id: "chord",
    appId: "chord",
    color: "pink",
    shot: chordShot,
    name: "Chord",
    category: "daily",
    icon: symbol("queue-music"),
    summary: "Name the chords of real songs",
    description:
      "An ear trainer that plays loops of real songs and asks you to name each chord.",
  },
  {
    id: "browser",
    appId: "browser",
    color: "indigo",
    name: "Browser",
    category: "tools",
    icon: symbol("public"),
    description:
      "A minimal web browser, so a page can sit next to the app that uses it.",
  },
  {
    id: "files",
    appId: "file-explorer",
    color: "amber",
    shot: filesShot,
    name: "Files",
    category: "tools",
    icon: symbol("folder"),
    summary: "Your files and every agent's",
    description:
      "Browse and preview files on your machine and in every agent's workspace.",
  },
  {
    id: "desktop",
    appId: "desktop",
    color: "cyan",
    name: "Desktop",
    category: "surfaces",
    icon: symbol("desktop-windows"),
    shot: desktopShot,
    description: "Use equin as a desktop, with every app in its own window.",
  },
  {
    id: "isle",
    appId: "isle",
    color: "mint",
    name: "Isle",
    category: "surfaces",
    icon: symbol("sailing"),
    shot: isleShot,
    description:
      "An RPG-style workspace where you walk around to open your apps.",
  },
  {
    id: "studio",
    appId: "studio",
    color: "purple",
    name: "Studio",
    category: "harness",
    icon: symbol("extension"),
    description:
      "Every plugin of equin, its graph and what it contributes, open to inspect.",
  },
  {
    id: "party",
    appId: "keyboard-party",
    color: "fuchsia",
    name: "Tap Tap Party",
    category: "daily",
    icon: symbol("celebration"),
    description:
      "A keyboard toy for a small child: every key answers with its own animation and sound.",
  },
  {
    id: "mail",
    appId: "mail",
    color: "rose",
    name: "Mail",
    category: "next",
    icon: symbol("mail"),
    soon: true,
    description:
      "An Inbox-like email client, recreated: bundles, snoozes, and an agent that drafts replies.",
  },
  {
    id: "finance",
    appId: null,
    color: "gold",
    name: "Finance",
    category: "next",
    icon: symbol("account-balance"),
    soon: true,
    description: "Every account in one place: a personal finance aggregator.",
  },
];

/** The app's icon as its tile draws it: its glyph on its colour (`AppIconTile`). */
export function catalogAppIcon(app: CatalogApp): AppIcon {
  return appIcon(app.icon, { color: app.color });
}
