import { EmojiSchema } from "@plugins/ui/plugins/icons/plugins/emoji/core";
import { blockIdKind } from "@plugins/page/plugins/editor/core";
import { pageLinkToken } from "@plugins/page/plugins/inline-page-link/core";
import { dateToken } from "@plugins/page/plugins/inline-date/core";
import type {
  PageFixtureNode,
  PageTreeFixture,
} from "@plugins/apps/plugins/pages/plugins/fixtures/core";
import { DEMO_PINNED_PROTOTYPE } from "./prototypes";
import { promptOf, storyByKey } from "./stories";

// Demo's workspace, as a pure tree: a welcome page that explains equin in the
// editor's own blocks, "My equin" (the wishes, the prompt that launched the
// practice-timer agent, and the spec it reads), a tour of every block type, a
// journal and an ideas page. A Pages fixture (`apps/pages/fixtures`), written
// into the browser host by its seed (`bin/seed.ts`) through that app's writer;
// what the agent then wrote into My equin is not here — the seed RUNS it
// (`PRACTICE_TIMER_PAGE_WORK`) through the real page tools
// (`page/annotations/agent-access`'s `pageTools`).
//
// The prose is markdown runs (the dialect `read_page` emits), so a page can
// hold any block type; the blocks another record names — a page, the prompt a
// task was launched from, the to-dos naming the stories — carry our own ids.

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
  myEquin: blockId(10),
  /** My equin's prompt block — the practice-timer story's origin. */
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

