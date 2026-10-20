import type { Story } from "./stories";

// The demo's transcripts, written the way Claude Code writes a session: one
// JSON record per line, each turn chained to the one before by `parentUuid`.
// The browser host stores them as text and the real transcript parser reads
// them, so the demo shows exactly what a real session log would.

/** One step of a story's session. */
type Turn =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; final?: boolean }
  | { kind: "tool"; name: string; input: unknown; result: string };

/** A story's session as Claude Code JSONL, its clock ending `story.updatedAgo` before `now`. */
export function transcriptJsonl(story: Story, now: number): string {
  const turns = story.key === DARK_MODE_KEY ? darkModeTurns : briefTurns(story);
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
    { kind: "user", text: story.task },
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

/** The open conversation: find, fix, test, report. */
const darkModeTurns: Turn[] = [
  {
    kind: "user",
    text: "Dark mode resets to light every time I reload the app. Can you find out why and fix it?",
  },
  {
    kind: "assistant",
    text: "I'll start by finding where the theme is stored and read back.",
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
    text: 'Found it: `useTheme` keeps the choice in component state only, so every reload starts again from `"light"`. Nothing ever writes it to storage. I\'ll persist it and read it back on start.',
  },
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
      "The branch is ready for review. Want me to push it?",
    ].join("\n"),
    final: true,
  },
];
