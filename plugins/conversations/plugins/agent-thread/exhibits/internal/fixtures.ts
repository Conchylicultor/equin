import { z } from "zod";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-watcher/core";
import { defineThreadResult, type ThreadConversation } from "../../core";

// A recorded-shape transcript of a place-finding agent, for the exhibits only:
// the thread is drawn from these events through the real `groupThread`, so
// every state below is what a live conversation in that state would show.

export const showPicks = defineThreadResult({
  tool: "places_show_picks",
  schema: z.object({
    picks: z.array(
      z.object({
        googlePlaceId: z.string(),
        name: z.string(),
        why: z.string(),
      }),
    ),
  }),
});

const BASE = Date.parse("2026-10-19T09:00:00Z");
let tick = 0;
const at = () => new Date(BASE + ++tick * 4000).toISOString();

let ids = 0;
function call(
  name: string,
  input: unknown,
  result?: { content: string; isError?: boolean },
): JsonlEvent {
  const when = at();
  return {
    kind: "tool-call",
    at: when,
    toolUseId: `toolu_exhibit_${++ids}`,
    name,
    input,
    ...(result ? { result: { at: when, ...result } } : {}),
  };
}

const user = (text: string): JsonlEvent => ({
  kind: "user-text",
  at: at(),
  text,
});
const say = (text: string): JsonlEvent => ({
  kind: "assistant-text",
  at: at(),
  text,
});

const harness: JsonlEvent[] = [
  { kind: "preprompt", at: at(), text: "You find places on the user's map." },
];

const firstTurn: JsonlEvent[] = [
  user("chinese restaurant open tuesday"),
  call(
    "mcp__equin__places_search_text",
    { query: "chinese restaurant", openOn: "tuesday" },
    { content: "12 places" },
  ),
  call(
    "mcp__equin__places_details",
    { ids: ["ChIJa1", "ChIJb2", "ChIJc3"] },
    { content: "3 places" },
  ),
  call(
    "mcp__equin__places_show_picks",
    {
      picks: [
        {
          googlePlaceId: "ChIJa1",
          name: "Lan Zhou Noodles",
          why: "Open Tuesdays until 11pm, hand-pulled noodles.",
        },
        {
          googlePlaceId: "ChIJb2",
          name: "Golden Dragon",
          why: "Dim sum all day, open Tuesday lunch and dinner.",
        },
      ],
    },
    { content: "Shown" },
  ),
  say(
    "Two places are open on **Tuesday**: Lan Zhou for noodles late, Golden Dragon for dim sum.",
  ),
];

const secondTurnStart: JsonlEvent[] = [
  user("cheaper"),
  call(
    "mcp__equin__places_search_text",
    { query: "cheap chinese restaurant", priceLevel: 1 },
    { content: "8 places" },
  ),
  call("WebFetch", { url: "https://www.example-reviews.test/lan-zhou" }),
];

const secondTurnDone: JsonlEvent[] = [
  user("cheaper"),
  call(
    "mcp__equin__places_search_text",
    { query: "cheap chinese restaurant", priceLevel: 1 },
    { content: "8 places" },
  ),
  call(
    "mcp__equin__places_show_picks",
    { picks: "Lan Zhou" },
    { content: "Invalid input: picks must be an array", isError: true },
  ),
  call(
    "mcp__equin__places_show_picks",
    {
      picks: [
        {
          googlePlaceId: "ChIJc3",
          name: "Wok Express",
          why: "Mains under $10, open Tuesdays.",
        },
      ],
    },
    { content: "Shown" },
  ),
  say("Wok Express is the cheapest of them, mains under $10."),
];

export interface ThreadFixture {
  events: JsonlEvent[];
  conversation: ThreadConversation;
}

export const RUNNING: ThreadFixture = {
  events: [...harness, ...firstTurn, ...secondTurnStart],
  conversation: { status: "working", waitingFor: null },
};

export const DONE: ThreadFixture = {
  events: [...harness, ...firstTurn, ...secondTurnDone],
  conversation: { status: "waiting", waitingFor: null },
};

export const FAILED: ThreadFixture = {
  events: [
    ...harness,
    user("ramen near the office"),
    call(
      "mcp__equin__places_search_text",
      { query: "ramen" },
      { content: "Google Places API key is not configured", isError: true },
    ),
    call("mcp__equin__places_details", { ids: [] }),
  ],
  conversation: { status: "gone", waitingFor: null },
};

export const QUESTION: ThreadFixture = {
  events: [
    ...harness,
    user("somewhere for a date"),
    call(
      "mcp__equin__places_search_text",
      { query: "romantic restaurant" },
      { content: "20 places" },
    ),
    call("AskUserQuestion", {
      questions: [
        {
          question: "Which night?",
          options: [{ label: "Friday" }, { label: "Saturday" }],
        },
      ],
    }),
  ],
  conversation: { status: "waiting", waitingFor: "question" },
};
