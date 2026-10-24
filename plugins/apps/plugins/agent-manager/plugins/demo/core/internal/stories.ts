import { BUILD_CATEGORY_ID } from "@plugins/build/core";
import { CONVERSATIONS_CATEGORY_ID } from "@plugins/conversations/core";
import { IMPROVEMENTS_CATEGORY_ID } from "@plugins/improve/core";
import { PAGES_CATEGORY_ID } from "@plugins/page/plugins/prompt/plugins/link/core";
import { ConversationModelSchema } from "@plugins/conversations/plugins/model-provider/core";
import {
  agentIdKind,
  agentLaunchIdKind,
} from "@plugins/conversations/plugins/agents/core";
import type { ConversationPhase } from "@plugins/conversations/plugins/conversation-progress/core";
import type { TaskTrack } from "@plugins/tasks/plugins/task-track/core";

// The Agent Manager demo's story: a small notes app ("Lumen") with a handful of
// agents at work. The open conversation is an agent that tracked down why dark
// mode resets on reload, fixed it, tested it, and is waiting for review — launched
// from a prompt on the Lumen workspace's Bugs page (`./pages`), where it left
// its findings. The queue holds three other agents mid-task; the Done list two
// finished ones.
// Every id carries `demo`, so a request that leaked to the real server is
// findable in its logs. Written into the demo's browser host by its seed
// (`bin/seed.ts`), each story's transcript by `./transcripts`.

export const MIN = 60_000;
export const HOUR = 60 * MIN;

const OPUS = ConversationModelSchema.parse("opus-5-5");
const SONNET = ConversationModelSchema.parse("sonnet-5-5");

export type Status = "starting" | "working" | "waiting" | "gone" | "done";

export interface Story {
  key: string;
  task: string;
  /**
   * What the user asked, word for word: the task's description and the
   * session's first user turn (and, for a story launched from a page, the
   * prompt block's text). {@link Story.task} when absent.
   */
  prompt?: string;
  title: string;
  status: Status;
  model: typeof OPUS;
  startedAgo: number;
  updatedAgo: number;
  endedAgo?: number;
  /** The task's category (`tasks/task-category`); none when absent. */
  category?: string;
  /** The task's short title (`tasks/task-title`), made from {@link Story.task}. */
  shortTitle: string;
  /** The task's track (`tasks/task-track`); main when absent. */
  track?: TaskTrack;
  /** How far the agent has got (`conversation-progress`); a finished story is `pushed`. */
  phase: ConversationPhase;
  /** The user's note on the conversation (`conversation-view/notes`); none when absent. */
  note?: string;
  /** The key of the agent ({@link DEMO_AGENTS}) that launched the task; filed by hand when absent. */
  agent?: string;
}

/** A named agent of the roster (`conversations/agents`), launched by its stories. */
export interface DemoAgent {
  key: string;
  /** 1-based and distinct: the agent's id is `agent-<stamp>-demo<n>`, an `agent` id kind. */
  n: number;
  name: string;
  prompt: string;
}

export const DEMO_AGENTS: readonly DemoAgent[] = [
  {
    key: "ci-triage",
    n: 1,
    name: "CI triage",
    prompt:
      "Look at this week's failed CI runs, find the flakiest test and make it deterministic.",
  },
  {
    key: "copy-check",
    n: 2,
    name: "Copy check",
    prompt:
      "Proofread the user-facing emails and fix every typo or broken sentence you find.",
  },
];

/**
 * The dark-mode story's prompt: ONE constant for the prompt block it was
 * launched from (`./pages`), the task's description and the session's first
 * user turn, so the three cannot disagree.
 */
const DARK_MODE_PROMPT =
  "Dark mode resets to light every time I reload the app. Can you find out why and fix it?";

/** One agent per task: conversation `conv-demo-<key>`, attempt `att-demo-<key>`, task `task-demo-<key>`. */
export const STORIES: readonly Story[] = [
  {
    key: "dark-mode",
    shortTitle: "Dark mode reload",
    phase: "implementation",
    note: "Repro: switch to dark, reload, it comes back light. Check that the fix survives a hard reload too.",
    // Launched from the Bugs page's prompt block (`./pages`), so filed where a
    // prompt-launched task is.
    category: PAGES_CATEGORY_ID,
    task: "Dark mode resets after a reload",
    prompt: DARK_MODE_PROMPT,
    title: "Persist the theme choice across reloads",
    status: "waiting",
    model: OPUS,
    startedAgo: 38 * MIN,
    updatedAgo: 2 * MIN,
  },
  {
    key: "csv-export",
    shortTitle: "CSV export",
    phase: "implementation",
    category: IMPROVEMENTS_CATEGORY_ID,
    task: "Export a notebook as CSV",
    title: "Add CSV export to the notebook menu",
    status: "working",
    model: OPUS,
    startedAgo: 25 * MIN,
    updatedAgo: 0.3 * MIN,
  },
  {
    key: "flaky-picker",
    shortTitle: "Flaky date picker",
    track: "sidequest",
    phase: "research",
    agent: "ci-triage",
    category: BUILD_CATEGORY_ID,
    task: "Date picker test fails on CI once a week",
    title: "Pin the clock in the date picker test",
    status: "working",
    model: SONNET,
    startedAgo: 12 * MIN,
    updatedAgo: 1 * MIN,
  },
  {
    key: "offline",
    shortTitle: "Offline edit queue",
    phase: "design",
    category: CONVERSATIONS_CATEGORY_ID,
    task: "Queue edits while offline",
    title: "Design an offline edit queue",
    status: "waiting",
    model: OPUS,
    startedAgo: 2 * HOUR,
    updatedAgo: 40 * MIN,
  },
  {
    key: "typo",
    shortTitle: "Welcome email typo",
    phase: "pushed",
    agent: "copy-check",
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
    shortTitle: "Faster search",
    phase: "pushed",
    category: IMPROVEMENTS_CATEGORY_ID,
    task: "Search takes 2 s on large notebooks",
    title: "Index note titles for search",
    status: "done",
    model: OPUS,
    startedAgo: 26 * HOUR,
    updatedAgo: 23 * HOUR,
    endedAgo: 23 * HOUR,
  },
];

/** The story under `key` — loud when no story has it. */
export function storyByKey(key: string): Story {
  const story = STORIES.find((s) => s.key === key);
  if (story === undefined)
    throw new Error(`no demo story has the key "${key}"`);
  return story;
}

/** What the user asked ({@link Story.prompt}, else the task's title). */
export const promptOf = (s: Story) => s.prompt ?? s.task;

export const conversationId = (s: Story) => `conv-demo-${s.key}`;
export const attemptId = (s: Story) => `att-demo-${s.key}`;
export const taskId = (s: Story) => `task-demo-${s.key}`;
// Parsed, so an id the kind does not recognise fails here, not in a reader.
export const agentId = (a: DemoAgent) =>
  agentIdKind.parse(`agent-1760000000-demo${a.n}`);
export const agentLaunchId = (s: Story) =>
  agentLaunchIdKind.parse(`launch-1760000000-demo${STORIES.indexOf(s) + 1}`);
export const worktreePath = (s: Story) =>
  `/home/demo/lumen/.worktrees/${s.key}`;
