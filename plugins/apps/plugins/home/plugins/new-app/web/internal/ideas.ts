/**
 * Starting points the New app screen offers while its field is empty: a kind
 * of app people know, plus the one idea that makes it worth building your own.
 * Plain descriptions a person would type — they fill the field, nothing more.
 */
export const APP_IDEAS: readonly { label: string; text: string }[] = [
  {
    label: "Spreadsheet",
    text: "A spreadsheet with formulas and charts, where I can also ask a column a question in plain words and it fills in the answers.",
  },
  {
    label: "Media center",
    text: "A media center for my films, shows and podcasts where I can search by what is said, and jump straight to the scene where they talk about it.",
  },
  {
    label: "Calendar",
    text: "A calendar that shows what I planned next to what I actually did, so I can see how my weeks really go.",
  },
  {
    label: "Whiteboard",
    text: "An infinite whiteboard where any sticky note can be zoomed into, and becomes a whole board of its own.",
  },
  {
    label: "Flashcards",
    text: "Flashcards for learning Japanese where each word comes with a short clip from a film or song where it is said.",
  },
  {
    label: "Video editor",
    text: 'A video editor where I describe the video I want, like "two minutes of the kids at the beach with upbeat music", and then adjust it.',
  },
  {
    label: "Training log",
    text: "A training log that draws every run I've ever done on one map, and suggests routes through streets I haven't run yet.",
  },
  {
    label: "Finance",
    text: "A budget app that shows every purchase in hours of my work instead of money.",
  },
];

/** How many ideas show at once; the shuffle chip deals another hand. */
export const IDEAS_SHOWN = 5;

/**
 * A random hand of {@link IDEAS_SHOWN} idea indices, the ones not in `prev`
 * first — so a shuffle shows new ideas before repeating any.
 */
export function dealIdeas(prev: readonly number[] = []): number[] {
  const all = APP_IDEAS.map((_, i) => i);
  const shuffle = (xs: number[]) =>
    xs
      .map((x) => ({ x, k: Math.random() }))
      .sort((a, b) => a.k - b.k)
      .map(({ x }) => x);
  return [
    ...shuffle(all.filter((i) => !prev.includes(i))),
    ...shuffle(all.filter((i) => prev.includes(i))),
  ].slice(0, IDEAS_SHOWN);
}
