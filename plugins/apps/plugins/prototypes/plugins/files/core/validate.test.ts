import { describe, expect, test } from "bun:test";
import { validatePrototypeFolder, type PrototypeFolder } from "./validate";

const ME = "proto-1790000000-aaaa";
const OTHER = "proto-1790000001-bbbb";

function folder(text: string, siblings: string[]): PrototypeFolder {
  return {
    dirName: ME,
    subdirs: [],
    files: ["index.html", "app.js"],
    texts: new Map([
      ["index.html", "<title>T</title>"],
      ["app.js", text],
    ]),
    siblings: [ME, ...siblings],
  };
}

function siblingRefs(text: string, siblings: string[]): string[] {
  return validatePrototypeFolder(folder(text, siblings))
    .map((p) => p.detail)
    .filter((d) => d.startsWith("references another prototype"));
}

describe("validatePrototypeFolder — references to a sibling folder", () => {
  test("a path into a sibling is a problem", () => {
    expect(siblingRefs(`fetch("${OTHER}/data.json")`, [OTHER])).toEqual([
      `references another prototype's folder (\`${OTHER}/\`)`,
    ]);
    expect(siblingRefs(`<img src="/${OTHER}/a.png">`, [OTHER])).toHaveLength(1);
  });

  test("at the start of the file", () => {
    expect(siblingRefs(`${OTHER}/x`, [OTHER])).toHaveLength(1);
  });

  test("the name inside a longer name, or not followed by /, is not", () => {
    expect(siblingRefs(`x-${OTHER}/y ${OTHER}.css ${OTHER}`, [OTHER])).toEqual(
      [],
    );
  });

  test("a name with characters outside [A-Za-z0-9_-] is still matched", () => {
    expect(siblingRefs(`href="my.proto/x"`, ["my.proto"])).toHaveLength(1);
    expect(siblingRefs(`href="amy.proto/x"`, ["my.proto"])).toEqual([]);
  });

  test("itself is not a sibling", () => {
    expect(siblingRefs(`${ME}/x`, [])).toEqual([]);
  });

  test("one problem per referenced sibling, in sibling order", () => {
    const third = "proto-1790000002-cccc";
    expect(siblingRefs(`${third}/a ${OTHER}/b`, [OTHER, third])).toEqual([
      `references another prototype's folder (\`${OTHER}/\`)`,
      `references another prototype's folder (\`${third}/\`)`,
    ]);
  });
});
