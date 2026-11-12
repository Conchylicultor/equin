import type {
  PageFixture,
  PageFixtureNode,
  PageTreeFixture,
} from "@plugins/apps/plugins/pages/plugins/fixtures/core";
import { EmojiSchema } from "@plugins/ui/plugins/icons/plugins/emoji/core";
import { PIANO_SHOP_LIST } from "../../../core";
import { filmBlockId } from "./ids";

// The film's workspace: a real person's Pages, kept for a long time and kept
// tidy — sections with icons, each with the sub-pages they file under it, the
// way the user arranges their own (nested, one emoji per page). The film opens
// Music › Buying a piano: a short page the user wrote in their own words — a
// line of context, their checklist of shops (each "<shop>: <a line about it>"
// with its place), then the questions to ask — which the film's Wish extends
// after the last shop: more shops in the same form, then a map. (The sidebar's one open section,
// Music, is the browser's own view state, set by the film's pre-roll.)
// A Pages fixture (`apps/pages/fixtures`), written by its writer.

/** The pages the film names. Content blocks are numbered from 100 up. */
export const FILM_PAGE_IDS = {
  home: filmBlockId(1),
  music: filmBlockId(10),
  piano: filmBlockId(11),
  repertoire: filmBlockId(12),
  practiceLog: filmBlockId(13),
  buying: filmBlockId(14),
  teacher: filmBlockId(15),
} as const;

/** The Piano page's "This week" list: the agent's note goes right after its last line. */
export const PIANO_NOTE_ANCHOR = "Book the tuner before the lesson on the 14th";

let next = 100;
const id = () => filmBlockId(next++);

const text = (t: string): PageFixtureNode => ({
  id: id(),
  type: "text",
  text: t,
});
const h2 = (t: string, fixed?: string): PageFixtureNode => ({
  id: fixed ?? id(),
  type: "heading-2",
  text: t,
});
const todo = (t: string, checked = false, fixed?: string): PageFixtureNode => ({
  id: fixed ?? id(),
  type: "to-do",
  text: t,
  checked,
});

let nextPage = 30;
function page(
  title: string,
  icon: string,
  children: readonly PageFixtureNode[],
  extra: Partial<Pick<PageFixture, "id" | "tags" | "starred">> = {},
): PageFixture {
  return {
    id: extra.id ?? filmBlockId(nextPage++),
    type: "page",
    title,
    icon: EmojiSchema.parse(icon),
    // A row in its parent page, opened on its own — as a sub-page is kept.
    expanded: false,
    ...(extra.tags ? { tags: extra.tags } : {}),
    ...(extra.starred ? { starred: true as const } : {}),
    children,
  };
}

