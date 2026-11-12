import { esc, hash, ic } from "./styles";

/* The figures' invented data and row renderers, ported verbatim from the prototype's `claude.js`
   (`proto-1794207359-w7ez6h`). Every title is invented. */

/* ============================== invented data ============================== */
const NOW = Date.UTC(2026, 10, 11, 15);
const MON = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const dateStr = (h: number) => {
  const d = new Date(NOW - h * 36e5);
  return MON[d.getUTCMonth()]! + " " + d.getUTCDate();
};
export const shortAgo = (h: number) =>
  h < 1 ? "Just now" : h < 24 ? Math.round(h) + "h ago" : dateStr(h);
export const longAgo = (h: number) => {
  if (h < 1) return "Just now";
  if (h < 24) {
    const n = Math.round(h);
    return n + (n === 1 ? " hour ago" : " hours ago");
  }
  if (h < 24 * 8) {
    const n = Math.round(h / 24);
    return n + (n === 1 ? " day ago" : " days ago");
  }
  return dateStr(h);
};
export const BUCKETS = [
  "Today",
  "Yesterday",
  "Past 7 days",
  "Past 30 days",
  "Older",
];
export const bucket = (h: number) =>
  h < 24
    ? "Today"
    : h < 48
      ? "Yesterday"
      : h < 168
        ? "Past 7 days"
        : h < 720
          ? "Past 30 days"
          : "Older";
export const DATES = [
  "Any time",
  "Today",
  "Yesterday",
  "Past 7 days",
  "Past 30 days",
];
export const inDate = (h: number, d: string) =>
  d === "Any time" ||
  (d === "Today"
    ? h < 24
    : d === "Yesterday"
      ? h >= 24 && h < 48
      : d === "Past 7 days"
        ? h < 168
        : h < 720);
export const PROJECTS = ["Personal", "Work", "Music", "Travel", "Writing"];
export const TYPES = [
  "Docs",
  "Slides",
  "Sheets",
  "Design",
  "Data",
  "Whiteboard",
  "Other",
];
export const KIND: Record<string, { ic: string; c: string; bg: string }> = {
  Docs: { ic: "doc", c: "#3a7de0", bg: "#e2ecfc" },
  Slides: { ic: "slides", c: "#e0703a", bg: "#fbe7dc" },
  Sheets: { ic: "sheet", c: "#2e9a50", bg: "#dff2e2" },
  Design: { ic: "palette", c: "#7b5fe0", bg: "#e6e0ff" },
  Data: { ic: "chart", c: "#d8474b", bg: "#fbe2e2" },
  Whiteboard: { ic: "shapes", c: "#d24f92", bg: "#f9e2ef" },
  Other: { ic: "app", c: "#6b6b6b", bg: "#efefef" },
  Folder: { ic: "folder", c: "#6b6b6b", bg: "#efefef" },
};
const kindOf = (k: string) => KIND[k] ?? KIND.Other!;

const CHAT_TITLES = [
  "Home renovation",
  "Lisbon in four days",
  "Jazz piano voicings",
  "Quarterly planning notes",
  "Reading list for winter",
  "Fix a flaky CI test",
  "Cover letter for a design role",
  "Split a dinner bill fairly",
  "Explain eigenvalues simply",
  "Choose a used road bike",
  "Repot a fiddle leaf fig",
  "Sourdough hydration ratios",
  "Name ideas for a bakery",
  "Regex for ISO dates",
  "Translate a lease clause",
  "Kids' science fair ideas",
  "Compare two job offers",
  "Draft a toast for my sister",
  "Why is my bread dense",
  "Plan a 10k training block",
  "Summarize a research paper",
  "Rewrite an onboarding email",
  "SQL window functions",
  "Gift ideas under $50",
  "Explain CRDTs",
  "Debug a React re-render",
  "A haiku about rain",
  "Interview questions for a PM",
  "Packing list for Iceland",
  "Tune a guitar by ear",
  "Budget a kitchen remodel",
  "Fix a leaky faucet",
  "Learn the Greek alphabet",
  "Make a chore chart",
  "Refactor a Python script",
  "Product release notes",
  "Train routes across Japan",
  "Book club questions",
  "Draft a complaint letter",
  "Explain compound interest",
  "Plan a surprise party",
  "Houseplants for low light",
  "Convert a recipe to grams",
  "Choose a mechanical keyboard",
  "Outline a conference talk",
  "Clean up a CSV export",
  "Basic Portuguese phrases",
  "Prepare for a salary talk",
  "Compare note-taking apps",
  "A bedtime story about owls",
  "Logo brief for a café",
  "Plan a vegetable garden",
  "Fix a Git merge conflict",
  "Shorten a LinkedIn summary",
  "Calories in a lentil stew",
  "Meeting agenda template",
  "The Monty Hall problem",
  "Workout playlist",
  "Paint colours for a hallway",
  "Unit tests for a parser",
  "Road trip in Scotland",
  "Email to my landlord",
  "Understand a tax form",
  "Team offsite ideas",
  "Chess openings for beginners",
  "Proofread a short story",
  "Set up a home network",
  "Alt text for photos",
  "Estimate a project timeline",
  "Translate an Italian menu",
  "Pitch deck feedback",
  "Bayes' theorem by example",
  "Organize a small closet",
  "Wedding speech draft",
  "Pick a portrait lens",
  "Build a reading habit",
  "Compare health plans",
  "A limerick about cats",
  "Debug a CSS grid",
  "Birthday dinner menu",
  "Cold brew at home",
  "Résumé summary",
  "Beat jet lag",
  "Ideas for rainy days",
  "Speed up an old laptop",
  "Write a SQL migration",
  "Choose a stroller",
  "Summarize a podcast episode",
  "How tides work",
  "Plan a bike commute",
  "Thank-you note to a mentor",
  "Explain inflation",
  "Pick running shoes",
  "Cron expression for Mondays",
  "Compare e-readers",
  "Monthly newsletter draft",
  "Picnic checklist",
  "Sign language basics",
  "Explain black holes",
  "Puppy training basics",
  "Job post for a designer",
  "Find a coworking space",
  "Plan a garage sale",
  "Measure for curtains",
  "Season a cast iron pan",
  "TCP handshake explained",
];

