import { describe, expect, test } from "bun:test";
import { classifyTreePath } from "./tree-path";

const ROOT = "/data/apps/prototypes";
const ID = "proto-1789000000-abcd";

describe("classifyTreePath", () => {
  test("a history's latest stamp is a recorded version of that id", () => {
    expect(
      classifyTreePath(ROOT, `${ROOT}/_history/${ID}.git/latest.json`),
    ).toEqual({ kind: "version-recorded", id: ID });
  });

  test("anything else under _history is internal", () => {
    for (const path of [
      `${ROOT}/_history/.staging-${ID}-x1/latest.json`,
      `${ROOT}/_history/${ID}.git/info/latest.json`,
      `${ROOT}/_history/not-an-id.git/latest.json`,
      `${ROOT}/_history/${ID}.lock`,
    ]) {
      expect(classifyTreePath(ROOT, path)).toEqual({
        kind: "history-internal",
      });
    }
  });

  test("a picks file is that id's picks changing", () => {
    expect(classifyTreePath(ROOT, `${ROOT}/_picks/${ID}.json`)).toEqual({
      kind: "picks-recorded",
      id: ID,
    });
  });

  test("anything else under _picks is internal", () => {
    for (const path of [
      `${ROOT}/_picks/${ID}.json.tmp`,
      `${ROOT}/_picks/${ID}.lock`,
      `${ROOT}/_picks/not-an-id.json`,
      `${ROOT}/_picks/nested/${ID}.json`,
      `${ROOT}/_picks`,
    ]) {
      expect(classifyTreePath(ROOT, path)).toEqual({ kind: "picks-internal" });
    }
  });

  test("anything under the retired _status dir is nothing to react to", () => {
    for (const path of [
      `${ROOT}/_status/${ID}.json`,
      `${ROOT}/_status/${ID}.lock`,
      `${ROOT}/_status`,
    ]) {
      expect(classifyTreePath(ROOT, path)).toEqual({ kind: "retired" });
    }
  });

  test("a prototype's files and the template are the tree", () => {
    expect(classifyTreePath(ROOT, `${ROOT}/${ID}/index.html`)).toEqual({
      kind: "tree",
    });
    expect(classifyTreePath(ROOT, `${ROOT}/_template/index.html`)).toEqual({
      kind: "tree",
    });
  });
});
