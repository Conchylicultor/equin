/**
 * `parseTrailerLog` — the reader half of the trailer grammar, ported (with its
 * behaviour) from the ledger ingest's original `parseLog`. The records here are exactly
 * what `git log --format=TRAILER_LOG_FORMAT` emits: NUL-separated fields, each
 * record terminated by a NUL then a newline.
 */
import { test, expect } from "bun:test";
import {
  CONVERSATION_TRAILER_KEY,
  PUSH_TRAILER_KEY,
  TRAILER_LOG_FORMAT,
  parseTrailerLog,
} from "./trailers";

function record(fields: string[]): string {
  return `${fields.join("\0")}\0\n`;
}

const ISO = "2026-08-17T10:00:00+02:00";

test("the format fragment names both trailer keys", () => {
  expect(TRAILER_LOG_FORMAT).toContain(`key=${CONVERSATION_TRAILER_KEY}`);
  expect(TRAILER_LOG_FORMAT).toContain(`key=${PUSH_TRAILER_KEY}`);
});

test("NUL-delimited records parse, in log order", () => {
  const raw =
    record(["sha1", ISO, "conv-a", "push-1", "first subject"]) +
    record(["sha2", ISO, "conv-b", "push-2", "second subject"]);
  const parsed = parseTrailerLog(raw);
  expect(parsed.map((c) => c.sha)).toEqual(["sha1", "sha2"]);
  expect(parsed[0]).toMatchObject({
    conversationId: "conv-a",
    pushId: "push-1",
    subject: "first subject",
  });
  expect(parsed[0]?.committedAt.toISOString()).toBe(
    new Date(ISO).toISOString(),
  );
});

test("a commit missing the conversation trailer is skipped", () => {
  const raw = record(["sha1", ISO, "", "push-1", "subject"]);
  expect(parseTrailerLog(raw)).toEqual([]);
});

test("a commit missing the push trailer is skipped", () => {
  const raw = record(["sha1", ISO, "conv-a", "", "subject"]);
  expect(parseTrailerLog(raw)).toEqual([]);
});

test("whitespace-only trailer values are skipped, values are trimmed", () => {
  expect(parseTrailerLog(record(["sha1", ISO, "   ", "push-1", "s"]))).toEqual(
    [],
  );
  const [only] = parseTrailerLog(
    record(["sha1", ISO, " conv-a ", " push-1 ", "s"]),
  );
  expect(only).toMatchObject({ conversationId: "conv-a", pushId: "push-1" });
});

test("a truncated record (too few fields) is skipped, not half-read", () => {
  expect(parseTrailerLog(record(["sha1", ISO, "conv-a"]))).toEqual([]);
});

test("an empty log is an empty list", () => {
  expect(parseTrailerLog("")).toEqual([]);
});

test("a subject is optional — an empty one still yields the commit", () => {
  const [c] = parseTrailerLog(record(["sha1", ISO, "conv-a", "push-1", ""]));
  expect(c).toMatchObject({ sha: "sha1", subject: "" });
});

test("multiple values of one trailer key shift the fields — a known quirk", () => {
  // `separator=%x00` means a commit carrying the conversation trailer TWICE emits
  // both values into the conversation field's slot, pushing every later field
  // right. The parse then reads the second conversation id as the push id. This is
  // the ported behaviour, kept deliberately: the writer half stamps exactly one of
  // each (the shell hook from SINGULARITY_CONVERSATION_ID, the push CLI per
  // invocation), so no commit `./equin push` produces can reach it. Pinned
  // here so a future fix is a deliberate change with a failing test, not a
  // surprise.
  const raw = record(["sha1", ISO, "conv-a", "conv-b", "push-1", "subject"]);
  const [c] = parseTrailerLog(raw);
  expect(c).toMatchObject({ conversationId: "conv-a", pushId: "conv-b" });
});
