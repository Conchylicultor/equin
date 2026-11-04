import { describe, expect, test } from "bun:test";
import { LOG_FILE_RE, liveLogPath, logPatternMatches } from "./log-claims";

describe("logPatternMatches", () => {
  test("a pattern matches its file and every numbered rotation", () => {
    expect(logPatternMatches("op-log.jsonl", "op-log.jsonl")).toBe(true);
    expect(logPatternMatches("op-log.jsonl", "op-log.jsonl.3")).toBe(true);
    expect(logPatternMatches("op-log.jsonl", "op-log.jsonl.x")).toBe(false);
  });

  test("* stays inside one segment; ** crosses them", () => {
    expect(logPatternMatches("*.log", "att-1.log.2")).toBe(true);
    expect(logPatternMatches("*.log", "services/postgres.log")).toBe(false);
    expect(logPatternMatches("services/*.log", "services/postgres.log.1")).toBe(
      true,
    );
    expect(logPatternMatches("**", "captures/a/b.log")).toBe(true);
  });

  test("regex metacharacters in a pattern are literal", () => {
    expect(logPatternMatches("a.log", "axlog")).toBe(false);
  });
});

test("LOG_FILE_RE and liveLogPath agree on what a rotation is", () => {
  expect(LOG_FILE_RE.test("x.log.12")).toBe(true);
  expect(LOG_FILE_RE.test("x.jsonl")).toBe(true);
  expect(LOG_FILE_RE.test("x.json")).toBe(false);
  expect(liveLogPath("a/b.jsonl.12")).toBe("a/b.jsonl");
});