/* a chat: pinned or not, its state (the sidebar's default grouping), unread, whose it is, archived or not,
   the model it ran on, and (for a few) the project it sits in, as a sub-item */
export const STATES = ["Working", "Completed", "Idle"];
export const MODELS = ["Opus 5.5", "Sonnet 5.5", "Haiku 4.5"];
export interface Chat {
  id: string;
  title: string;
  kind: string;
  pinned: boolean;
  state: string;
  unread: boolean;
  owner: string;
  archived: boolean;
  model: string;
  project: string | null;
  hours: number;
  created: number;
  parent?: string;
  deleted?: boolean;
}
/* two pinned projects and the chats inside them */
const SUBS: Record<string, string[]> = {
  "Home renovation": [
    "Budget a kitchen remodel",
    "Paint colours for a hallway",
    "Fix a leaky faucet",
    "Measure for curtains",
  ],
  "Quarterly planning notes": [
    "Outline a conference talk",
    "Meeting agenda template",
    "Estimate a project timeline",
  ],
};
const WORKING = new Set([5, 11, 17, 31]);
export function makeChats(): Chat[] {
  const cs = CHAT_TITLES.map((title, i): Chat => {
    const pinned = i < 5;
    const hours = pinned
      ? [2, 30, 75, 190, 420][i]!
      : i < 10
        ? [5, 26, 52, 96, 150][i - 5]!
        : +(1.4 + (i - 10) * 6.3 + ((i * 13) % 5)).toFixed(1);
    return {
      id: "c" + i,
      title,
      kind: title in SUBS ? "project" : "chat",
      pinned,
      state: WORKING.has(i)
        ? "Working"
        : (i >= 5 && i < 10) || i % 9 === 0
          ? "Completed"
          : "Idle",
      unread: i % 7 === 2 || i === 6,
      owner: i % 8 === 5 ? "Others" : "You",
      archived: !pinned && i % 13 === 6,
      model: MODELS[i % 5 === 0 || i % 7 === 3 ? 0 : i % 3 === 1 ? 2 : 1]!,
      project: (i * 3) % 7 < 5 ? PROJECTS[(i * 3) % 7]! : null,
      hours,
      created: hours + 3 + ((i * 29) % 260),
    };
  });
  for (const [p, kids] of Object.entries(SUBS)) {
    const pr = cs.find((c) => c.title === p)!;
    kids.forEach((t) => {
      const c = cs.find((x) => x.title === t)!;
      c.parent = pr.id;
      c.archived = false;
    });
  }
  return cs;
}
/* the sidebar's recents menu, as on claude.ai (Filter and group recents) */
export const RECENT_DEFAULTS = {
  status: "Active",
  act: "All",
  owner: "Yours",
  group: "State",
  sort: "Last activity",
};
export type RecentSettings = typeof RECENT_DEFAULTS;
export const ACT: Record<string, number> = {
  "1d": 24,
  "3d": 72,
  "7d": 168,
  "30d": 720,
  All: Infinity,
};
const ART_LIST = [
  ["Lisbon itinerary", "Docs"],
  ["Q4 planning deck", "Slides"],
  ["Habit tracker", "Data"],
  ["Pricing page concept", "Design"],
  ["Garden layout", "Whiteboard"],
  ["Monthly budget", "Sheets"],
  ["Chord chart viewer", "Design"],
  ["Onboarding checklist", "Docs"],
  ["Team offsite agenda", "Docs"],
  ["Metronome", "Other"],
  ["Sales by region", "Data"],
  ["Product roadmap", "Slides"],
  ["Recipe scaler", "Other"],
  ["Reading tracker", "Sheets"],
  ["Interview rubric", "Docs"],
  ["Spring moodboard", "Whiteboard"],
  ["Weekly meal plan", "Sheets"],
  ["Pitch deck v2", "Slides"],
  ["Bike route planner", "Design"],
  ["Sleep log", "Data"],
  ["Brand colour palette", "Design"],
  ["Retro board", "Whiteboard"],
  ["Wedding seating plan", "Whiteboard"],
  ["Launch announcement", "Docs"],
  ["Invoice template", "Sheets"],
  ["Workout timer", "Other"],
  ["Conference talk", "Slides"],
  ["Expense splitter", "Other"],
  ["Plant watering schedule", "Sheets"],
  ["Landing page hero", "Design"],
  ["Survey results", "Data"],
  ["Release notes", "Docs"],
  ["Kanban starter", "Whiteboard"],
  ["Portuguese flashcards", "Other"],
  ["Packing list", "Docs"],
  ["Customer journey map", "Whiteboard"],
  ["Quarterly report", "Slides"],
  ["Running pace chart", "Data"],
  ["Family recipe book", "Docs"],
  ["Pomodoro timer", "Other"],
  ["Design tokens", "Design"],
  ["Home inventory", "Sheets"],
  ["Book club slides", "Slides"],
  ["Commute times", "Data"],
  ["Floor plan sketch", "Whiteboard"],
  ["Style guide", "Docs"],
  ["Contrast checker", "Other"],
  ["Fundraising one-pager", "Docs"],
  ["Event budget", "Sheets"],
  ["App onboarding flow", "Design"],
  ["Energy usage", "Data"],
  ["Workshop slides", "Slides"],
  ["Grocery list", "Docs"],
  ["Typing test", "Other"],
  ["Novel mind map", "Whiteboard"],
  ["Hiring pipeline", "Sheets"],
  ["Website redesign", "Design"],
  ["Weather dashboard", "Data"],
  ["Course syllabus", "Docs"],
  ["Trip photo story", "Slides"],
] as const;
export interface Art {
  id: string;
  title: string;
  kind: string;
  hours: number;
  edited: number;
  created: number;
  owner: string;
  sharing: string;
  pinned: boolean;
  project: string | null;
  deleted?: boolean;
}
export function makeArts(): Art[] {
  return ART_LIST.map(([title, kind], i): Art => {
    const hours = 4 + i * 57 + ((i * 37) % 41);
    const owner = i % 6 === 4 ? "Other people" : "You";
    const sharing =
      owner === "Other people"
        ? "Organization"
        : i % 5 === 1
          ? "Organization"
          : i % 11 === 3
            ? "Public"
            : "Private";
    return {
      id: "a" + i,
      title,
      kind,
      hours,
      edited: hours + ((i * 17) % 3) * 31 + (i % 4) * 9,
      created: hours + 40 + ((i * 53) % 400),
      owner,
      sharing,
      pinned: i === 2 || i === 9,
      project: (i * 2) % 7 < 5 ? PROJECTS[(i * 2) % 7]! : null,
    };
  });
}

