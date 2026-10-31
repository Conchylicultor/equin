import { WISHES_CATEGORY_ID } from "@plugins/wish/core";
import { ConversationModelSchema } from "@plugins/conversations/plugins/model-provider/core";
import type { ConversationPhase } from "@plugins/conversations/plugins/conversation-progress/core";
import {
  filmAttemptId,
  filmConversationId,
  filmSessionId,
  filmTaskId,
} from "./ids";

// The film's task list, as a tidy real user's would read: the conversation the
// film opens (an agent that found the recital piece's MIDI and is waiting for a
// reply), two finished agent runs that landed, and two ideas filed for later.

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

const OPUS = ConversationModelSchema.parse("opus-5-5");
const SONNET = ConversationModelSchema.parse("sonnet-5-5");

/** A task an agent ran: its attempt, conversation and session. */
export interface FilmRun {
  n: number;
  taskId: ReturnType<typeof filmTaskId>;
  attemptId: ReturnType<typeof filmAttemptId>;
  conversationId: ReturnType<typeof filmConversationId>;
  sessionId: string;
  task: string;
  /** What the user asked, word for word: the task's description and the first user turn. */
  prompt: string;
  /** The conversation's title. */
  title: string;
  shortTitle: string;
  category?: string;
  status: "waiting" | "done";
  model: typeof OPUS;
  phase: ConversationPhase;
  startedAgo: number;
  updatedAgo: number;
  /** A finished run: when it landed (its push), and the commit's subject. */
  landed?: { ago: number; sha: string };
}

const run = (
  n: number,
  r: Omit<
    FilmRun,
    "n" | "taskId" | "attemptId" | "conversationId" | "sessionId"
  >,
): FilmRun => ({
  n,
  taskId: filmTaskId(n),
  attemptId: filmAttemptId(n),
  conversationId: filmConversationId(n),
  sessionId: filmSessionId(n),
  ...r,
});

/** The conversation the film opens from the Piano page. */
export const PRACTICE_FILE = run(1, {
  task: "Practice file for the Fantaisie-Impromptu",
  prompt:
    "Find me a MIDI of my recital piece I can open in Sonata, and add practice notes for the hard passages. My repertoire is on the Piano page.",
  title: "Practice MIDI for the Fantaisie-Impromptu",
  shortTitle: "Fantaisie practice file",
  status: "waiting",
  model: OPUS,
  phase: "implementation",
  startedAgo: 42 * MIN,
  updatedAgo: 6 * MIN,
});

export const FILM_RUNS: readonly FilmRun[] = [
  PRACTICE_FILE,
  run(2, {
    task: "Show opening hours on place cards",
    prompt: "Show each place's opening hours on its card in Places.",
    title: "Opening hours on place cards",
    shortTitle: "Opening hours",
    category: WISHES_CATEGORY_ID,
    status: "done",
    model: SONNET,
    phase: "pushed",
    startedAgo: 26 * HOUR,
    updatedAgo: 25 * HOUR,
    landed: { ago: 25 * HOUR, sha: "f2a91c07d3b84e6a5c1f9e0d2b7a4c6e8f1d3b50" },
  }),
  run(3, {
    task: "A darker practice view in Sonata",
    prompt:
      "Sonata's practice view is too bright in the evening. Give it a dark look that keeps the notes easy to read.",
    title: "Dark practice view in Sonata",
    shortTitle: "Dark practice view",
    category: WISHES_CATEGORY_ID,
    status: "done",
    model: OPUS,
    phase: "pushed",
    startedAgo: 3 * DAY,
    updatedAgo: 3 * DAY - 2 * HOUR,
    landed: {
      ago: 3 * DAY - 2 * HOUR,
      sha: "8d4e2b6f0a1c3e5d7f9b0a2c4e6d8f1a3b5c7e92",
    },
  }),
];

/** Filed for later, never launched. */
export const FILM_BACKLOG: readonly {
  n: number;
  task: string;
  prompt: string;
}[] = [
  {
    n: 4,
    task: "Log practice time from Sonata sessions",
    prompt:
      "When I practise a piece in Sonata, add a line to the Practice log page with the date, the piece and how long I played.",
  },
  {
    n: 5,
    task: "Share the Lisbon map with a link",
    prompt: "Let me share the Lisbon places as a read-only map link.",
  },
];
