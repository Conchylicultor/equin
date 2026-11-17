import { describe, expect, it } from "bun:test";
import { extractSalsanuevaCourses } from "./extract";
import { buildCourseSeries } from "./series";
import type { CourseRow } from "./rows";
import type { SalsanuevaSourceConfig } from "../../core";

const ALL: SalsanuevaSourceConfig = {
  type: [],
  activity: [],
  sub_activity: [],
  course_level: [],
  location_name: [],
  coach: [],
  days: [],
};

/** `2026-09-07` is a Monday. Both studios' real address spellings are used. */
function row(over: Partial<CourseRow> = {}): CourseRow {
  return {
    start: "2026-09-07T19:00:00+0200",
    type: "Adulte",
    activity: "Bachata",
    sub_activity: "Bachata Moderna",
    course_level: "Débutant",
    course_date: "2026-09-07",
    course_start: "19:00",
    course_duration: 60,
    classroom: "SalsaNueva 12è  -  PATRICK SWAYZE",
    location: { name: "SalsaNueva 12è", address: "10 rue Erard 75012 PARIS" },
    coachs: [{ name: "Clara" }],
    ...over,
  };
}

function extract(rows: CourseRow[], config: SalsanuevaSourceConfig = ALL) {
  return extractSalsanuevaCourses(
    { series: buildCourseSeries(rows) },
    {
      sourceId: "evs-test",
      config,
      runId: "run-test",
      job: { sleep: () => Promise.resolve() },
    },
  );
}

describe("extractSalsanuevaCourses", () => {
  it("publishes one recurring event per weekly course", async () => {
    const { events } = await extract([
      row({ course_date: "2026-09-07", start: "2026-09-07T19:00:00+0200" }),
      row({ course_date: "2026-09-14", start: "2026-09-14T19:00:00+0200" }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      title: "Bachata · Bachata Moderna · Débutant",
      // The room label already names the studio — prefixing it would stutter —
      // and the school's own double spaces are collapsed.
      venue: "SalsaNueva 12è - PATRICK SWAYZE",
      city: "Paris",
      category: "sport",
      date: { kind: "recurring", rule: { freq: "weekly", byWeekday: ["mo"] } },
    });
  });

  it("reads the city out of the other address spelling too", async () => {
    const { events } = await extract([
      row({
        location: {
          name: "SalsaNueva 20è",
          address: "32 Rue du Capitaine Marchal, 75020 Paris, France",
        },
        classroom: "SalsaNueva 20è - HALL 3",
      }),
    ]);
    expect(events[0]!.city).toBe("Paris");
  });

  it("claims no city when the address states none", async () => {
    const { events } = await extract([
      row({ location: { name: "SalsaNueva 12è" } }),
    ]);
    expect(events[0]!.city).toBeUndefined();
  });

  it("drops the dance from the title and the tags when the style repeats it", async () => {
    const { events } = await extract([
      row({
        activity: "Afro",
        sub_activity: "Afro",
        course_level: "Ts niveaux",
      }),
    ]);
    expect(events[0]!.title).toBe("Afro · Ts niveaux");
    expect(events[0]!.tags).toEqual([
      "Adulte",
      "Afro",
      "Ts niveaux",
      "SalsaNueva 12è",
      "Lundi",
      "Clara",
    ]);
  });

  it("links to the school's own page showing exactly this course", async () => {
    const { events } = await extract([row()]);
    const url = new URL(events[0]!.url!);
    expect(url.pathname).toBe("/danses-adultes/planning-adultes/");
    expect(url.searchParams.get("activity")).toBe("Bachata");
    expect(url.searchParams.get("course_level")).toBe("Débutant");
    expect(url.searchParams.get("days")).toBe("Lundi");
    // Left open on purpose: a stand-in teacher must not hide the course.
    expect(url.searchParams.get("coach")).toBeNull();
  });

  it("reports the weeks a course pauses, aggregated by date", async () => {
    const skip = (dates: string[], over: Partial<CourseRow>) =>
      dates.map((d) =>
        row({ ...over, course_date: d, start: `${d}T19:00:00+0200` }),
      );

    // Three Mondays with the 21st missing. Two occurrences a fortnight apart
    // would be read as a FORTNIGHTLY course, correctly — a gap is only a gap
    // once the rhythm around it is weekly.
    const mondays = ["2026-09-07", "2026-09-14", "2026-09-28"];
    const { events, flags } = await extract([
      ...skip(mondays, {}),
      ...skip(mondays, {
        activity: "Salsa Cubaine",
        sub_activity: "Salsa Cubaine",
      }),
    ]);

    expect(events).toHaveLength(2);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toContain("2 courses do not run on 2026-09-21");
  });

  it("reports a filter value the schedule no longer offers", async () => {
    const { events, flags } = await extract([row()], {
      ...ALL,
      activity: ["Bachata", "Lindy Hop"],
    });
    expect(events).toHaveLength(1);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toContain('The Dances filter selects "Lindy Hop"');
  });

  it("says nothing when the run has nothing to say", async () => {
    const { flags } = await extract([
      row({ course_date: "2026-09-07", start: "2026-09-07T19:00:00+0200" }),
      row({ course_date: "2026-09-14", start: "2026-09-14T19:00:00+0200" }),
    ]);
    expect(flags).toEqual([]);
  });
});
