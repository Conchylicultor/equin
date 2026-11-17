import { describe, expect, test } from "bun:test";
import { renderNotice } from "@plugins/infra/plugins/launcher/plugins/installer-notice/core";
import { judgeInstance, otherInstanceNotice } from "./owner";

describe("judgeInstance", () => {
  test("no record: unclaimed — a fresh account, or a moved checkout", () => {
    expect(judgeInstance("/a", [])).toEqual({ kind: "unclaimed" });
  });

  test("every record names this checkout: it holds the account", () => {
    expect(
      judgeInstance("/a", [
        { source: "deploy", checkout: "/a" },
        { source: "service", checkout: "/a" },
      ]),
    ).toEqual({ kind: "this" });
  });

  test("a second checkout is refused by either record alone", () => {
    for (const source of ["deploy", "service"] as const) {
      const verdict = judgeInstance("/b", [{ source, checkout: "/a" }]);
      expect(verdict).toMatchObject({ kind: "other", checkout: "/a" });
    }
  });

  test("records that disagree: the one that is not this checkout wins", () => {
    const verdict = judgeInstance("/a", [
      { source: "deploy", checkout: "/a" },
      { source: "service", checkout: "/b" },
    ]);
    expect(verdict).toMatchObject({ kind: "other", checkout: "/b" });
  });
});

describe("otherInstanceNotice", () => {
  test("keeps the installer message rules, the paths only in commands and details", () => {
    const notice = otherInstanceNotice({
      action: "start",
      here: "/srv/x/equin-2",
      verdict: {
        kind: "other",
        checkout: "/srv/x/my equin",
        claims: [{ source: "deploy", checkout: "/srv/x/my equin" }],
      },
    });
    const text = renderNotice(notice);
    expect(text).toContain("`cd '/srv/x/my equin' && ./install.sh`");
    expect(text).toContain("this checkout: /srv/x/equin-2");
    expect(notice.blocked).not.toContain("/srv");
  });

  test("both actions build a notice the rules accept", () => {
    for (const action of ["start", "build"] as const) {
      expect(() =>
        otherInstanceNotice({
          action,
          here: "/srv/b",
          verdict: {
            kind: "other",
            checkout: "/srv/a",
            claims: [
              { source: "deploy", checkout: "/srv/a" },
              { source: "service", checkout: "/srv/a" },
            ],
          },
        }),
      ).not.toThrow();
    }
  });
});
