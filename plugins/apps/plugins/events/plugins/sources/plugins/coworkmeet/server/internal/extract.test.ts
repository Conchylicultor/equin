import { describe, expect, it } from "bun:test";
import { NonRetryableError } from "@plugins/infra/plugins/jobs/server";
import type { CoworkmeetSourceConfig } from "../../core";
import { extractCoworkmeetSessions } from "./extract";
import {
  AFTERWORK,
  BARE,
  CENTS,
  DUPLICATE_NOTE,
  HOXTON,
  MERCURE,
  NELSONS,
  OISE,
  PANTIN,
  PENICHE_ANNETTE,
} from "./fixtures";
import type { SessionRow } from "./rows";

const ALL: CoworkmeetSourceConfig = {
  types: [],
  districts: [],
  ambiances: [],
  quietLevels: [],
  powerOutlets: [],
};

function extract(rows: SessionRow[], config: CoworkmeetSourceConfig = ALL) {
  return extractCoworkmeetSessions(
    { rows },
    { sourceId: "evs-test", config, runId: "run-test" },
  );
}

describe("extractCoworkmeetSessions", () => {
  it("maps a live session onto an event", async () => {
    const { events } = await extract([NELSONS]);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      externalId: "b53542dd-18a0-43a4-bd3c-6ed104e585ed",
      title: "Coworking — Le Nelson’s",
      description: "Nelson's\n13 of 16 signed up · Host: Team CoworkMeet",
      date: {
        kind: "once",
        startsAt: new Date("2026-09-10T12:30:00.000Z"),
        endsAt: new Date("2026-09-10T16:00:00.000Z"),
      },
      venue: "Le Nelson’s",
      city: "Paris",
      url: "https://www.coworkmeet.fr/session/b53542dd-18a0-43a4-bd3c-6ed104e585ed",
      imageUrl: NELSONS.photo_url ?? undefined,
      price: "Free",
      category: "community",
      tags: ["Coworking", "Paris 1er", "Équilibré", "Modéré", "Prises OK"],
    });
  });

  it("does not repeat the session type when the venue already says it", async () => {
    // The one live afterwork is called `AFTERWORK CoworkMeet`, and
    // `Afterwork — AFTERWORK CoworkMeet` reads as a bug.
    const { events } = await extract([AFTERWORK]);
    expect(events[0]!.title).toBe("AFTERWORK CoworkMeet");
  });

  it("keeps the venue's own spelling, and fixes only its whitespace", async () => {
    const { events } = await extract([PENICHE_ANNETTE, MERCURE]);
    // A trailing space is not a name; four stars are.
    expect(events[0]!.venue).toBe("Péniche Annette K");
    expect(events[1]!.venue).toBe("Hôtel Mercure Montparnasse****");
  });

  it("says the session is free, and what a drink costs beside it", async () => {
    const { events } = await extract([NELSONS, MERCURE, CENTS]);
    expect(events.map((e) => e.price)).toEqual([
      "Free",
      "Free (drinks from €4)",
      "Free (drinks from €2.20)",
    ]);
  });

  it("names the town when the session is not in Paris", async () => {
    const { events } = await extract([PANTIN]);
    expect(events[0]!.city).toBe("Pantin");
    // …and it carries no district tag, because it has no arrondissement.
    expect(events[0]!.tags).toEqual([
      "Coworking",
      "Équilibré",
      "Modéré",
      "Prises ++",
    ]);
  });

  it("reads Paris off a published arrondissement when the address forgot to say", async () => {
    const { events } = await extract([OISE]);
    expect(events[0]!.city).toBe("Paris");
    expect(events[0]!.tags).toContain("Paris 19e");
  });

  it("claims no city at all when nothing says one", async () => {
    const { events } = await extract([HOXTON]);
    expect(events[0]!.city).toBeUndefined();
  });

  it("throws on a date it cannot read, instead of returning a shorter listing", () => {
    // A dropped row is one the engine stamps `disappearedAt` on, so a format we
    // stopped understanding must park the source rather than drain it.
    expect(
      extract([{ ...NELSONS, date_session: "10/09/2026" }]),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });
});

