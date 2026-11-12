import { WISHES_CATEGORY_ID } from "@plugins/wish/core";
import { ConversationModelSchema } from "@plugins/conversations/plugins/model-provider/core";
import type { ConversationPhase } from "@plugins/conversations/plugins/conversation-progress/core";
import {
  filmAttemptId,
  filmConversationId,
  filmSessionId,
  filmTaskId,
} from "./ids";

// The film's task list, as a real user's months of asking would read: the
// conversation the film opens (an agent that found the next piece's score and
// MIDI, and wrote what it learned on the Piano page), a couple of others
// waiting on a reply, a long tail of finished runs across every app — each
// landed as a push — and a few ideas filed for later.

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

/** The conversation the film opens from the Piano page's agent note. */
export const GRIEG_RUN = run(1, {
  task: "Score and MIDI for Wedding-day at Troldhaugen",
  prompt:
    "I'd like to learn Grieg's Wedding-day at Troldhaugen next. Find me a good public-domain score and a MIDI I can open in Sonata, and note on my Piano page what I should know about the piece.",
  title: "Score and MIDI for Wedding-day at Troldhaugen",
  shortTitle: "Grieg score",
  status: "waiting",
  model: OPUS,
  phase: "implementation",
  startedAgo: 38 * MIN,
  updatedAgo: 7 * MIN,
});

/** A finished run's defaults: a Wish that landed. */
const landed = (
  n: number,
  r: {
    task: string;
    prompt: string;
    shortTitle: string;
    daysAgo: number;
    model?: typeof OPUS;
    category?: string;
  },
): FilmRun =>
  run(n, {
    task: r.task,
    prompt: r.prompt,
    title: r.task,
    shortTitle: r.shortTitle,
    category: r.category ?? WISHES_CATEGORY_ID,
    status: "done",
    model: r.model ?? SONNET,
    phase: "pushed",
    startedAgo: r.daysAgo * DAY + 2 * HOUR,
    updatedAgo: r.daysAgo * DAY + HOUR,
    landed: {
      ago: r.daysAgo * DAY + HOUR,
      sha: (n * 2654435761).toString(16).padStart(8, "0").repeat(5),
    },
  });

export const FILM_RUNS: readonly FilmRun[] = [
  GRIEG_RUN,
  run(2, {
    task: "Weekly grocery list from my recipes",
    prompt:
      "Every Sunday, turn the dinners I plan on the Weeknight dinners page into one grocery list, grouped by aisle.",
    title: "Weekly grocery list from my recipes",
    shortTitle: "Grocery list",
    category: WISHES_CATEGORY_ID,
    status: "waiting",
    model: SONNET,
    phase: "design",
    startedAgo: 3 * HOUR,
    updatedAgo: 2 * HOUR,
  }),
  run(3, {
    task: "Import my Goodreads shelf into Reading",
    prompt:
      "Import my Goodreads export into the 2026 books page — title, author, and a check for the ones I've read.",
    title: "Import my Goodreads shelf into Reading",
    shortTitle: "Goodreads import",
    category: WISHES_CATEGORY_ID,
    status: "waiting",
    model: SONNET,
    phase: "implementation",
    startedAgo: 5 * HOUR,
    updatedAgo: 4 * HOUR,
  }),
  landed(4, {
    task: "Show opening hours on place cards",
    prompt: "Show each place's opening hours on its card in Places.",
    shortTitle: "Opening hours",
    daysAgo: 1,
  }),
  landed(5, {
    task: "A darker practice view in Sonata",
    prompt:
      "Sonata's practice view is too bright in the evening. Give it a dark look that keeps the notes easy to read.",
    shortTitle: "Dark practice view",
    daysAgo: 2,
    model: OPUS,
  }),
  landed(6, {
    task: "Loop a passage in Sonata",
    prompt:
      "Let me select a few bars in Sonata and loop them, slower each time I ask.",
    shortTitle: "Loop a passage",
    daysAgo: 3,
    model: OPUS,
  }),
  landed(7, {
    task: "Running log from my watch",
    prompt:
      "Add each run from my watch's export to the 10K plan page: date, distance, pace.",
    shortTitle: "Running log",
    daysAgo: 4,
  }),
  landed(8, {
    task: "Unsubscribe from newsletters in Mail",
    prompt:
      "Find the newsletters I never open in Mail and give me one button to unsubscribe from all of them.",
    shortTitle: "Newsletter cleanup",
    daysAgo: 5,
  }),
  landed(9, {
    task: "Practice timer that writes the log",
    prompt:
      "When I practise in Sonata, add a line to my Practice log page with the date, the piece and how long I played.",
    shortTitle: "Practice timer",
    daysAgo: 6,
    model: OPUS,
  }),
  landed(10, {
    task: "Bergen trip on the map",
    prompt: "Put everything on the Bergen, July page on my Places map.",
    shortTitle: "Bergen on the map",
    daysAgo: 8,
  }),
  landed(11, {
    task: "Chord: songs I know by ear",
    prompt:
      "In Chord, mark the songs whose chords I've named right three times in a row as known.",
    shortTitle: "Known songs",
    daysAgo: 9,
  }),
  landed(12, {
    task: "Monthly budget summary",
    prompt:
      "On the first Sunday of the month, add a summary of last month's spending to the Finances page.",
    shortTitle: "Budget summary",
    daysAgo: 11,
  }),
  landed(13, {
    task: "Bigger text in Pages on the iPad",
    prompt: "Pages is hard to read on the iPad. Make the text bigger there.",
    shortTitle: "iPad text size",
    daysAgo: 13,
  }),
  landed(14, {
    task: "Rain warning before a run",
    prompt: "On run days, tell me in the morning if it will rain at 7 pm.",
    shortTitle: "Rain warning",
    daysAgo: 15,
  }),
  landed(15, {
    task: "Photos on the Lisbon page",
    prompt:
      "Add my best photos from Lisbon to the Lisbon, last May page, one per day.",
    shortTitle: "Lisbon photos",
    daysAgo: 18,
  }),
  landed(16, {
    task: "Metronome in Sonata's toolbar",
    prompt: "Put a metronome in Sonata's toolbar, with tap tempo.",
    shortTitle: "Metronome",
    daysAgo: 21,
  }),
  landed(17, {
    task: "Shared shopping list",
    prompt: "Let my family add to my TODO's shopping items from their phones.",
    shortTitle: "Shared list",
    daysAgo: 24,
    model: OPUS,
  }),
  landed(18, {
    task: "Sort Places by distance from home",
    prompt: "In Places, let me sort my places by how far they are from home.",
    shortTitle: "Sort by distance",
    daysAgo: 28,
  }),
  landed(19, {
    task: "Birthday reminders from my contacts",
    prompt: "Remind me of birthdays a week ahead, with a gift idea.",
    shortTitle: "Birthdays",
    daysAgo: 33,
  }),
  landed(20, {
    task: "Weekly notes template",
    prompt:
      "Give my Weekly notes page a template: one heading per day, decisions in bold.",
    shortTitle: "Notes template",
    daysAgo: 40,
  }),
];

/** Filed for later, never launched. */
export const FILM_BACKLOG: readonly {
  n: number;
  task: string;
  prompt: string;
}[] = [
  {
    n: 40,
    task: "Sight-reading exercises in Sonata",
    prompt:
      "Give me a new short sight-reading exercise every day in Sonata, a little harder each week.",
  },
  {
    n: 41,
    task: "Pack for the weather",
    prompt:
      "A week before a trip, check the weather there and fill my packing list.",
  },
];