const todo = (
  id: string,
  storyKey: string,
  checked = false,
): PageFixtureNode => ({
  id,
  type: "to-do",
  text: storyByKey(storyKey).task,
  checked,
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
        "# One app that becomes yours",
        "equin is **one app you shape yourself**: you say what you want, and agents build it into *your own* copy. This demo is a real equin running in your browser, on Demo's data.",
        '<callout icon="info" color="info">',
        "  Everything here works: edit this page, file a wish, open another app. **Reset demo** brings everything back.",
        "</callout>",
        "## What equin is",
        "- **Your apps, shaped by you.** Pages, a piano, a task manager: each one changes when you ask.",
        "- **Agents do the work.** Each wish becomes a task, and an agent takes it in its own copy of the app.",
        "- **Built from plugins.** Every feature is a plugin, so an agent adds one without breaking the rest.",
        "## How a wish becomes a feature",
        "1. Write the wish anywhere: a page, the `Wish` button, the task list.",
        "1. An agent works on it in its own copy, and shows you a preview.",
        "1. You review it, ask for changes, or ship it.",
        "1. It lands in your equin, and the next wish starts from there.",
        "> What is an agent page?",
        `  A page an agent wrote for you, beside the prompt you gave it: its plan, what it found, what it did. The practice-timer agent left one on ${pageLinkToken(DEMO_PAGE_IDS.myEquin)}. You can read it, comment in it, or give it an icon.`,
        "<quote>",
        "  An app that replaces all the others: shaped for each person, at the boundary of an application and an operating system.",
        "</quote>",
        "---",
        "Where to go next:",
        `- ${pageLinkToken(DEMO_PAGE_IDS.myEquin)}: Demo's wishes, and the agent that took one.`,
        `- ${pageLinkToken(DEMO_PAGE_IDS.blockTour)}: every block a page can hold.`,
        `- ${pageLinkToken(DEMO_PAGE_IDS.journal)}: what changed, week by week.`,
      ),
    ],
  },
  {
    id: DEMO_PAGE_IDS.myEquin,
    type: "page",
    title: "My equin",
    icon: EmojiSchema.parse("🧭"),
    tags: [{ name: "In progress", color: "blue" }],
    children: [
      md(
        "What I want my equin to do next. Each wish here is a task an agent can take.",
        "<instructions>",
        "  Keep plans short: a few lines on this page, the details on your own page.",
        "  Ask me before adding a new app.",
        "</instructions>",
        "## Wishes",
      ),
      todo(blockId(12), "recipes"),
      todo(blockId(13), "calendar"),
      todo(blockId(14), "pin-songs", true),
      todo(blockId(15), "wish-shortcut", true),
      md(
        "## Ask an agent",
        `Write what you want and press Run: an agent takes it, and answers on this page. How the timer should behave: ${pageLinkToken(DEMO_PAGE_IDS.spec)}`,
      ),
      {
        id: DEMO_PAGE_IDS.prompt,
        type: "prompt",
        text: promptOf(storyByKey("practice-timer")),
      },
      md(
        "## Apps I use",
        "| App | What for | Last shaped |",
        "| --- | --- | --- |",
        "| Agent Manager | The agents working on my wishes | A shortcut to file a wish |",
        "| Pages | Notes, plans and this page | Covers and page icons |",
        "| Sonata | Learning piano | Pinned songs |",
        "| Prototypes | Trying an app before it is built | Recipe box |",
        `More wishes, not filed yet: ${pageLinkToken(DEMO_PAGE_IDS.ideas)}`,
      ),
      {
        id: DEMO_PAGE_IDS.spec,
        type: "page",
        title: "Practice timer spec",
        icon: EmojiSchema.parse("🎹"),
        children: [
          md(
            "What I want from a practice timer in Sonata.",
            "- Count time only while I play: notes sounding, or the song's playback running.",
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
        "export default {",
        '  description: "Practice time per song, this week.",',
        "  contributions: [Library.Column.provide(practiceColumn)],",
        "} satisfies PluginDefinition;",
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
        `<prototype id="${DEMO_PINNED_PROTOTYPE}"/>`,
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
        "What changed in my equin, week by week. The Weekly review agent adds a line each Monday.",
        "### Last week",
        "- Sonata's song cards got a pin; my favourites sit at the top.",
        "- ⌘⇧W files a wish from any app.",
        "### The week before",
        "- Pages got covers. This journal has none, on purpose.",
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
        "Wishes I have not filed yet.",
        "- A reading list that reminds me of a book after a month.",
        "- Sonata: slow a song down without changing its pitch.",
        `- A photo wall for the family, next to the recipes (${pageLinkToken(DEMO_PAGE_IDS.myEquin)}).`,
      ),
    ],
  },
];

/**
 * What the practice-timer agent wrote into My equin, as the markdown it handed
 * the page tools: an `<agent-inline>` card beside the prompt that launched it
 * and an `<agent-page>` holding its plan (`edit_page`), then the card
 * rewritten once the tests passed and the preview was built
 * (`write_agent_note`).
 */
export const PRACTICE_TIMER_PAGE_WORK = {
  /** The tagless card `edit_page` mints after the prompt line. */
  card: [
    "<agent-inline>",
    "  Plan: Sonata already counts plays per song (playback-history). I'm adding the time played this week beside it, as a library column. Building it now.",
    "</agent-inline>",
  ].join("\n"),
  /** The plan page `edit_page` mints beside the card. */
  planTitle: "Practice timer: plan",
  /** The icon the user gave the agent's page afterwards (the seed's `decoratePlanPage`). */
  planIcon: EmojiSchema.parse("⏳"),
  plan: [
    '<agent-page title="Practice timer: plan">',
    "  ## What I'll build",
    "  - A `practiceThisWeek` field beside Sonata's play count, summed from the time a song's playback runs.",
    "  - A **This week** column in the library, empty for a song not practised this week.",
    "  ## As your spec asks",
    "  - It counts only while playback runs, not while a song is just open.",
    "  - Weeks start on Monday.",
    "  ## Checks",
    "  - A test plays a song for 90 s, pauses, then plays 30 s more: the week shows 2 min.",
    "</agent-page>",
  ].join("\n"),
  /** The card's whole contents once the work passed (`write_agent_note`). */
  cardDone:
    "Done: the library shows this week's practice time per song. The 6 tests pass and the preview is built. Waiting for your review.",
} as const;
