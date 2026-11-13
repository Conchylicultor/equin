import { describe, expect, test } from "bun:test";
import { groupPageActions, type PageActionSite } from "./page-actions";

const onHost = (label: string, host: string): PageActionSite => ({
  label,
  matches: (url) => url.host === host,
});

const site = onHost("equin.ai", "equin.ai");
const tube = onHost("YouTube", "www.youtube.com");
const openLocally = { id: "open-locally", site };
const guide = { id: "guide", site };
const actions = [
  openLocally,
  { id: "chord", site: tube },
  guide,
  { id: "sonata", site: tube },
];

describe("groupPageActions", () => {
  test("keeps only the actions matching the page", () => {
    expect(
      groupPageActions(actions, new URL("https://equin.ai/about")),
    ).toEqual([{ label: "equin.ai", actions: [openLocally, guide] }]);
  });

  test("groups by site, in the order the actions come", () => {
    const both = [
      ...actions,
      { id: "anywhere", site: { label: "Any page", matches: () => true } },
    ];
    expect(
      groupPageActions(both, new URL("https://www.youtube.com/watch?v=x")).map(
        (g) => [g.label, g.actions.map((a) => a.id)],
      ),
    ).toEqual([
      ["YouTube", ["chord", "sonata"]],
      ["Any page", ["anywhere"]],
    ]);
  });

  test("a page no site matches has no sections", () => {
    expect(groupPageActions(actions, new URL("https://example.com/"))).toEqual(
      [],
    );
  });
});
