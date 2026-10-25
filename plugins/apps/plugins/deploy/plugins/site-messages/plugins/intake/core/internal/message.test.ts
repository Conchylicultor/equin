import { describe, expect, test } from "bun:test";
import {
  MAX_MESSAGE_LENGTH,
  MAX_REPLY_TO_LENGTH,
  SiteMessageBodySchema,
} from "./message";

const VALID = {
  message: "Hello",
  replyTo: "visitor@example.com",
  honeypot: "",
  elapsedMs: 5000,
  host: "equin.ai",
  page: "/",
};

const parses = (over: Record<string, unknown>) =>
  SiteMessageBodySchema.safeParse({ ...VALID, ...over }).success;

describe("SiteMessageBodySchema", () => {
  test("a valid body parses, the message trimmed and the page's query dropped", () => {
    expect(
      SiteMessageBodySchema.parse({
        ...VALID,
        message: "  hi  ",
        page: "/a?b=c",
      }),
    ).toMatchObject({ message: "hi", page: "/a" });
  });

  test("a message is 1–5000 characters after trimming", () => {
    expect(parses({ message: "   " })).toBe(false);
    expect(parses({ message: "x".repeat(MAX_MESSAGE_LENGTH) })).toBe(true);
    expect(parses({ message: "x".repeat(MAX_MESSAGE_LENGTH + 1) })).toBe(false);
    expect(parses({ message: ` ${"x".repeat(MAX_MESSAGE_LENGTH)} ` })).toBe(
      true,
    );
  });

  test("the reply-to is an email of at most 254 characters", () => {
    expect(parses({ replyTo: "not an email" })).toBe(false);
    expect(parses({ replyTo: "" })).toBe(false);
    const long = `${"a".repeat(MAX_REPLY_TO_LENGTH - "@example.com".length + 1)}@example.com`;
    expect(parses({ replyTo: long })).toBe(false);
  });

  test("elapsedMs is a non-negative integer, at most a day", () => {
    expect(parses({ elapsedMs: -1 })).toBe(false);
    expect(parses({ elapsedMs: 1.5 })).toBe(false);
    expect(parses({ elapsedMs: 86_400_001 })).toBe(false);
    expect(parses({ elapsedMs: "5000" })).toBe(false);
  });

  test("unknown fields are refused", () => {
    expect(parses({ ip: "1.2.3.4" })).toBe(false);
  });

  test("a missing honeypot is refused (the form always sends it)", () => {
    expect(
      SiteMessageBodySchema.safeParse({
        message: VALID.message,
        replyTo: VALID.replyTo,
        elapsedMs: VALID.elapsedMs,
        host: VALID.host,
        page: VALID.page,
      }).success,
    ).toBe(false);
  });
});
