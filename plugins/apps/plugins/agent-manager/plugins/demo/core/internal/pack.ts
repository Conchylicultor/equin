import {
  definePack,
  packAll,
  packRows,
  packValue,
  packWindow,
} from "@plugins/framework/plugins/browser-server/plugins/demo/core";
import {
  attemptRows,
  attemptWorkspaces,
  conversationsActive,
  conversationsById,
  conversationsGone,
  conversationsSystem,
  pushRows,
  taskRows,
} from "@plugins/tasks/plugins/tasks-core/core";
import { queueRanks } from "@plugins/conversations/plugins/conversations-view/plugins/queue/core";
import { jsonlEvents } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/core";
import { attemptWork } from "@plugins/tasks/plugins/attempt-work/core";
import { attemptSourceUrl } from "@plugins/tasks/plugins/task-source-url/core";
import { ConversationModelSchema } from "@plugins/conversations/plugins/model-provider/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { DEMO_CONVERSATION_ID } from "./scenario";

// The Agent Manager demo's story: a small notes app ("Lumen") with a handful of
// agents at work. The open conversation is an agent that tracked down why dark
// mode resets on reload, fixed it, tested it, and is waiting for review. The
// queue holds three other agents mid-task; the Done list two finished ones.
// Every id carries `demo`, so a request that leaked to the real server is
// findable in its logs.

const MIN = 60_000;
const HOUR = 60 * MIN;

const OPUS = ConversationModelSchema.parse("opus-5-5");
const SONNET = ConversationModelSchema.parse("sonnet-5-5");

type Status = "starting" | "working" | "waiting" | "gone" | "done";

interface Story {
  key: string;
  task: string;
  title: string;
  status: Status;
  model: typeof OPUS;
  startedAgo: number;
  updatedAgo: number;
  endedAgo?: number;
}

/** One agent per task: conversation `conv-demo-<key>`, attempt `att-demo-<key>`, task `task-demo-<key>`. */
const STORIES: readonly Story[] = [
  {
    key: "dark-mode",
    task: "Dark mode resets after a reload",
    title: "Persist the theme choice across reloads",
    status: "waiting",
    model: OPUS,
    startedAgo: 38 * MIN,
    updatedAgo: 2 * MIN,
  },
  {
    key: "csv-export",
    task: "Export a notebook as CSV",
    title: "Add CSV export to the notebook menu",
    status: "working",
    model: OPUS,
    startedAgo: 25 * MIN,
    updatedAgo: 0.3 * MIN,
  },
  {
    key: "flaky-picker",
    task: "Date picker test fails on CI once a week",
    title: "Pin the clock in the date picker test",
    status: "working",
    model: SONNET,
    startedAgo: 12 * MIN,
    updatedAgo: 1 * MIN,
  },
  {
    key: "offline",
    task: "Queue edits while offline",
    title: "Design an offline edit queue",
    status: "waiting",
    model: OPUS,
    startedAgo: 2 * HOUR,
    updatedAgo: 40 * MIN,
  },
  {
    key: "typo",
    task: "Typo in the welcome email",
    title: "Fix the welcome email typo",
    status: "done",
    model: SONNET,
    startedAgo: 5 * HOUR,
    updatedAgo: 4.8 * HOUR,
    endedAgo: 4.8 * HOUR,
  },
  {
    key: "search-speed",
    task: "Search takes 2 s on large notebooks",
    title: "Index note titles for search",
    status: "done",
    model: OPUS,
    startedAgo: 26 * HOUR,
    updatedAgo: 23 * HOUR,
    endedAgo: 23 * HOUR,
  },
];

const conversationId = (s: Story) => `conv-demo-${s.key}`;
const attemptId = (s: Story) => `att-demo-${s.key}`;
const taskId = (s: Story) => `task-demo-${s.key}`;
const worktreePath = (s: Story) => `/home/demo/lumen/.worktrees/${s.key}`;