describe("filters", () => {
  it("keeps everything when nothing is selected", async () => {
    const { events } = await extract([NELSONS, PANTIN, AFTERWORK]);
    expect(events).toHaveLength(3);
  });

  it("keeps a session matching any value of a filter", async () => {
    const { events } = await extract([NELSONS, PANTIN, OISE], {
      ...ALL,
      districts: ["Paris 1er", "Paris 19e"],
    });
    expect(events.map((e) => e.venue)).toEqual([
      "Le Nelson’s",
      "Péniche L’Eau et les Rêves",
    ]);
  });

  it("requires every non-empty filter to match", async () => {
    const { events } = await extract([NELSONS, AFTERWORK], {
      ...ALL,
      districts: ["Paris 1er"],
      types: ["Afterwork"],
    });
    expect(events.map((e) => e.title)).toEqual(["AFTERWORK CoworkMeet"]);
  });

  it("does not keep a session the association never rated", async () => {
    // Correct, and the reason each rating filter says so in its description: a
    // filter on "quiet venues" cannot honestly include one nobody rated.
    const { events } = await extract([NELSONS, BARE], {
      ...ALL,
      quietLevels: ["Modéré"],
    });
    expect(events.map((e) => e.venue)).toEqual(["Le Nelson’s"]);
  });
});

describe("flags", () => {
  it("reports nothing on a clean run", async () => {
    const { flags } = await extract([NELSONS, AFTERWORK]);
    expect(flags).toEqual([]);
  });

  it("reports a selected value no session in the listing has", async () => {
    const { flags } = await extract([NELSONS, OISE], {
      ...ALL,
      districts: ["Paris 1er", "Paris 7e"],
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]).toContain('The Districts filter selects "Paris 7e"');
  });

  it("measures extinct values against the whole listing, not the survivors", async () => {
    // `Paris 1er` and `Silencieux` each exist upstream — on different sessions,
    // so the two filters together keep nothing. Neither value is extinct, and
    // testing them against the survivors would report both as missing.
    const { events, flags } = await extract([NELSONS, MERCURE], {
      ...ALL,
      districts: ["Paris 1er"],
      quietLevels: ["Silencieux"],
    });
    expect(events).toEqual([]);
    expect(flags).toEqual([]);
  });

  it("reports how many sessions published no district", async () => {
    const { flags } = await extract([NELSONS, HOXTON, PANTIN]);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toContain("2 sessions publish no arrondissement");
  });

  it("counts sessions with no district across the whole listing", async () => {
    // The count that matters is the one a Districts filter silently drops, so
    // it is measured before the filter, not after.
    const { events, flags } = await extract([NELSONS, HOXTON], {
      ...ALL,
      districts: ["Paris 1er"],
    });
    expect(events).toHaveLength(1);
    expect(flags[0]).toContain("1 session publishes no arrondissement");
  });

  it("reports an end time read as running past midnight", async () => {
    // A live row with one field changed: the association publishes no such
    // session today, and this is the reading it would get if it did.
    const { events, flags } = await extract([
      { ...DUPLICATE_NOTE, heure_debut: "22:00:00", heure_fin: "01:00:00" },
    ]);
    expect(events[0]!.date.endsAt).toEqual(
      new Date("2026-03-20T00:00:00.000Z"),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]).toContain("2026-03-19 22:00:00–01:00:00");
    expect(flags[0]).toContain("past midnight");
  });

  it("reports every kind of caveat on the same run", async () => {
    const { flags } = await extract([NELSONS, HOXTON], {
      ...ALL,
      districts: ["Paris 1er", "Paris 7e"],
    });
    expect(flags).toHaveLength(2);
  });
});
