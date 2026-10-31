import { pageLinkToken } from "@plugins/page/plugins/inline-page-link/core";
import type { PageTreeFixture } from "@plugins/apps/plugins/pages/plugins/fixtures/core";
import { filmBlockId } from "./ids";
import { PRACTICE_FILE } from "./tasks";

// The film's workspace: a small personal wiki. The film opens on "Piano", whose
// prose names the conversation that made the practice file — the id renders
// as a conversation chip, the shot's way into the Agent Manager. A Pages
// fixture (`apps/pages/fixtures`), written by its writer.

export const FILM_PAGE_IDS = {
  piano: filmBlockId(1),
  repertoire: filmBlockId(10),
  practiceLog: filmBlockId(20),
  lisbon: filmBlockId(30),
  ideas: filmBlockId(40),
} as const;

export const FILM_PAGES: PageTreeFixture = [
  {
    id: FILM_PAGE_IDS.piano,
    type: "page",
    title: "Piano",
    tags: [{ name: "In progress", color: "blue" }],
    starred: true,
    children: [
      {
        id: filmBlockId(2),
        type: "text",
        text: "Learning the Fantaisie-Impromptu for the spring recital: a section a week, slow first, then up to tempo.",
      },
      { id: filmBlockId(3), type: "heading-2", text: "This week" },
      {
        id: filmBlockId(4),
        type: "to-do",
        text: "Bars 1–12, hands separately",
        checked: true,
      },
      {
        id: filmBlockId(5),
        type: "to-do",
        text: "Bars 1–12, hands together at 75%",
        checked: false,
      },
      {
        id: filmBlockId(6),
        type: "to-do",
        text: "Record a run-through for Ms. Laurent",
        checked: false,
      },
      {
        id: filmBlockId(7),
        type: "text",
        text: `Practice file and fingering notes: ${PRACTICE_FILE.conversationId}`,
      },
      {
        id: filmBlockId(8),
        type: "text",
        text: `What I'm playing: ${pageLinkToken(FILM_PAGE_IDS.repertoire)}`,
      },
      {
        id: FILM_PAGE_IDS.repertoire,
        type: "page",
        title: "Repertoire",
        children: [
          {
            id: filmBlockId(11),
            type: "to-do",
            text: "Fantaisie-Impromptu, Op. 66 (learning, recital piece)",
            checked: false,
          },
          {
            id: filmBlockId(12),
            type: "to-do",
            text: "Nocturne in E-flat major, Op. 9 No. 2 (next)",
            checked: false,
          },
          {
            id: filmBlockId(13),
            type: "to-do",
            text: "Prelude in C major, BWV 846",
            checked: true,
          },
          {
            id: filmBlockId(14),
            type: "text",
            text: "Ms. Laurent: let the left hand's sextuplets carry you, and keep the four-against-six even before you push the tempo.",
          },
        ],
      },
      {
        id: FILM_PAGE_IDS.practiceLog,
        type: "page",
        title: "Practice log",
        children: [
          {
            id: filmBlockId(21),
            type: "text",
            text: "Mon: 35 min. Bars 1–4 left hand alone, the arpeggios are getting even.",
          },
          {
            id: filmBlockId(22),
            type: "text",
            text: "Tue: 40 min. Bars 5–8 right hand, then clapping 4 against 6 with the metronome.",
          },
          {
            id: filmBlockId(23),
            type: "text",
            text: "Wed: 30 min. Hands together, bars 1–4 at 50%. Bar 7 needs fingering.",
          },
        ],
      },
    ],
  },
  {
    id: FILM_PAGE_IDS.lisbon,
    type: "page",
    title: "Lisbon in May",
    tags: [{ name: "Planning", color: "purple" }],
    children: [
      {
        id: filmBlockId(31),
        type: "text",
        text: "Four days, flying in on Thursday. The places to see are saved on the map in Places.",
      },
      {
        id: filmBlockId(32),
        type: "to-do",
        text: "Book the Gulbenkian for Friday morning",
        checked: true,
      },
      {
        id: filmBlockId(33),
        type: "to-do",
        text: "Table at Cervejaria Ramiro, Saturday",
        checked: false,
      },
      {
        id: filmBlockId(34),
        type: "to-do",
        text: "Take the 28 tram early, before the queues",
        checked: false,
      },
    ],
  },
  {
    id: FILM_PAGE_IDS.ideas,
    type: "page",
    title: "Ideas",
    children: [
      {
        id: filmBlockId(41),
        type: "text",
        text: "A practice timer that writes the log for me.",
      },
      {
        id: filmBlockId(42),
        type: "text",
        text: "Share the Lisbon map with Inês before the trip.",
      },
    ],
  },
];
