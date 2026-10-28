import { blockIdKind } from "@plugins/page/plugins/editor/core";
import { pageLinkToken } from "@plugins/page/plugins/inline-page-link/core";
import type {
  PageFixtureNode,
  PageTreeFixture,
} from "@plugins/apps/plugins/pages/plugins/fixtures/core";
import { promptOf, storyByKey } from "./stories";

// The Lumen workspace the demo's story touches, as a pure tree: the page the
// team plans in (its roadmap naming the stories at work), the spec the
// dark-mode agent reads, and the Bugs page whose prompt block launched it.
// A Pages fixture (`apps/pages/fixtures`), written into the browser host by its
// seed (`bin/seed.ts`) through that app's writer; what the agent then wrote
// into Bugs is not here — the seed RUNS it (`DARK_MODE_PAGE_WORK`) through the
// real page tools (`page/annotations/agent-access`'s `pageTools`).

/**
 * A seeded block id: stamped and carrying `demo` (`block-1760000000-demoNN`),
 * so a leak is findable in the real server's logs and the active-data chip
 * recognises it in prose. Parsed, so a shape the kind rejects fails here.
 */
const blockId = (n: number) =>
  blockIdKind.parse(`block-1760000000-demo${String(n).padStart(2, "0")}`);

/** The seeded pages and the blocks the story names, by role. */
export const DEMO_PAGE_IDS = {
  lumen: blockId(1),
  spec: blockId(10),
  bugs: blockId(20),
  /** The Bugs page's prompt block — the dark-mode story's origin. */
  prompt: blockId(22),
  ideas: blockId(30),
} as const;

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

/** The root pages, in sidebar order. */
export const DEMO_PAGES: PageTreeFixture = [
  {
    id: DEMO_PAGE_IDS.lumen,
    type: "page",
    title: "Lumen",
    tags: [{ name: "In progress", color: "blue" }],
    starred: true,
    children: [
      {
        id: blockId(2),
        type: "text",
        text: "Lumen is a small notes app: notebooks, fast search, and it works offline.",
      },
      { id: blockId(3), type: "heading-2", text: "Roadmap" },
      todo(blockId(4), "csv-export"),
      todo(blockId(5), "offline"),
      todo(blockId(6), "search-speed", true),
      {
        id: blockId(7),
        type: "text",
        text: `How the theme and settings are kept: ${pageLinkToken(DEMO_PAGE_IDS.spec)}`,
      },
      {
        id: DEMO_PAGE_IDS.spec,
        type: "page",
        title: "Theme & storage spec",
        children: [
          {
            id: blockId(11),
            type: "text",
            text: "The theme is a user setting, light or dark, picked in Settings.",
          },
          {
            id: blockId(12),
            type: "text",
            text: "The chosen theme survives a reload.",
          },
          {
            id: blockId(13),
            type: "text",
            text: 'Settings live in localStorage, each key prefixed "lumen:".',
          },
        ],
      },
      {
        id: DEMO_PAGE_IDS.bugs,
        type: "page",
        title: "Bugs",
        tags: [{ name: "Bug", color: "red" }],
        children: [
          {
            id: blockId(21),
            type: "text",
            text: `Found while dogfooding. Expected behaviour: ${pageLinkToken(DEMO_PAGE_IDS.spec)}`,
          },
          {
            id: DEMO_PAGE_IDS.prompt,
            type: "prompt",
            text: promptOf(storyByKey("dark-mode")),
          },
          todo(blockId(23), "typo", true),
          todo(blockId(24), "flaky-picker"),
        ],
      },
    ],
  },
  {
    id: DEMO_PAGE_IDS.ideas,
    type: "page",
    title: "Ideas",
    children: [
      { id: blockId(31), type: "text", text: "Share a notebook by link." },
      {
        id: blockId(32),
        type: "text",
        text: "Import notes from Markdown files.",
      },
    ],
  },
];

/**
 * What the dark-mode agent wrote into the Bugs page, as the markdown it handed
 * the page tools: an `<agent-inline>` card beside the prompt that launched it
 * and an `<agent-page>` holding the investigation (`edit_page`), then the
 * card rewritten once the fix passed its tests (`write_agent_note`).
 */
export const DARK_MODE_PAGE_WORK = {
  /** The tagless card `edit_page` mints after the prompt line. */
  card: [
    "<agent-inline>",
    "  Cause found: useTheme keeps the theme in component state only, so every reload starts from light. Fixing it now.",
    "</agent-inline>",
  ].join("\n"),
  /** The investigation page `edit_page` mints beside the card. */
  investigationTitle: "Dark mode investigation",
  investigation: [
    '<agent-page title="Dark mode investigation">',
    "  ## Repro",
    "  Switch to dark mode, reload: the app comes back light.",
    "  ## Cause",
    '  useTheme holds the choice in React state only and starts from "light"; nothing writes it to storage.',
    "  ## Fix",
    '  theme-storage.ts reads and writes the choice under "lumen:theme", as the spec asks, and useTheme starts from the stored value.',
    "</agent-page>",
  ].join("\n"),
  /** The card's whole contents once the fix passed (`write_agent_note`). */
  cardDone:
    "Fixed: the theme is saved in localStorage and read back on start. A new test reloads with dark mode chosen; all 8 settings tests pass. Waiting for review.",
} as const;
