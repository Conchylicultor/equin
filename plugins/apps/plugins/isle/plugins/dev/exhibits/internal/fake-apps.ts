// Made-up apps, to watch the world grow: 14 standing in for the installed ones,
// then the rest interleaved by category, so adding them one by one grows every
// district a little. Deterministic: the same list, in the same order (the
// prototype's `apps.js`).

import type { AppCategory } from "@plugins/primitives/plugins/pane/core";

export interface FakeApp {
  readonly id: string;
  readonly name: string;
  readonly category: AppCategory;
  readonly hue: string;
}

const BASE: readonly (readonly [string, string, AppCategory, string])[] = [
  ["agents", "Agents", "work", "#e8a04a"],
  ["pages", "Pages", "create", "#6f8fd8"],
  ["mail", "Mail", "life", "#d9604c"],
  ["places", "Places", "life", "#4fae7a"],
  ["sonata", "Sonata", "music", "#a46fd8"],
  ["chord", "Chord", "music", "#d86fa8"],
  ["browser", "Browser", "life", "#3fa7c4"],
  ["files", "Files", "data", "#c9a24a"],
  ["events", "Events", "data", "#5fb8a8"],
  ["studio", "Studio", "work", "#8a7bd0"],
  ["deploy", "Deploy", "work", "#e07a5f"],
  ["protos", "Prototypes", "create", "#e0b44c"],
  ["party", "Keyboard Party", "play", "#f08ab0"],
  ["settings", "Settings", "system", "#8f9aa8"],
];

const MORE: Readonly<Record<AppCategory, readonly string[]>> = {
  work: [
    "Tasks",
    "Kanban",
    "Time Tracker",
    "Invoices",
    "Meetings",
    "CRM",
    "Hiring",
    "Roadmap",
    "Standup",
    "OKRs",
    "Timesheets",
    "Contracts",
    "Inventory",
    "Shipping",
    "Support Desk",
    "Wiki",
    "Code Review",
    "CI Runs",
    "Incidents",
  ],
  create: [
    "Sketchbook",
    "Photo Editor",
    "Video Cuts",
    "Mood Board",
    "Fonts",
    "Color Lab",
    "Storyboard",
    "Poems",
    "Journal",
    "Blog",
    "Slides",
    "Diagrams",
    "Mind Map",
    "Comics",
    "3D Models",
    "Screenplay",
    "Zine",
    "Logo Maker",
    "Pixel Art",
    "Animation",
  ],
  music: [
    "Podcasts",
    "Radio",
    "Metronome",
    "Tuner",
    "Playlists",
    "Drum Machine",
    "Lyrics",
    "Concerts",
    "Vinyl Shelf",
    "Synth",
    "Sheet Music",
    "Choir",
    "Field Recorder",
    "Loops",
    "Karaoke",
    "Mixer",
    "Audiobooks",
  ],
  life: [
    "Recipes",
    "Groceries",
    "Weather",
    "Garden Log",
    "Habit Tracker",
    "Calendar",
    "Contacts",
    "Fitness",
    "Sleep",
    "Meditation",
    "Travel",
    "Bookshelf",
    "Movies",
    "Pets",
    "Home",
    "Plants",
    "Birthdays",
    "Wardrobe",
    "Chores",
  ],
  data: [
    "Budget",
    "Spreadsheets",
    "Analytics",
    "Stocks",
    "Bank",
    "Taxes",
    "Receipts",
    "Backups",
    "Photos",
    "Archive",
    "Bookmarks",
    "Read Later",
    "Feeds",
    "Dashboards",
    "Passwords",
    "Documents",
    "Census",
    "Search",
  ],
  play: [
    "Chess",
    "Sudoku",
    "Crosswords",
    "Solitaire",
    "Puzzles",
    "Trivia",
    "Word Games",
    "Go",
    "Flashcards",
    "Typing Race",
    "Riddles",
    "Mahjong",
    "Dice",
    "Kids Stories",
    "Coloring",
    "Memory",
    "Card Games",
    "Doodle Games",
  ],
  system: [
    "Terminal",
    "Network",
    "Updates",
    "Storage",
    "Battery",
    "Accounts",
    "Privacy",
    "Notifications",
    "Keyboard",
    "Display",
    "Extensions",
    "Devices",
    "Printers",
    "Alarms",
    "Shortcuts",
    "Security",
    "Diagnostics",
  ],
};

const HUES = [
  "#b5784f",
  "#6f8fa8",
  "#8a9a5b",
  "#a86f7c",
  "#7b8fbf",
  "#c4a35a",
  "#6fa39a",
  "#9c7bb0",
  "#c27c5c",
  "#5f8f7a",
  "#b08a6a",
  "#7d9cb5",
];

/** Every made-up app, in the order they are added: 142 of them. */
export const FAKE_APPS: readonly FakeApp[] = (() => {
  const out: FakeApp[] = BASE.map(([id, name, category, hue]) => ({
    id: `x-${id}`,
    name,
    category,
    hue,
  }));
  const cats = Object.keys(MORE) as AppCategory[];
  const total = out.length + cats.reduce((n, c) => n + MORE[c].length, 0);
  for (let i = 0; out.length < total; i++)
    for (const c of cats) {
      const name = MORE[c][i];
      if (name === undefined) continue;
      out.push({
        id: `x-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        name,
        category: c,
        hue: HUES[out.length % HUES.length]!,
      });
    }
  return out;
})();

export const MIN_APPS = 14;
export const MAX_APPS = FAKE_APPS.length;
