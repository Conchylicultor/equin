import { EmojiSchema } from "@plugins/ui/plugins/icons/plugins/emoji/core";
import { blockIdKind } from "@plugins/page/plugins/editor/core";
import { pageLinkToken } from "@plugins/page/plugins/inline-page-link/core";
import { dateToken } from "@plugins/page/plugins/inline-date/core";
import type {
  PageFixtureNode,
  PageTreeFixture,
} from "@plugins/apps/plugins/pages/plugins/fixtures/core";
import { DEMO_FEATURED_PROTOTYPE } from "./prototypes";
import { promptOf, storyByKey } from "./stories";

// Demo's workspace, as a pure tree: a welcome page (what to try in this
// demo), Piano practice (Demo's notes on the songs they are learning, the
// prompt that launched the practice-timer agent, and the spec it reads), a
// tour of every block type, a journal and an ideas page. A Pages fixture
// (`apps/pages/fixtures`), written into the browser host by its seed
// (`bin/seed.ts`) through that app's writer; what the agent then wrote into
// Piano practice is not here — the seed RUNS it (`PRACTICE_TIMER_PAGE_WORK`)
// through the real page tools (`page/annotations/agent-access`'s `pageTools`).
//
// The prose is markdown runs (the dialect `read_page` emits), so a page can
// hold any block type; the blocks another record names — a page, the prompt a
// task was launched from — carry our own ids.

/**
 * A seeded block id: stamped and carrying `demo` (`block-1760000000-demoNN`),
 * so a leak is findable in the real server's logs and the active-data chip
 * recognises it in prose. Parsed, so a shape the kind rejects fails here.
 */
const blockId = (n: number) =>
  blockIdKind.parse(`block-1760000000-demo${String(n).padStart(2, "0")}`);

/** The seeded pages and the blocks the story names, by role. */
export const DEMO_PAGE_IDS = {
  welcome: blockId(1),
  practice: blockId(10),
  /** Piano practice's prompt block — the practice-timer story's origin. */
  prompt: blockId(11),
  spec: blockId(20),
  blockTour: blockId(30),
  journal: blockId(40),
  ideas: blockId(50),
} as const;

const md = (...lines: string[]): PageFixtureNode => ({
  type: "markdown",
  markdown: lines.join("\n"),
});

const link = (pageId: string) => `<page id="${pageId}"/>`;