export default definePack(({ ago }) => {
  const at = (ms: number) => new Date(ago(ms));
  const ranks = Rank.nBetween(null, null, STORIES.length);

  const conversation = (s: Story) => ({
    id: conversationId(s),
    attemptId: attemptId(s),
    taskId: taskId(s),
    title: s.title,
    status: s.status,
    model: s.model,
    kind: "user" as const,
    runtime: "tmux",
    createdAt: at(s.startedAgo),
    updatedAt: at(s.updatedAgo),
    endedAt: s.endedAgo === undefined ? null : at(s.endedAgo),
    worktreePath: worktreePath(s),
    taskTitle: s.task,
    claudeSessionId: null,
    waitingFor: null,
    spawnedBy: null,
    closeRequested: false,
    hibernatedAt: null,
    lastViewedAt: at(s.updatedAgo),
    waitingMenu: null,
    active: s.status !== "done",
  });
  const live = STORIES.filter((s) => s.status !== "done");
  const done = STORIES.filter((s) => s.status === "done");

  return [
    // ── The sidebar: queue (live), done list, their tasks and ranks ──
    packAll(conversationsActive, live.map(conversation)),
    packAll(conversationsSystem, []),
    packWindow(conversationsGone, {}, done.map(conversation)),
    packRows(conversationsById, STORIES.map(conversation)),
    packRows(
      queueRanks,
      live.map((s, i) => ({
        conversationId: conversationId(s),
        rank: ranks[i]!,
        pinned: false,
      })),
    ),
    packAll(
      taskRows,
      STORIES.map((s, i) => ({
        id: taskId(s),
        title: s.task,
        status:
          s.status === "done" ? ("done" as const) : ("in_progress" as const),
        folderId: null,
        groupId: null,
        clusterId: null,
        titleAuto: false,
        author: null,
        droppedAt: null,
        heldAt: null,
        rank: ranks[i]!,
        active: s.status !== "done",
        finishedAt: s.endedAgo === undefined ? null : at(s.endedAgo),
        dependencies: [],
        createdAt: at(s.startedAgo + 5 * MIN),
        updatedAt: at(s.updatedAgo),
      })),
    ),
    packAll(
      attemptRows,
      STORIES.map((s) => ({
        id: attemptId(s),
        taskId: taskId(s),
        worktreePath: worktreePath(s),
        status:
          s.status === "done"
            ? ("completed" as const)
            : ("in_progress" as const),
        active: s.status !== "done",
        retained: s.status !== "done",
        finishedAt: s.endedAgo === undefined ? null : at(s.endedAgo),
        createdAt: at(s.startedAgo),
        updatedAt: at(s.updatedAgo),
        conversations: [
          {
            id: conversationId(s),
            title: s.title,
            status: s.status,
            kind: "user" as const,
            createdAt: at(s.startedAgo),
            spawnedBy: null,
          },
        ],
      })),
    ),
    packRows(
      attemptWorkspaces,
      STORIES.map((s) => ({
        id: attemptId(s),
        workspace: { kind: "worktree" },
      })),
    ),

    // ── The open conversation ──
    packValue(
      attemptWork,
      { attemptId: attemptId(STORIES[0]!) },
      {
        resolved: true,
        value: {
          pending: {
            kind: "measured",
            ahead: 2,
            behind: 0,
            branch: "lumen/dark-mode",
            mergeBase: null,
          },
          landedCommits: 0,
          landedPushes: 0,
          ledgerPushes: 0,
          delivered: false,
        },
      },
    ),
    packWindow(pushRows, { where: { attemptId: attemptId(STORIES[0]!) } }, []),
    packValue(
      attemptSourceUrl,
      { attemptId: attemptId(STORIES[0]!) },
      { url: null },
    ),
    packValue(jsonlEvents, { id: DEMO_CONVERSATION_ID }, transcript(ago)),
  ];
});

/** The open conversation's transcript: find, fix, test, report. */
function transcript(ago: (ms: number) => string) {
  let t = 38 * MIN;
  const next = (step = 0.6 * MIN) => ago((t -= step));
  const call = (id: string, name: string, input: unknown, content: string) => {
    const start = next();
    return {
      kind: "tool-call" as const,
      at: start,
      toolUseId: `toolu_demo_${id}`,
      name,
      input,
      result: { at: next(0.2 * MIN), content },
    };
  };
  return [
    {
      kind: "user-text" as const,
      at: next(0),
      text: "Dark mode resets to light every time I reload the app. Can you find out why and fix it?",
      uuid: "demo-user-1",
    },
    {
      kind: "assistant-text" as const,
      at: next(),
      text: "I'll start by finding where the theme is stored and read back.",
    },
    call(
      "grep",
      "Grep",
      { pattern: "theme", path: "src" },
      "src/settings/theme.ts\nsrc/settings/use-theme.ts\nsrc/app/root.tsx",
    ),
    call(
      "read",
      "Read",
      { file_path: "src/settings/use-theme.ts" },
      [
        "export function useTheme() {",
        '  const [theme, setTheme] = useState<Theme>("light");',
        "  useEffect(() => {",
        "    document.documentElement.dataset.theme = theme;",
        "  }, [theme]);",
        "  return [theme, setTheme] as const;",
        "}",
      ].join("\n"),
    ),
    {
      kind: "assistant-text" as const,
      at: next(),
      text: 'Found it: `useTheme` keeps the choice in component state only, so every reload starts again from `"light"`. Nothing ever writes it to storage. I\'ll persist it and read it back on start.',
    },
    call(
      "edit",
      "Edit",
      {
        file_path: "src/settings/use-theme.ts",
        old_string: '  const [theme, setTheme] = useState<Theme>("light");',
        new_string:
          "  const [theme, setTheme] = useState<Theme>(readStoredTheme);\n  useEffect(() => storeTheme(theme), [theme]);",
      },
      "The file src/settings/use-theme.ts has been updated.",
    ),
    call(
      "write",
      "Write",
      {
        file_path: "src/settings/theme-storage.ts",
        content:
          'const KEY = "lumen:theme";\n\nexport function readStoredTheme(): Theme {\n  const stored = localStorage.getItem(KEY);\n  return stored === "dark" ? "dark" : "light";\n}\n\nexport function storeTheme(theme: Theme): void {\n  localStorage.setItem(KEY, theme);\n}\n',
      },
      "File created successfully at: src/settings/theme-storage.ts",
    ),
    {
      kind: "assistant-text" as const,
      at: next(),
      text: "Now a test that reloads with dark mode chosen, so this cannot regress.",
    },
    call(
      "test-write",
      "Write",
      {
        file_path: "src/settings/use-theme.test.tsx",
        content:
          'it("keeps dark mode after a reload", () => {\n  const first = renderHook(() => useTheme());\n  act(() => first.result.current[1]("dark"));\n  first.unmount();\n  const second = renderHook(() => useTheme());\n  expect(second.result.current[0]).toBe("dark");\n});\n',
      },
      "File created successfully at: src/settings/use-theme.test.tsx",
    ),
    call(
      "test",
      "Bash",
      {
        command: "npm test -- settings",
        description: "Run the settings tests",
      },
      " ✓ src/settings/use-theme.test.tsx (3 tests) 41ms\n ✓ src/settings/theme.test.ts (5 tests) 12ms\n\n Test Files  2 passed (2)\n      Tests  8 passed (8)",
    ),
    {
      kind: "assistant-text" as const,
      at: next(),
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
      stopReason: "end_turn",
    },
  ];
}
