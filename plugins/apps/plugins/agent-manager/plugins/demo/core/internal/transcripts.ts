import { DEMO_PAGE_IDS } from "./pages";
import { promptOf, type Story } from "./stories";

// The demo's transcripts, written the way Claude Code writes a session: one
// JSON record per line, each turn chained to the one before by `parentUuid`.
// The browser host stores them as text and the real transcript parser reads
// them, so the demo shows exactly what a real session log would.

/** One step of a story's session. */
type Turn =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; final?: boolean }
  | { kind: "tool"; name: string; input: unknown; result: string };

/** One page-tool call the dark-mode agent made, as the MCP server saw it. */
export interface PageToolCall {
  /** The tool input, snake_case as the tools take it. */
  input: Record<string, unknown>;
  /** The tool's text result: a read's markdown, a write's JSON report. */
  result: string;
}

/**
 * The dark-mode agent's page work as the seed RAN it (`bin/seed.ts`) through
 * the real markdown engine — the reads' markdown, the writes' inputs and
 * reports — so the transcript records a real run and its ids and counts
 * cannot drift from the pages it left.
 */
export interface PageSession {
  /** `read_page` of the Bugs page (the prompt's page). */
  readOrigin: PageToolCall;
  /** `read_page` of the spec the Bugs page links. */
  readSpec: PageToolCall;
  /** `edit_page` on Bugs: the cause card and the investigation page. */
  edit: PageToolCall;
  /** `write_agent_note` on the card, once the fix passed. */
  note: PageToolCall;
  /** The card and the investigation page the edit minted. */
  cardId: string;
  investigationId: string;
}

/** The page tools as Claude Code names an MCP tool: `mcp__<server>__<tool>`. */
const PAGE_TOOL_PREFIX = "mcp__equin__";

/**
 * A story's session as Claude Code JSONL, its clock ending `story.updatedAgo`
 * before `now`. `session` is the dark-mode agent's page work; the other
 * stories touch no page.
 */
export function transcriptJsonl(
  story: Story,
  now: number,
  session: PageSession,
): string {
  const turns =
    story.key === DARK_MODE_KEY
      ? darkModeTurns(story, session)
      : briefTurns(story);
  // Spread the turns evenly from the start of the session to its last update.
  const start = now - story.startedAgo;
  const step =
    (story.startedAgo - story.updatedAgo) / Math.max(1, turns.length);
  const lines: unknown[] = [];
  let parent: string | null = null;
  const record = (at: number, type: string, message: unknown) => {
    const uuid = `demo-${story.key}-${lines.length + 1}`;
    lines.push({
      type,
      uuid,
      parentUuid: parent,
      timestamp: new Date(at).toISOString(),
      message,
    });
    parent = uuid;
  };
  turns.forEach((turn, i) => {
    const at = start + i * step;
    const msgId = `msg_demo_${story.key}_${i + 1}`;
    switch (turn.kind) {
      case "user":
        record(at, "user", { role: "user", content: turn.text });
        return;
      case "assistant":
        record(at, "assistant", {
          id: msgId,
          role: "assistant",
          content: [{ type: "text", text: turn.text }],
          ...(turn.final ? { stop_reason: "end_turn" } : {}),
        });
        return;
      case "tool": {
        const toolUseId = `toolu_demo_${story.key}_${i + 1}`;
        record(at, "assistant", {
          id: msgId,
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: toolUseId,
              name: turn.name,
              input: turn.input,
            },
          ],
        });
        record(at + step / 3, "user", {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: turn.result,
            },
          ],
        });
        return;
      }
    }
  });
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/** Every other story: its prompt and the agent's first answer. */
function briefTurns(story: Story): Turn[] {
  return [
    { kind: "user", text: promptOf(story) },
    {
      kind: "assistant",
      text:
        story.status === "done"
          ? `Done: ${story.title.toLowerCase()}.`
          : `On it: I'll ${story.title.toLowerCase()}.`,
      final: story.status !== "working",
    },
  ];
}

const DARK_MODE_KEY = "dark-mode";

const pageTool = (name: string, call: PageToolCall): Turn => ({
  kind: "tool",
  name: `${PAGE_TOOL_PREFIX}${name}`,
  input: call.input,
  result: call.result,
});

/**
 * The open conversation: read the page it was launched from and the spec,
 * find the cause and note it on the page, fix, test, report. Its prose names
 * the pages by bare id, which the transcript renders as page chips.
 */
