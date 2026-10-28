import { describe, expect, test } from "bun:test";
import {
  auditPrototypeFixtureThumbnails,
  parsePrototypeTree,
  prototypeFixtureStates,
  prototypeFixtureVersionFingerprint,
} from "./tree";

const A = "proto-1792900000-abc123";
const B = "proto-1792900060-def456";
const TAG = "prtag-1792900000-tag001";

const TREE = {
  [`${A}/index.html`]: "<title>A</title>",
  [`${A}/styles.css`]: "body{}",
  [`${A}/steps/v1.txt`]: "Darker\n\nWhy it changed.",
  [`${A}/steps/v1/styles.css`]: "body{color:#000}",
  [`${A}/steps/v2.txt`]: "Add data",
  [`${A}/steps/v2/data.js`]: "export {}",
  [`${B}/index.html`]: "<title>B</title>",
  [`_picks/${A}.json`]: '{"accent":"teal"}',
};

describe("parsePrototypeTree", () => {
  test("folders, steps laid over the one before, and records", () => {
    const { prototypes, records } = parsePrototypeTree(TREE);
    expect(prototypes.map((p) => p.id)).toEqual([A, B]);
    const [a] = prototypes;
    expect(a!.versions.map((v) => [v.n, v.subject, v.body])).toEqual([
      [0, "", ""],
      [1, "Darker", "Why it changed."],
      [2, "Add data", ""],
    ]);
    expect(a!.versions[2]!.files).toEqual({
      "index.html": "<title>A</title>",
      "styles.css": "body{color:#000}",
      "data.js": "export {}",
    });
    expect(a!.versions[2]!.changed).toEqual({ "data.js": "export {}" });
    expect(records).toEqual({ [`_picks/${A}.json`]: '{"accent":"teal"}' });
  });

  test("loud on what the layout does not allow", () => {
    expect(() => parsePrototypeTree({ "not-an-id/index.html": "" })).toThrow(
      /not a prototype id/,
    );
    expect(() => parsePrototypeTree({ [`${A}/a/b.css`]: "" })).toThrow(
      /nested/,
    );
    expect(() =>
      parsePrototypeTree({
        [`${A}/index.html`]: "",
        [`${A}/steps/v2.txt`]: "x",
        [`${A}/steps/v2/a.css`]: "",
      }),
    ).toThrow(/step v1 needs both/);
    expect(() => parsePrototypeTree({ [`${A}/styles.css`]: "" })).toThrow(
      /no index.html/,
    );
    expect(() => parsePrototypeTree({ [`_picks/${A}.json`]: "{}" })).toThrow(
      /no prototype folder/,
    );
  });
});

describe("auditPrototypeFixtureThumbnails", () => {
  test("names the versions with no PNG and the PNGs no version names", () => {
    const parsed = parsePrototypeTree(TREE);
    const keys = parsed.prototypes.flatMap((p) =>
      p.versions.map((v) => prototypeFixtureVersionFingerprint(v)),
    );
    expect(new Set(keys).size).toBe(4);
    const png = new Uint8Array([1]);
    const full = Object.fromEntries(keys.map((k) => [k, png]));
    expect(auditPrototypeFixtureThumbnails(parsed, full)).toMatchObject({
      missing: [],
      unused: [],
    });
    const { [keys[1]!]: _dropped, ...partial } = full;
    const audit = auditPrototypeFixtureThumbnails(parsed, {
      ...partial,
      stale: png,
    });
    expect(audit.missing).toEqual([`${A} v1 (${keys[1]}.png)`]);
    expect(audit.unused).toEqual(["stale.png"]);
  });
});

describe("prototypeFixtureStates", () => {
  const parsed = parsePrototypeTree(TREE);

  test("one row per tagged or pinned prototype", () => {
    expect(
      prototypeFixtureStates(parsed, {
        tags: [{ id: TAG, name: "T", color: null, carriers: [B] }],
        pinned: [A],
      }),
    ).toEqual([
      { id: A, tagId: null, pinned: true },
      { id: B, tagId: TAG, pinned: false },
    ]);
  });

  test("loud on a stranger, a second tag, a malformed tag id", () => {
    expect(() =>
      prototypeFixtureStates(parsed, { pinned: ["proto-1792900120-zzz999"] }),
    ).toThrow(/does not hold/);
    expect(() =>
      prototypeFixtureStates(parsed, {
        tags: [
          { id: TAG, name: "T", color: null, carriers: [A] },
          {
            id: "prtag-1792900000-tag002",
            name: "U",
            color: null,
            carriers: [A],
          },
        ],
      }),
    ).toThrow(/two tags/);
    expect(() =>
      prototypeFixtureStates(parsed, {
        tags: [{ id: "tag", name: "T", color: null, carriers: [] }],
      }),
    ).toThrow(/not a prototype tag id/);
  });
});
