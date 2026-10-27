import { describe, expect, test } from "bun:test";
import { parseRelPath } from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { classifyTreePath } from "./tree-path";

const ID = "proto-1789000000-abcd";
const classify = (path: string) => classifyTreePath(parseRelPath(path));

describe("classifyTreePath", () => {
  test("a history's latest stamp is a recorded version of that id, in any format", () => {
    for (const format of ["git", "snapshots"]) {
      expect(classify(`_history/${ID}.${format}/latest.json`)).toEqual({
        kind: "version-recorded",
        id: ID,
      });
    }
  });

  test("anything else under _history is internal", () => {
    for (const path of [
      `_history/.staging-${ID}-x1/latest.json`,
      `_history/${ID}.git/info/latest.json`,
      `_history/not-an-id.git/latest.json`,
      `_history/${ID}/latest.json`,
      `_history/${ID}.lock`,
    ]) {
      expect(classify(path)).toEqual({ kind: "history-internal" });
    }
  });

  test("a picks file is that id's picks changing", () => {
    expect(classify(`_picks/${ID}.json`)).toEqual({
      kind: "picks-recorded",
      id: ID,
    });
  });

  test("anything else under _picks is internal", () => {
    for (const path of [
      `_picks/${ID}.json.tmp`,
      `_picks/${ID}.lock`,
      `_picks/not-an-id.json`,
      `_picks/nested/${ID}.json`,
      `_picks`,
    ]) {
      expect(classify(path)).toEqual({ kind: "picks-internal" });
    }
  });

  test("anything under the retired _trash dir is nothing to react to", () => {
    for (const path of [`_trash/${ID}/index.html`, `_trash/${ID}`, `_trash`]) {
      expect(classify(path)).toEqual({ kind: "retired" });
    }
  });

  test("a prototype's files and the template are the tree", () => {
    expect(classify(`${ID}/index.html`)).toEqual({ kind: "tree" });
    expect(classify(`_template/index.html`)).toEqual({ kind: "tree" });
  });
});