const darkModeTurns = (story: Story, session: PageSession): Turn[] => [
  { kind: "user", text: promptOf(story) },
  {
    kind: "assistant",
    text: `This came from the prompt on the Bugs page (${DEMO_PAGE_IDS.bugs}). I'll read it first.`,
  },
  pageTool("read_page", session.readOrigin),
  {
    kind: "assistant",
    text: `The page points at the theme spec (${DEMO_PAGE_IDS.spec}) for the expected behaviour.`,
  },
  pageTool("read_page", session.readSpec),
  {
    kind: "assistant",
    text: "The spec says the chosen theme survives a reload, stored in localStorage under a `lumen:` key. Now to find where the theme is stored and read back.",
  },
  {
    kind: "tool",
    name: "Grep",
    input: { pattern: "theme", path: "src" },
    result:
      "src/settings/theme.ts\nsrc/settings/use-theme.ts\nsrc/app/root.tsx",
  },
  {
    kind: "tool",
    name: "Read",
    input: { file_path: "src/settings/use-theme.ts" },
    result: [
      "export function useTheme() {",
      '  const [theme, setTheme] = useState<Theme>("light");',
      "  useEffect(() => {",
      "    document.documentElement.dataset.theme = theme;",
      "  }, [theme]);",
      "  return [theme, setTheme] as const;",
      "}",
    ].join("\n"),
  },
  {
    kind: "assistant",
    text: 'Found it: `useTheme` keeps the choice in component state only, so every reload starts again from `"light"`. Nothing ever writes it to storage. I\'ll note the cause on the Bugs page next to the prompt, then persist the theme and read it back on start.',
  },
  pageTool("edit_page", session.edit),
  {
    kind: "tool",
    name: "Edit",
    input: {
      file_path: "src/settings/use-theme.ts",
      old_string: '  const [theme, setTheme] = useState<Theme>("light");',
      new_string:
        "  const [theme, setTheme] = useState<Theme>(readStoredTheme);\n  useEffect(() => storeTheme(theme), [theme]);",
    },
    result: "The file src/settings/use-theme.ts has been updated.",
  },
  {
    kind: "tool",
    name: "Write",
    input: {
      file_path: "src/settings/theme-storage.ts",
      content:
        'const KEY = "lumen:theme";\n\nexport function readStoredTheme(): Theme {\n  const stored = localStorage.getItem(KEY);\n  return stored === "dark" ? "dark" : "light";\n}\n\nexport function storeTheme(theme: Theme): void {\n  localStorage.setItem(KEY, theme);\n}\n',
    },
    result: "File created successfully at: src/settings/theme-storage.ts",
  },
  {
    kind: "assistant",
    text: "Now a test that reloads with dark mode chosen, so this cannot regress.",
  },
  {
    kind: "tool",
    name: "Write",
    input: {
      file_path: "src/settings/use-theme.test.tsx",
      content:
        'it("keeps dark mode after a reload", () => {\n  const first = renderHook(() => useTheme());\n  act(() => first.result.current[1]("dark"));\n  first.unmount();\n  const second = renderHook(() => useTheme());\n  expect(second.result.current[0]).toBe("dark");\n});\n',
    },
    result: "File created successfully at: src/settings/use-theme.test.tsx",
  },
  {
    kind: "tool",
    name: "Bash",
    input: {
      command: "npm test -- settings",
      description: "Run the settings tests",
    },
    result:
      " ✓ src/settings/use-theme.test.tsx (3 tests) 41ms\n ✓ src/settings/theme.test.ts (5 tests) 12ms\n\n Test Files  2 passed (2)\n      Tests  8 passed (8)",
  },
  pageTool("write_agent_note", session.note),
  {
    kind: "assistant",
    text: [
      "Fixed. Dark mode now survives a reload.",
      "",
      '**Cause.** `useTheme` held the choice in React state only, so each page load started from the `"light"` default.',
      "",
      "**Fix.**",
      "- `theme-storage.ts` reads and writes the choice under `lumen:theme` in `localStorage`.",
      "- `useTheme` starts from the stored value and saves every change.",
      "",
      "**Tests.** A new test sets dark mode, remounts the hook and checks it is still dark; all 8 settings tests pass.",
      "",
      `**On the Bugs page.** The cause and the fix are in the card next to the prompt (${session.cardId}), and the whole investigation is on its own page (${session.investigationId}).`,
      "",
      "The branch is ready for review. Want me to push it?",
    ].join("\n"),
    final: true,
  },
];
