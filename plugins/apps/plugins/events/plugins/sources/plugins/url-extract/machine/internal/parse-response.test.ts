import { describe, expect, test } from "bun:test";
import { parseExtractionResponse } from "./parse-response";

// The parser is the boundary between a model's free text and the engine's typed
// input, so the two things worth asserting are: it tolerates the ways a model
// legitimately dresses up valid JSON, and it THROWS — never returns an empty
// result — on anything it cannot vouch for. `events: []` means "the page lists no
// events", and the engine acts on that by stamping every previously-found event
// as disappeared.

const EVENT = {
  title: "Techno Thursdays",
  date: {
    kind: "recurring",
    startsAt: "2026-08-06T23:00:00+02:00",
    rule: { freq: "weekly", interval: 1, byWeekday: ["th"] },
    label: "every Thursday",
  },
  category: "club",
  venue: "Fitzroy",
  price: "Free before midnight",
};

const body = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ events: [EVENT], flags: [], ...over });

describe("parseExtractionResponse", () => {
  test("parses the object envelope", () => {
    const { events, flags } = parseExtractionResponse(body());
    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe("Techno Thursdays");
    // `z.coerce.date()` — the wire carries ISO strings, the engine gets Dates.
    expect(events[0]?.date.startsAt).toBeInstanceOf(Date);
    expect(flags).toEqual([]);
  });

  test("a series is ONE object carrying its rule, not one per occurrence", () => {
    const { events } = parseExtractionResponse(body());
    expect(events).toHaveLength(1);
    expect(events[0]?.date.kind).toBe("recurring");
  });

  test("round-trips the flags the model reported", () => {
    const raw = body({
      flags: [
        'The page says "every 2nd and 4th Tuesday"; stored as every Tuesday.',
        "Aug 13, Aug 20 and Sep 3 are an irregular list; stored the first only.",
      ],
    });
    expect(parseExtractionResponse(raw).flags).toHaveLength(2);
  });

  test("defaults flags to [] when the model omits the key", () => {
    // An extraction with nothing to report is the NORMAL case; demanding the
    // key would turn the expected answer into a terminal failure.
    expect(parseExtractionResponse(JSON.stringify({ events: [] })).flags).toEqual(
      [],
    );
  });

  test("parses an empty events list as a legitimate 'no events' answer", () => {
    expect(parseExtractionResponse(body({ events: [] })).events).toEqual([]);
  });

  test("parses an object inside a ```json fence", () => {
    expect(
      parseExtractionResponse(`\`\`\`json\n${body()}\n\`\`\``).events,
    ).toHaveLength(1);
  });

  test("parses an object wrapped in prose", () => {
    const raw = `Here are the events I found:\n\n${body()}\n\nLet me know if you need more.`;
    expect(parseExtractionResponse(raw).events).toHaveLength(1);
  });

  test("is not fooled by a brace inside a flag string", () => {
    // The whole reason the scan is string-aware: a `}` in a flag's prose must
    // not terminate the object and truncate the answer.
    const raw = body({
      flags: ['The page states {every 2nd and 4th Tuesday} — not expressible.'],
    });
    const { events, flags } = parseExtractionResponse(`${raw} — done.`);
    expect(events).toHaveLength(1);
    expect(flags[0]).toContain("{every 2nd and 4th Tuesday}");
  });

  test("is not fooled by a brace inside a title", () => {
    const raw = JSON.stringify({
      events: [{ ...EVENT, title: 'Techno {Night} "live"' }],
      flags: [],
    });
    expect(parseExtractionResponse(raw).events[0]?.title).toBe(
      'Techno {Night} "live"',
    );
  });

  test("REJECTS the pre-recurrence bare array — one format, loudly", () => {
    // No fallback: a stale response shape parsed leniently would silently drop
    // the flag channel and re-introduce materialized occurrences.
    expect(() => parseExtractionResponse(JSON.stringify([EVENT]))).toThrow(
      /did not match the event schema/,
    );
  });

  test("throws on a response carrying no object at all", () => {
    expect(() =>
      parseExtractionResponse("I could not find any events."),
    ).toThrow(/no JSON object/);
  });

  test("throws on a truncated object", () => {
    expect(() => parseExtractionResponse(`{"events": [{"title": "x"`)).toThrow(
      /unterminated JSON object/,
    );
  });

  test("throws on malformed JSON, carrying the raw output", () => {
    expect(() =>
      parseExtractionResponse(`{events: [{title: 'Techno'}]}`),
    ).toThrow(/not valid JSON.*title: 'Techno'/s);
  });

  test("throws when an event misses a required key", () => {
    expect(() =>
      parseExtractionResponse(
        JSON.stringify({ events: [{ title: "No date here" }] }),
      ),
    ).toThrow(/did not match the event schema/);
  });

  test("throws on a date shape outside the closed format", () => {
    expect(() =>
      parseExtractionResponse(
        JSON.stringify({
          events: [{ ...EVENT, date: { kind: "irregular", dates: [] } }],
        }),
      ),
    ).toThrow(/did not match the event schema/);
  });

  test("throws on a category outside the closed list", () => {
    expect(() =>
      parseExtractionResponse(
        JSON.stringify({ events: [{ ...EVENT, category: "rave" }] }),
      ),
    ).toThrow(/did not match the event schema/);
  });

  test("failures are terminal, so the engine dead-letters instead of re-paying", () => {
    expect(() => parseExtractionResponse("nothing here")).toThrow(
      expect.objectContaining({ name: "NonRetryableError" }),
    );
  });
});
