import { CONVERSATIONS_CATEGORY_ID } from "@plugins/conversations/core";
import { WISHES_CATEGORY_ID } from "@plugins/wish/core";
import { PAGES_CATEGORY_ID } from "@plugins/page/plugins/prompt/plugins/link/core";
import { ConversationModelSchema } from "@plugins/conversations/plugins/model-provider/core";
import {
  agentIdKind,
  agentLaunchIdKind,
} from "@plugins/conversations/plugins/agents/core";
import type { ConversationPhase } from "@plugins/conversations/plugins/conversation-progress/core";
import type { TaskTrack } from "@plugins/tasks/plugins/task-track/core";
import { hashHex } from "@plugins/packages/plugins/string-hash/core";

// The Agent Manager demo's tasks: changes Demo asked of their own apps. The
// open conversation is an agent that added a practice timer to Sonata, tested
// and built it, and is waiting for Demo's review — launched from a prompt on
// the "Piano practice" page (`./pages`), where it left its plan. The queue
// holds a prototype ready for review, a design question, and a roster agent
// at work; the Done list two pushed ones.
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
    key: "weekly-review",
    n: 1,
    name: "Weekly review",
    prompt:
      "Every Monday, sum up what my agents shipped last week on my Journal page.",
  },
  {
    key: "small-wishes",
    n: 2,
    name: "Small wishes",
    prompt:
      "Once a day, pick one of my wishes that takes under an hour, and do it.",
  },
];

/**
 * The practice-timer story's prompt: ONE constant for the prompt block it was
 * launched from (`./pages`), the task's description and the session's first
 * user turn, so the three cannot disagree.
 */
const PRACTICE_TIMER_PROMPT =
  "Add a practice timer to Sonata: count how long I actually play each song, and show this week's total in my library.";

/** One agent per task: conversation `conv-demo-<key>`, attempt `att-demo-<key>`, task `task-demo-<key>`. */
export const STORIES: readonly Story[] = [
  {
    key: "practice-timer",
    shortTitle: "Practice timer",
    phase: "implementation",
    note: "Check it only counts while I'm playing, not while a song is just open.",
    // Launched from the Piano practice page's prompt block (`./pages`), so filed
    // where a prompt-launched task is.
    category: PAGES_CATEGORY_ID,
    task: "Practice timer in Sonata",
    prompt: PRACTICE_TIMER_PROMPT,
    title: "Count practice time per song in Sonata",
    status: "waiting",
    model: OPUS,
    startedAgo: 38 * MIN,
    updatedAgo: 2 * MIN,
  },
  {
    key: "recipes",
    shortTitle: "Recipe box",
    phase: "design",
    category: WISHES_CATEGORY_ID,
    task: "A recipes app for my family",
    prompt:
      "I want a small app for our family recipes: a card per recipe, with photos, and a shopping list made from the ones we pick for the week.",
    title: "Prototype a recipe box app",
    status: "waiting",
    model: OPUS,
    startedAgo: 70 * MIN,
    updatedAgo: 6 * MIN,
  },
  {
    key: "weekly-review",
    shortTitle: "Weekly review",
    track: "sidequest",
    phase: "research",
    agent: "weekly-review",
    task: "Weekly review: what shipped last week",
    prompt: "Sum up what my agents shipped last week, on my Journal page.",
    title: "Sum up last week's pushes on the Journal page",
    status: "working",
    model: SONNET,
    startedAgo: 12 * MIN,
    updatedAgo: 1 * MIN,
  },
  {
    key: "calendar",
    shortTitle: "Task calendar",
    phase: "design",
    category: CONVERSATIONS_CATEGORY_ID,
    task: "Calendar: my tasks on a month view",
    prompt: "Show my tasks on a month calendar, so I can see what's coming up.",
    title: "Design a month view for tasks",
    status: "waiting",
    model: OPUS,
    startedAgo: 2 * HOUR,
    updatedAgo: 40 * MIN,
  },
  {
    key: "pin-songs",
    shortTitle: "Pinned songs",
    phase: "pushed",
    agent: "small-wishes",
    task: "Pin my favourite songs at the top of Sonata's library",
    title: "Add a pin to Sonata's song cards",
    status: "done",
    model: SONNET,
    startedAgo: 5 * HOUR,
    updatedAgo: 4.8 * HOUR,
    endedAgo: 4.8 * HOUR,
  },
  {
    key: "wish-shortcut",
    shortTitle: "Wish shortcut",
    phase: "pushed",
    category: WISHES_CATEGORY_ID,
    task: "A keyboard shortcut to file a wish",
    title: "Open the Wish popover with a shortcut",
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
/** The story's checkout: named by its attempt id, as every worktree is. */
/**
 * The commit a pushed story's work landed as: hex, stable per story, so the
 * push ledger (`bin/seed.ts`) and the transcripts' git output agree.
 */
export const pushSha = (s: Story) =>
  (hashHex(`demo-push:${s.key}`) + hashHex(`demo-push:${s.key}#2`)).slice(
    0,
    40,
  );

export const worktreePath = (s: Story) =>
  `/home/demo/equin/.claude/worktrees/${attemptId(s)}`;
