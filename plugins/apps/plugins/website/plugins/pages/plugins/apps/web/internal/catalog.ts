import type { AvatarColor } from "@plugins/primitives/plugins/avatar/core";
import { symbol, type SymbolRef } from "@plugins/ui/plugins/icons/core";
// The apps' screenshots, taken by `plugins/apps/plugins/website/e2e/app-screenshots.ts`
// and cut down to card size (640px JPEG): a web artifact inlines every image it
// imports, so the files stay small. Only apps whose screenshot is fit to publish
// have one; the rest are drawn.
import agentManagerShot from "../shots/app-agent-manager.jpg";
import chordShot from "../shots/app-chord.jpg";
import pagesShot from "../shots/app-pages.jpg";
import prototypesShot from "../shots/app-prototypes.jpg";

export type AppCategoryId = "harness" | "daily" | "tools" | "next";

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
  /** The tile's colour, one categorical palette slot. */
  color: AvatarColor;
  description: string;
  /** The app's screenshot (an image URL); the card draws a stand-in without one. */
  shot?: string;
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
    shot: agentManagerShot,
    name: "Agent manager",
    category: "harness",
    icon: symbol("chat-bubble"),
    color: "sky",
    description:
      "Nested tasks, each worked on by an agent in its own copy of the code. equin's version of Cursor.",
  },
  {
    id: "prototypes",
    shot: prototypesShot,
    name: "Prototypes",
    category: "harness",
    icon: symbol("dashboard-customize"),
    color: "violet",
    description:
      "Mockups beside the real app they mock, with versions and variants. equin's version of Claude Design.",
  },
  {
    id: "deploy",
    name: "Deploy",
    category: "harness",
    icon: symbol("cloud"),
    color: "teal",
    description: "A self-hosted PaaS. It deploys the site you are reading.",
  },
  {
    id: "pages",
    shot: pagesShot,
    name: "Pages",
    category: "daily",
    icon: symbol("description"),
    color: "slate",
    description:
      "A Notion-like editor and agentic wiki: blocks, databases, backlinks, and agents writing beside you.",
  },
  {
    id: "sonata",
    name: "Sonata",
    category: "daily",
    icon: symbol("piano"),
    color: "emerald",
    description:
      "Learn piano from any song: a piano roll, chords broken down, and practice that adapts to you.",
  },
  {
    id: "events",
    name: "Events",
    category: "daily",
    icon: symbol("event"),
    color: "orange",
    description:
      "Social events from many sources, in one place, on a map and a calendar.",
  },
  {
    id: "chord",
    shot: chordShot,
    name: "Chord",
    category: "daily",
    icon: symbol("queue-music"),
    color: "pink",
    description:
      "An ear trainer that plays loops of real songs and asks you to name each chord.",
  },
  {
    id: "browser",
    name: "Browser",
    category: "tools",
    icon: symbol("public"),
    color: "indigo",
    description:
      "A minimal web browser, so a page can sit next to the app that uses it.",
  },
  {
    id: "files",
    name: "Files",
    category: "tools",
    icon: symbol("folder"),
    color: "amber",
    description:
      "Browse and preview files on your machine and in every agent's workspace.",
  },
  {
    id: "mail",
    name: "Mail",
    category: "next",
    icon: symbol("mail"),
    color: "rose",
    soon: true,
    description:
      "An Inbox-like email client, recreated: bundles, snoozes, and an agent that drafts replies.",
  },
  {
    id: "finance",
    name: "Finance",
    category: "next",
    icon: symbol("account-balance"),
    color: "emerald",
    soon: true,
    description: "Every account in one place: a personal finance aggregator.",
  },
  {
    id: "maps",
    name: "Maps",
    category: "next",
    icon: symbol("map"),
    color: "teal",
    soon: true,
    description: "Places you've been, and a smarter wishlist of where to go.",
  },
];
