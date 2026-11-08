import { describe, expect, test } from "bun:test";
import { bellKeyOf, fixNoticeOf } from "./fix-notice";

const commit = "51f9fdf123456789";

describe("fixNoticeOf", () => {
  test("an open report says nothing of a fix", () => {
    expect(fixNoticeOf({ fixState: "open", fixCommit: null })).toBeNull();
  });
  test("each state's line names the fix's short commit", () => {
    expect(fixNoticeOf({ fixState: "pending", fixCommit: commit })).toEqual({
      tone: "pending",
      text: "Fix on its way: 51f9fdf12",
    });
    expect(fixNoticeOf({ fixState: "fixed", fixCommit: commit })?.tone).toBe(
      "resolved",
    );
    expect(fixNoticeOf({ fixState: "regressed", fixCommit: commit })).toEqual({
      tone: "recurred",
      text: "Came back after 51f9fdf12",
    });
  });
});

describe("bellKeyOf", () => {
  test("a regression rings on its own key; every other state on the report's", () => {
    const id = "report-1";
    expect(bellKeyOf({ id, fixState: "fixed", fixCommit: commit })).toBe(id);
    expect(bellKeyOf({ id, fixState: "regressed", fixCommit: commit })).toBe(
      `${id}:regressed:${commit}`,
    );
  });
});