/* artifact thumbnail: a tiny, kind-specific page on the kind's tint */
function mini(a: Art) {
  const K = kindOf(a.kind),
    n = hash(a.id);
  let inner;
  switch (a.kind) {
    case "Docs":
      inner =
        '<div class="pgx"><i class="ln h"></i><i class="ln"></i><i class="ln"></i><i class="ln s"></i><i class="ln"></i><i class="ln m"></i><i class="ln"></i><i class="ln s"></i></div>';
      break;
    case "Slides":
      inner = `<div class="pgx sl"><i class="ln h" style="background:${K.c}"></i><i class="ln s"></i><i class="ln" style="width:40%"></i></div>`;
      break;
    case "Sheets":
      inner = `<div class="pgx sh"><i style="background:${K.bg}"></i></div>`;
      break;
    case "Data":
      inner = `<div class="pgx"><i class="ln h" style="width:40%"></i><div class="bars">${[0, 1, 2, 3, 4, 5].map((i) => `<s style="height:${28 + ((n >> (i * 3)) & 7) * 10}%;background:${K.c}"></s>`).join("")}</div></div>`;
      break;
    case "Design":
      inner = `<div class="pgx"><div class="nb"></div><i class="ln h" style="margin-top:.4em"></i><i class="ln s"></i><div class="btns"><b style="background:${K.c}"></b><b></b></div><div class="cds"><b></b><b></b><b></b></div></div>`;
      break;
    case "Whiteboard": {
      const C = ["#fde68a", "#fbcfe8", "#bfdbfe", "#bbf7d0"];
      inner = `<div class="pgx wb">${[0, 1, 2, 3].map((i) => `<b style="left:${10 + i * 21 + ((n >> i) & 3) * 2}%;top:${16 + ((n >> (i * 2)) & 3) * 14}%;background:${C[(i + n) % 4]};transform:rotate(${((n >> (i * 4)) & 7) - 3}deg)"></b>`).join("")}</div>`;
      break;
    }
    case "Folder":
      return `<div class="th" style="background:${K.bg}"><div class="fold">${ic("folder", 44)}</div></div>`;
    default:
      inner = `<div class="pgx ot"><div class="ring" style="border-color:${K.c};border-right-color:rgba(0,0,0,.08)"></div><b class="pill"></b></div>`;
  }
  return `<div class="th" style="background:${K.bg}">${inner}</div>`;
}
const shareIc = (a: Art) =>
  a.sharing === "Public"
    ? `<span class="shi" title="Public">${ic("globe", 15)}</span>`
    : a.sharing === "Organization"
      ? `<span class="shi" title="Shared with your organization">${ic("building", 15)}</span>`
      : "";
