import { describe, expect, test } from "bun:test";
import {
  compileGenericRules,
  isGenericCancellingRule,
  matchingRules,
  urlFilterNeedle,
  type DnrRule,
  type Ruleset,
} from "./rules";
import { blockedArtifactUrlFingerprint, stableServedPath } from "./kind";

let nextId = 1;
const rule = (condition: DnrRule["condition"], action = "block"): DnrRule => ({
  id: nextId++,
  action: { type: action },
  condition,
});

const set = (rules: DnrRule[]): Ruleset[] => [
  { id: "easyprivacy", name: "EasyPrivacy", rules },
];

const PATH =
  "/artifacts/apps.prototypes.thumbnails.core.4841d5b3c51d0d46.worker/core/fingerprint.js";
const URL = `https://equin.ai${PATH}`;

describe("generic rules", () => {
  test("a rule naming a domain, a || host or third parties only is not generic", () => {
    expect(
      isGenericCancellingRule(
        rule({ urlFilter: "/x.js", requestDomains: ["a.com"] }),
      ),
    ).toBe(false);
    expect(
      isGenericCancellingRule(
        rule({ urlFilter: "/x.js", initiatorDomains: ["a.com"] }),
      ),
    ).toBe(false);
    expect(isGenericCancellingRule(rule({ urlFilter: "||ads.com^" }))).toBe(
      false,
    );
    expect(
      isGenericCancellingRule(
        rule({ urlFilter: "/x.js", domainType: "thirdParty" }),
      ),
    ).toBe(false);
    expect(isGenericCancellingRule(rule({ urlFilter: "/x.js" }, "allow"))).toBe(
      false,
    );
    expect(
      isGenericCancellingRule(
        rule({ urlFilter: "/x.js", requestMethods: ["post"] }),
      ),
    ).toBe(false);
    expect(
      isGenericCancellingRule(
        rule({ urlFilter: "/x.js", excludedInitiatorDomains: ["equin.ai"] }),
      ),
    ).toBe(false);
  });

  test("an exception for another site keeps it generic", () => {
    expect(
      isGenericCancellingRule(
        rule({
          urlFilter: "/fingerprint.js^",
          excludedInitiatorDomains: ["github.com"],
        }),
      ),
    ).toBe(true);
    expect(
      isGenericCancellingRule(rule({ urlFilter: "/x.js" }, "redirect")),
    ).toBe(true);
  });
});

describe("matching", () => {
  test("EasyPrivacy's /fingerprint.js^ blocks the module that broke the demo", () => {
    const { rules } = compileGenericRules(
      set([
        rule({
          urlFilter: "/fingerprint.js^",
          excludedInitiatorDomains: ["github.com"],
        }),
      ]),
    );
    expect(matchingRules(rules, URL, PATH).map((r) => r.filter)).toEqual([
      "/fingerprint.js^",
    ]);
    const renamed = PATH.replace("fingerprint", "content-key");
    expect(matchingRules(rules, `https://equin.ai${renamed}`, renamed)).toEqual(
      [],
    );
  });

  test("^ is a separator or the end, never a letter", () => {
    const { rules } = compileGenericRules(
      set([rule({ urlFilter: "/beacon^" })]),
    );
    expect(
      matchingRules(rules, "https://equin.ai/a/beacon/x.js", "/a/beacon/x.js"),
    ).toHaveLength(1);
    expect(
      matchingRules(rules, "https://equin.ai/a/beacon", "/a/beacon"),
    ).toHaveLength(1);
    expect(
      matchingRules(rules, "https://equin.ai/a/beacons.js", "/a/beacons.js"),
    ).toHaveLength(0);
  });

  test("* and anchors", () => {
    const { rules } = compileGenericRules(
      set([
        rule({ urlFilter: "/track*.js|" }),
        rule({ urlFilter: "|http://" }),
      ]),
    );
    const hits = (p: string, origin = "https://equin.ai") =>
      matchingRules(rules, origin + p, p).map((r) => r.filter);
    expect(hits("/x/tracker-v2.js")).toEqual(["/track*.js|"]);
    expect(hits("/x/tracker-v2.js?x")).toEqual([]);
    expect(hits("/y", "http://equin.localhost:9000")).toEqual(["|http://"]);
  });

  test("case-insensitive unless the rule says otherwise", () => {
    const { rules } = compileGenericRules(
      set([
        rule({ urlFilter: "/AutoTrack." }),
        rule({ urlFilter: "/ClickTrack.", isUrlFilterCaseSensitive: true }),
      ]),
    );
    expect(
      matchingRules(rules, "https://equin.ai/autotrack.js", "/autotrack.js"),
    ).toHaveLength(1);
    expect(
      matchingRules(rules, "https://equin.ai/clicktrack.js", "/clicktrack.js"),
    ).toHaveLength(0);
  });

  test("resource types: an image-only rule does not block a script", () => {
    const { rules } = compileGenericRules(
      set([
        rule({ urlFilter: "/pixel.", resourceTypes: ["image"] }),
        rule({
          urlFilter: "/stats.",
          excludedResourceTypes: ["script", "xmlhttprequest", "other"],
        }),
      ]),
    );
    expect(
      matchingRules(rules, "https://equin.ai/pixel.js", "/pixel.js"),
    ).toHaveLength(0);
    expect(
      matchingRules(rules, "https://equin.ai/pixel.png", "/pixel.png"),
    ).toHaveLength(1);
    expect(
      matchingRules(rules, "https://equin.ai/stats.js", "/stats.js"),
    ).toHaveLength(0);
  });

  test("regex rules match; one JS cannot compile is set aside by name", () => {
    const { rules, uncompiled } = compileGenericRules(
      set([
        rule({ regexFilter: "/analytics-[a-z]+\\.js" }),
        rule({ regexFilter: "(?P<x>a)" }),
      ]),
    );
    expect(
      matchingRules(
        rules,
        "https://equin.ai/analytics-event.js",
        "/analytics-event.js",
      ),
    ).toHaveLength(1);
    expect(uncompiled.map((u) => u.filter)).toEqual(["/(?P<x>a)/"]);
  });

  test("the needle is the longest plain run", () => {
    expect(urlFilterNeedle("|/ads/*/banner^")).toBe("/banner");
  });
});

describe("the report key", () => {
  test("a rebuild's new hashes keep one row per file and rule", () => {
    expect(stableServedPath(PATH)).toBe(
      "/artifacts/apps.prototypes.thumbnails.core.<hash>.worker/core/fingerprint.js",
    );
    const payload = {
      url: PATH,
      source: null,
      ruleset: "easyprivacy",
      ruleId: 8404,
      filter: "/fingerprint.js^",
      matchedUrls: 1,
      rulesFrom: "uBlock Origin Lite x",
    };
    expect(blockedArtifactUrlFingerprint(payload)).toBe(
      blockedArtifactUrlFingerprint({
        ...payload,
        url: PATH.replace("4841d5b3c51d0d46", "0123456789abcdef"),
      }),
    );
  });
});
