/**
 * claude-cli-calls's derived fields: the ids every list, saved view and filter preset names
 * are unchanged, and the columns it filters / sorts are the ones it declared
 * before its fields were derived.
 *
 * Run: `./singularity test plugins/infra/plugins/claude-cli`.
 */

import { describe, expect, test } from "bun:test";
import { claudeCliCalls } from "./resources";

describe("claude-cli-calls fields", () => {
  test("the list fields keep their ids, in order", () => {
    expect(Object.keys(claudeCliCalls.fields)).toEqual([
      "status",
      "createdAt",
      "sourceName",
      "model",
      "durationMs",
      "prompt",
      "output",
      "error",
    ]);
  });

  test("the filterable columns are the declared ones", () => {
    expect(Object.keys(claudeCliCalls.filterable).sort()).toEqual(
      [
        "status",
        "createdAt",
        "sourceName",
        "model",
        "durationMs",
        "prompt",
        "output",
        "error",
      ].sort(),
    );
  });

  test("the sortable columns are the declared ones", () => {
    expect([...claudeCliCalls.sortable]).toEqual([
      "createdAt",
      "durationMs",
      "sourceName",
      "model",
    ]);
  });
});