export const FILM_PAGES: PageTreeFixture = [
  page(
    "Home",
    "🏠",
    [
      text("Everything I keep, in one place. Start the week from TODO."),
      h2("This month"),
      todo("Renew the passport (expires in March)"),
      todo("Book the summer trip to Bergen", true),
      todo("Call the bank about the savings account"),
    ],
    { id: FILM_PAGE_IDS.home, starred: true },
  ),
  page("TODO", "✅", [
    todo("Print the photos from Sunday"),
    todo("Fix the bike's back brake"),
    todo("Return the library books", true),
    todo("Order my sister's birthday present"),
    todo("Plan the menu for Saturday's dinner"),
  ]),
  page("Work", "💼", [
    text("Notes from the studio — meetings, goals, people."),
    page("Weekly notes", "📅", [
      h2("Monday"),
      text(
        "Client review moved to Thursday. Ship the new onboarding screens first.",
      ),
      h2("Wednesday"),
      text(
        "Design critique: the settings page needs fewer toggles, more defaults.",
      ),
    ]),
    page("Q4 goals", "🎯", [
      todo("Launch the redesigned onboarding", true),
      todo("Hire a second designer"),
      todo("Write the design-system guidelines"),
    ]),
    page("1:1s", "🤝", [
      text(
        "The new designer wants to lead the mobile project. Pair them with a senior first.",
      ),
      text("The team is tired after the launch; suggest a long weekend."),
    ]),
  ]),
  page("Projects", "🏗️", [
    text("Things I'm building outside work."),
    page("Balcony garden", "🌱", [
      todo("Tomatoes and basil in the big planter", true),
      todo("Drip irrigation before the holidays"),
      text("Lavender hates wet feet: gravel at the bottom of the pot."),
    ]),
    page("Bike restoration", "🚲", [
      text("1982 Peugeot PX10. Frame repainted, waiting for the wheels."),
      todo("Find period-correct brake levers"),
      todo("New bar tape (cork, honey)"),
    ]),
  ]),
  page(
    "Music",
    "🎵",
    [
      text("Piano lessons, what I'm playing, and what I'm listening to."),
      page(
        "Piano",
        "🎹",
        [
          text(
            "Lessons every other Tuesday. Next piece after the recital: something joyful, a bit of a challenge.",
          ),
          h2("This week"),
          todo("Scales in D major, hands together, 80 bpm", true),
          todo("Finish the Chopin nocturne, last two pages"),
          todo(PIANO_NOTE_ANCHOR),
          page(
            "Repertoire",
            "📚",
            [
              todo(
                "Nocturne in E-flat major, Op. 9 No. 2 — Chopin (recital piece)",
              ),
              todo("Prelude in C major, BWV 846 — Bach", true),
              todo("Gymnopédie No. 1 — Satie", true),
              todo("Wedding-day at Troldhaugen — Grieg (next)"),
            ],
            { id: FILM_PAGE_IDS.repertoire },
          ),
          page(
            "Practice log",
            "📓",
            [
              text(
                "Mon: 35 min. Nocturne bars 1–12, slow, with the pedal marks.",
              ),
              text(
                "Tue: lesson. Let the left hand breathe, the melody sings on top.",
              ),
              text("Wed: 40 min. The cadenza at 60%, hands separately."),
            ],
            { id: FILM_PAGE_IDS.practiceLog },
          ),
          page(
            "Lessons",
            "👩‍🏫",
            [
              text(
                "Every other Tuesday, 18:30. 45 € per lesson, paid monthly.",
              ),
              text("Studio: 12 rue des Martyrs, 3rd floor, code 4B21."),
            ],
            { id: FILM_PAGE_IDS.teacher },
          ),
        ],
        { id: FILM_PAGE_IDS.piano, starred: true },
      ),
      page(
        "Buying a piano",
        "🛒",
        [
          text("Looking for a real upright to replace the digital one."),
          h2("Shops"),
          // The user's list: each shop with a line about it and its place
          // (ticked once visited); the film's agent adds more in the same form.
          ...PIANO_SHOP_LIST.map((shop): PageFixtureNode => ({
            id: shop.todo,
            type: "to-do",
            text: shop.text,
            checked: shop.checked,
            children: [
              {
                id: shop.place,
                type: "place",
                place: { providerId: "google", placeId: shop.placeId },
              },
            ],
          })),
          // After the list: what the agent's shops push down as they arrive.
          h2("Questions to ask"),
          {
            type: "markdown",
            markdown: [
              "- How old is it, and when was it last tuned?",
              "- Is delivery to a third floor included?",
              "- Can I rent it for a few months before buying?",
            ].join("\n"),
          },
        ],
        { id: FILM_PAGE_IDS.buying },
      ),
      page("Listening", "🎧", [
        todo("Grieg — Lyric Pieces, Leif Ove Andsnes", true),
        todo("Satie — Gnossiennes, Alexandre Tharaud"),
        todo("Keith Jarrett — The Köln Concert"),
      ]),
    ],
    { id: FILM_PAGE_IDS.music },
  ),
  page("Travel", "✈️", [
    page("Bergen, July", "🇳🇴", [
      text("Four days. Troldhaugen for a lunchtime concert, then the fjord."),
      todo("Concert tickets at Troldsalen", true),
      todo("Ferry to the Hardangerfjord"),
    ]),
    page("Lisbon, last May", "🇵🇹", [
      text(
        "Best trip of the year. The Gulbenkian garden in the morning, pastéis de Belém every day.",
      ),
    ]),
    page("Packing list", "🧳", [
      todo("Adapters"),
      todo("Earplugs"),
      todo("Reading for the plane"),
    ]),
  ]),
  page("Recipes", "🍳", [
    page("Weeknight dinners", "🥘", [
      text("Lentil dal — 30 min, freezes well."),
      text("Shakshuka — eggs, peppers, cumin. Bread to dip."),
      text("Miso salmon — 12 min in the oven at 200 °C."),
    ]),
    page("Baking", "🥐", [
      text("Sourdough: 75% hydration, 4 folds, overnight in the fridge."),
      text("Apple tart — the old recipe card is in the blue box."),
    ]),
  ]),
  page("Reading", "📖", [
    page("2026 books", "📚", [
      todo("Klara and the Sun — Kazuo Ishiguro", true),
      todo("The Overstory — Richard Powers", true),
      todo("Piranesi — Susanna Clarke"),
    ]),
    page("Quotes", "💬", [
      text("“Simplicity is the final achievement.” — Chopin"),
    ]),
  ]),
  page("Health", "🏃", [
    text("Run Tuesday, Thursday and Sunday. Yoga on Wednesday."),
    page("10K plan", "👟", [
      todo("Week 1: 3 × 5 km easy", true),
      todo("Week 2: 4 × 5 km, one at tempo"),
    ]),
  ]),
  page("Finances", "💰", [
    text("Budget reviewed on the first Sunday of the month."),
    todo("Move the piano savings to the high-interest account"),
  ]),
  page("Journal", "📔", [
    page("October", "🍂", [
      text(
        "Cold week, first fire in the evening. My sister's recital went well.",
      ),
      text("Finished the Ishiguro. Quiet, sad, good."),
    ]),
    page("September", "🍁", [
      text("Back to work, back to lessons. Started running again."),
    ]),
  ]),
  page("Ideas", "💡", [
    todo("A small shelf above the piano for the metronome and the books"),
    todo("Learn to read a score faster: one new piece every month"),
    todo("Photo book of the Lisbon trip"),
  ]),
  page("House", "🏡", [
    text("Things to do in the apartment."),
    todo("Repaint the hallway"),
    todo("Call the plumber about the bathroom tap", true),
    todo("Replace the bulb in the kitchen"),
  ]),
  page("Gift ideas", "🎁", [
    text("My sister — a metronome, or the Debussy book she wanted."),
    text("Mum — the blue scarf from the market."),
    text("Dad — a good flashlight."),
  ]),
];