export const kindTile = (a: { kind: string }, s = 16) => {
  const K = kindOf(a.kind);
  return `<span class="ki" style="background:${K.bg};color:${K.c}">${ic(K.ic, s)}</span>`;
};

/* ============================== row renderers (one look per surface, shared by before and after) ============================== */
/** how one item is drawn: its FLIP key, its nesting, whether it just arrived, and which time it shows */
export interface ItemOpts {
  k: string;
  depth?: number;
  kids?: number;
  fresh?: boolean;
  time?: string;
}
/* rows are not links: the figure is about the list, so an item never answers a click.
   ONE conversation row for both apps (Claude's sidebar and equin's data view): a flat row with the title, nothing
   else, so the two figures differ only in what the list can do. */
export function cvRow(r: { id: string; title: string }, o: ItemOpts) {
  return `<div class="cv${o.fresh ? " fresh" : ""}" data-k="${o.k}" data-id="${r.id}"><span class="t">${esc(r.title)}</span></div>`;
}
export function chatCard(r: Chat, o: ItemOpts) {
  return `<div class="ccard" data-k="${o.k}" data-id="${r.id}"><div class="cbtn"><span class="cct">${esc(r.title)}</span><span class="cm">${esc(r.model)} · ${shortAgo(r.hours)}</span></div></div>`;
}
const artTime = (a: Art, o: ItemOpts) =>
  o.time === "edited" ? a.edited : o.time === "created" ? a.created : a.hours;
export function artCard(a: Art, o: ItemOpts) {
  const h = artTime(a, o);
  return `<div class="card" data-k="${o.k}" data-id="${a.id}"><div class="cbtn">${mini(a)}<div class="cf"><div class="cmeta"><div class="ct">${esc(a.title)}</div><div class="cm">${shortAgo(h)}</div></div>${shareIc(a)}</div></div></div>`;
}
export function artRow(a: Art, o: ItemOpts) {
  const h = artTime(a, o);
  return `<div class="arow" data-k="${o.k}" data-id="${a.id}"><div class="arb">${kindTile(a)}<span class="t">${esc(a.title)}</span><span class="am">${o.time === "edited" ? "Edited" : "Opened"} ${shortAgo(h)}${shareIc(a)}</span></div></div>`;
}