/** The root pages, in sidebar order. */
export const DEMO_PAGES: PageTreeFixture = [
  {
    id: DEMO_PAGE_IDS.welcome,
    type: "page",
    title: "Welcome to equin",
    icon: EmojiSchema.parse("👋"),
    cover: { type: "gradient", preset: "aurora" },
    starred: true,
    children: [
      md(
        '<callout icon="info" color="info">',
        "  This is equin running in your browser, on Demo's data. Change anything you like: **Reset demo** puts it all back.",
        "</callout>",
        "## Things to try",
        "- [ ] Open the **Agent Manager**: an agent added a practice timer to Sonata and is waiting for review. Read what it did, step by step.",
        "- [ ] In **Sonata**, play the ii–V–I warm-up the agent tested its timer on.",
        "- [ ] In **Prototypes**, open Family Recipes and switch its accent colour; the **UI/UX** ones each study one piece of UI or one behaviour, in its variants.",
        `- [ ] Here in Pages, open ${pageLinkToken(DEMO_PAGE_IDS.practice)}: the prompt that started that agent is on it, with the agent's answer beside it.`,
        "- [ ] Type `/` on an empty line below to add a block.",
        "## Demo's pages",
        `- ${pageLinkToken(DEMO_PAGE_IDS.practice)}: songs, practice log, and the timer request.`,
        `- ${pageLinkToken(DEMO_PAGE_IDS.blockTour)}: one of every block a page can hold.`,
        `- ${pageLinkToken(DEMO_PAGE_IDS.journal)} and ${pageLinkToken(DEMO_PAGE_IDS.ideas)}: everyday notes.`,
      ),
    ],
  },
  {
    id: DEMO_PAGE_IDS.practice,
    type: "page",
    title: "Piano practice",
    icon: EmojiSchema.parse("🎹"),
    tags: [{ name: "In progress", color: "blue" }],
    children: [
      md(
        `Lessons on Thursdays. Goal: Late night, start to finish, by ${dateToken("2026-12-24")}.`,
        "<instructions>",
        "  Keep plans short: a few lines on this page, the details on your own page.",
        "  Ask me before adding a new app.",
        "</instructions>",
        "## Learning now",
        "| Song | Where I am | Next |",
        "| --- | --- | --- |",
        "| ii–V–I warm-up | C, F and Bb | Eb and Ab |",
        "| Late night | Verse, hands together | Chorus voicings |",
        "| Rain on the window | Verse, slowly | The (Dm7 E7) bar |",
        "## Practice log",
        "- Mon: 20 min, warm-up in C and F.",
        "- Tue: skipped.",
        "- Wed: 35 min, Late night verse. The Fmaj7 to G still lands late.",
        "> Teacher's notes",
        "  Left hand: shells only (root and seventh) until the changes are automatic.",
        "  Count out loud in Rain on the window; the bar with two chords rushes.",
        "## Timer",
        `I never know how much I actually practise. What I want: ${pageLinkToken(DEMO_PAGE_IDS.spec)}`,
      ),
      {
        id: DEMO_PAGE_IDS.prompt,
        type: "prompt",
        text: promptOf(storyByKey("practice-timer")),
      },
      {
        id: DEMO_PAGE_IDS.spec,
        type: "page",
        title: "Practice timer spec",
        icon: EmojiSchema.parse("⏱️"),
        children: [
          md(
            "- Count time only while a song is playing, not while it is just open.",
            "- Show this week's total next to each song in the library.",
            "- A week starts on Monday.",
            "- Show nothing for a song I haven't practised this week.",
          ),
        ],
      },
    ],
  },
  {
    id: DEMO_PAGE_IDS.blockTour,
    type: "page",
    title: "Block tour",
    icon: EmojiSchema.parse("🧱"),
    children: [
      md(
        "Every block a page can hold, one of each. Type `/` on an empty line to add one.",
        "# Heading 1",
        "## Heading 2",
        "### Heading 3",
        "Text carries **bold**, *italic*, `code`, [links](https://en.wikipedia.org/wiki/Operating_system), a page mention " +
          pageLinkToken(DEMO_PAGE_IDS.welcome) +
          ` and a date ${dateToken("2026-12-24")}.`,
        "- A bulleted list",
        "  - nests with Tab",
        "1. A numbered list",
        "1. counts by itself",
        "- [x] A to-do, done",
        "- [ ] A to-do, still open",
        "> A toggle: click the arrow",
        "  What it hides shows when it opens.",
        '<callout icon="info" color="info">',
        "  A callout, to make a line stand out.",
        "</callout>",
        '<callout icon="info" color="warning">',
        "  Callouts come in colours.",
        "</callout>",
        "<quote>",
        "  A quote, for words that are someone else's.",
        "</quote>",
        "```ts",
        "export function weekStart(at: Date): Date {",
        "  const d = new Date(at);",
        "  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));",
        "  return d;",
        "}",
        "```",
        "| Block | Type it as |",
        "| --- | --- |",
        "| Heading | `#`, then a space |",
        "| To-do | `[]`, then a space |",
        "| Toggle | `>`, then a space |",
        "| Equation | `$$` |",
        "$$e^{i\\pi} + 1 = 0",
        "---",
        "A prototype from the Prototypes app, live inside the page:",
        `<prototype id="${DEMO_FEATURED_PROTOTYPE}"/>`,
        "Another page, shown inside this one:",
        link(DEMO_PAGE_IDS.journal),
      ),
    ],
  },
  {
    id: DEMO_PAGE_IDS.journal,
    type: "page",
    title: "Journal",
    icon: EmojiSchema.parse("📓"),
    children: [
      md(
        "### Wednesday",
        "- Lesson moved to Thursday. Practised the Late night verse instead: better, but the Fmaj7 to G still lands late.",
        "- Lentil soup for four. Next time, more cumin.",
        "### Monday",
        "- Booked Lisbon for March. Started saving places on the map: the tram, a bakery, the tile museum.",
        "- Twenty minutes of warm-up before work. Worth doing every day.",
        "### Last Sunday",
        "- Pancakes, then a long walk. Finally finished the book on Bach.",
      ),
    ],
  },
  {
    id: DEMO_PAGE_IDS.ideas,
    type: "page",
    title: "Ideas",
    icon: EmojiSchema.parse("💭"),
    children: [
      md(
        "Things I might do, someday.",
        "### Music",
        "- Slow a song down without changing its pitch.",
        "- Learn one standard a month, starting with Autumn Leaves.",
        "### Home",
        "- Herbs on the kitchen windowsill: basil, mint, chives.",
        "- A family recipe book: one card per recipe, a shopping list for the week.",
        "### Reading",
        "- A list that reminds me of a book a month after I add it.",
      ),
    ],
  },
];

/**
 * What the practice-timer agent wrote into Piano practice, as the markdown it
 * handed the page tools: an `<agent-inline>` card beside the prompt that
 * launched it and an `<agent-page>` holding its plan (`edit_page`), then the
 * card rewritten once the tests passed and the preview was built
 * (`write_agent_note`).
 */
export const PRACTICE_TIMER_PAGE_WORK = {
  /** The tagless card `edit_page` mints after the prompt line. */
  card: [
    "<agent-inline>",
    "  Plan: Sonata already counts plays per song. I'm adding the time played this week beside it, as a library column. Working on it.",
    "</agent-inline>",
  ].join("\n"),
  /** The plan page `edit_page` mints beside the card. */
  planTitle: "Practice timer: plan",
  /** The icon the user gave the agent's page afterwards (the seed's `decoratePlanPage`). */
  planIcon: EmojiSchema.parse("⏳"),
  plan: [
    '<agent-page title="Practice timer: plan">',
    "  ## Approach",
    "  - Sonata's `playback-history` already keeps a play count per song. Add `practiceThisWeek` beside it.",
    "  - Add to it while a song's playback runs; reset when the week changes.",
    "  - It shows as a **This week** column in the library, like the play count.",
    "  ## From the spec",
    "  - Only time spent playing counts, not a song left open.",
    "  - Weeks start on Monday.",
    "  - A song with no practice this week shows nothing.",
    "  ## Tests",
    "  - Play 90 s, pause 10 min, play 30 s: the week shows 2 min.",
    "  - Play Sunday night and Monday morning: only Monday counts this week.",
    "</agent-page>",
  ].join("\n"),
  /** The card's whole contents once the work passed (`write_agent_note`). */
  cardDone:
    "Ready for review: the library has a This week column with your practice time per song. Tests pass and the preview is built; details in the plan page.",
} as const;
