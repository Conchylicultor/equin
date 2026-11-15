import { describe, expect, test } from "bun:test";
import { appEntries } from "./apps.generated";

// Every app the rail lists wears a tile colour of its own, declared in its
// definition (`defineApp({ iconColor })`): two apps never share one, so no
// launcher, desktop or website draws two apps alike.
describe("app tile colours", () => {
  const listed = appEntries
    .map((e) => e.value.app)
    .filter((app) => app.listed !== false);

  test("every listed app declares its colour", () => {
    expect(
      listed.filter((app) => app.iconColor === undefined).map((a) => a.id),
    ).toEqual([]);
  });

  test("no two listed apps share a colour", () => {
    const byColor = new Map<string, string[]>();
    for (const app of listed) {
      const ids = byColor.get(app.iconColor ?? "") ?? [];
      byColor.set(app.iconColor ?? "", [...ids, app.id]);
    }
    expect([...byColor.values()].filter((ids) => ids.length > 1)).toEqual([]);
  });
});