/* ---------- the Notion-like example: a reading list, on the same data view ---------- */
export const SHELVES = ["Reading", "To read", "Finished"];
export const GENRES: Record<string, { c: string; bg: string }> = {
  Novel: { c: "#4f6fae", bg: "#e3e9f6" },
  Essays: { c: "#b0603c", bg: "#f8e6dc" },
  Science: { c: "#3d8a63", bg: "#e0f1e7" },
  History: { c: "#8a6a2e", bg: "#f3ecda" },
  Poetry: { c: "#8a4f9e", bg: "#efe4f4" },
};
export const RATINGS = ["★★★★★", "★★★★", "★★★", "★★", "Unrated"];
/* every title and author is invented */
const BOOK_LIST = [
  ["The Glass Orchard", "Mira Castell", "Novel"],
  ["Small Hours", "Tobias Wren", "Essays"],
  ["How Rivers Remember", "Anaïs Kerr", "Science"],
  ["A Winter in Ostend", "Paul Hendry", "History"],
  ["Salt and Lanterns", "Ines Varga", "Poetry"],
  ["The Cartographer's Daughter", "Lena Moss", "Novel"],
  ["Notes on Patience", "Samuel Ortiz", "Essays"],
  ["The Quiet Machine", "Dara Okafor", "Science"],
  ["Empire of Tea", "Hugo Lindqvist", "History"],
  ["Paper Boats", "June Halloran", "Poetry"],
  ["North of Everything", "Ravi Anand", "Novel"],
  ["The Long Noon", "Clara Benz", "Novel"],
  ["Field Notes from a Kitchen", "Oona Price", "Essays"],
  ["Seeds of the Sky", "Malik Haddad", "Science"],
  ["The Bridge Builders", "Ada Fischer", "History"],
  ["Weather for Beginners", "Theo Marsh", "Poetry"],
] as const;
export interface Book {
  id: string;
  title: string;
  author: string;
  genre: string;
  shelf: string;
  rating: string;
  hours: number;
}
export function makeBooks(): Book[] {
  return BOOK_LIST.map(([title, author, genre], i): Book => {
    const shelf = SHELVES[i % 5 === 0 ? 0 : i % 3 === 0 ? 1 : 2]!;
    return {
      id: "b" + i,
      title,
      author,
      genre,
      shelf,
      rating: shelf === "Finished" ? RATINGS[(i * 7) % 4]! : "Unrated",
      hours: 6 + i * 41 + ((i * 29) % 37),
    };
  });
}
export const bookTile = (b: Book) => {
  const G = GENRES[b.genre]!;
  return `<span class="ki" style="background:${G.bg};color:${G.c}">${ic("doc", 16)}</span>`;
};
export function bookRow(b: Book, o: ItemOpts) {
  return `<div class="arow${o.fresh ? " fresh" : ""}" data-k="${o.k}" data-id="${b.id}"><div class="arb">${bookTile(b)}<span class="t">${esc(b.title)}</span><span class="am">${esc(b.author)}</span></div></div>`;
}
export function bookCard(b: Book, o: ItemOpts) {
  const G = GENRES[b.genre]!;
  return (
    `<div class="card" data-k="${o.k}" data-id="${b.id}"><div class="cbtn"><div class="th" style="background:${G.bg}"><div class="bk" style="background:${G.c}">${esc(b.title)}</div></div>` +
    `<div class="cf"><div class="cmeta"><div class="ct">${esc(b.title)}</div><div class="cm">${esc(b.author)}</div></div></div></div></div>`
  );
}

/* features, one per line, aligned line for line across the two lists and across both figures.
   [key, [status, sidebar today], [status, Artifacts page today], both lists after]; status: ok | part | miss */
export type FeatStatus = "ok" | "part" | "miss" | "nu";
export const FEATS: readonly (readonly [
  string,
  readonly [FeatStatus, string],
  readonly [FeatStatus, string],
  string,
])[] = [
  [
    "search",
    ["miss", "No search in the list, only the ⌘K dialog"],
    ["ok", "Search field"],
    "Search field on every list",
  ],
  [
    "views",
    ["miss", "No views: Pinned, your sections, then recents"],
    ["part", "3 fixed tabs: All, Yours, Shared with you"],
    "Views: switch, or add your own",
  ],
  [
    "filter",
    ["part", "Filter by status, last activity, owner"],
    ["part", "Filter by owner, type, date opened, sharing, pinned"],
    "Filter by any field",
  ],
  [
    "sort",
    ["part", "Sort by name, date created or last activity, one direction"],
    ["part", "Sort by last opened or last edited, one direction"],
    "Sort by any field, both directions",
  ],
  [
    "group",
    ["part", "Group by date, unread or state"],
    ["miss", "No grouping"],
    "Group by any field, collapsible",
  ],
  [
    "layout",
    ["miss", "List only"],
    ["part", "Grid or list"],
    "List, grid or table",
  ],
  [
    "scroll",
    ["part", "Stops at 20, then View all opens a third list"],
    ["miss", "Loads everything at once"],
    "Loads more as you scroll",
  ],
];
export const FEAT_TITLE: Record<FeatStatus, string> = {
  ok: "Present",
  part: "Partial",
  miss: "Missing",
  nu: "",
};
