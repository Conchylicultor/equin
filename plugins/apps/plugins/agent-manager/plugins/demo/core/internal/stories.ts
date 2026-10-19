import { DEPLOY_CATEGORY_ID } from "@plugins/apps/plugins/deploy/core";
import { APPS_CATEGORY_ID } from "@plugins/apps/plugins/home/core";
import { PROTOTYPES_CATEGORY_ID } from "@plugins/apps/plugins/prototypes/core";
import { ConversationModelSchema } from "@plugins/conversations/plugins/model-provider/core";

// The Agent Manager demo's story: a small notes app ("Lumen") with a handful of
// agents at work. The open conversation is an agent that tracked down why dark
// mode resets on reload, fixed it, tested it, and is waiting for review. The
// queue holds three other agents mid-task; the Done list two finished ones.
// Every id carries `demo`, so a request that leaked to the real server is
// findable in its logs. Read by the pack (`./pack`) and by the demo's browser
// host seed (`bin/seed.ts`), so both describe the same tasks.

export const MIN = 60_000;
export const HOUR = 60 * MIN;

const OPUS = ConversationModelSchema.parse("opus-5-5");
const SONNET = ConversationModelSchema.parse("sonnet-5-5");

export type Status = "starting" | "working" | "waiting" | "gone" | "done";

export interface Story {
  key: string;
  task: string;
  title: string;
  status: Status;
  model: typeof OPUS;
  startedAgo: number;
  updatedAgo: number;
  endedAgo?: number;
  /** The task's category (`tasks/task-category`), seeded into the browser host; none when absent. */
  category?: string;
}

/** One agent per task: conversation `conv-demo-<key>`, attempt `att-demo-<key>`, task `task-demo-<key>`. */
export const STORIES: readonly Story[] = [
  {
    key: "dark-mode",
    category: APPS_CATEGORY_ID,
    task: "Dark mode resets after a reload",
    title: "Persist the theme choice across reloads",
    status: "waiting",
    model: OPUS,
    startedAgo: 38 * MIN,
    updatedAgo: 2 * MIN,
  },
  {
    key: "csv-export",
    category: APPS_CATEGORY_ID,
    task: "Export a notebook as CSV",
    title: "Add CSV export to the notebook menu",
    status: "working",
    model: OPUS,
    startedAgo: 25 * MIN,
    updatedAgo: 0.3 * MIN,
  },
  {
    key: "flaky-picker",
    category: DEPLOY_CATEGORY_ID,
    task: "Date picker test fails on CI once a week",
    title: "Pin the clock in the date picker test",
    status: "working",
    model: SONNET,
    startedAgo: 12 * MIN,
    updatedAgo: 1 * MIN,
  },
  {
    key: "offline",
    category: PROTOTYPES_CATEGORY_ID,
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
    category: APPS_CATEGORY_ID,
    task: "Search takes 2 s on large notebooks",
    title: "Index note titles for search",
    status: "done",
    model: OPUS,
    startedAgo: 26 * HOUR,
    updatedAgo: 23 * HOUR,
    endedAgo: 23 * HOUR,
  },
];

export const conversationId = (s: Story) => `conv-demo-${s.key}`;
export const attemptId = (s: Story) => `att-demo-${s.key}`;
export const taskId = (s: Story) => `task-demo-${s.key}`;
export const worktreePath = (s: Story) =>
  `/home/demo/lumen/.worktrees/${s.key}`;
