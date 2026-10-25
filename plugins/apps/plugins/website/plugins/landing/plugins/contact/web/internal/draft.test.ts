import { describe, expect, test } from "bun:test";
import {
  EMPTY_DRAFT,
  canSend,
  messageBody,
  phaseAfter,
  waitText,
} from "./draft";

describe("canSend", () => {
  test("needs a message and a valid address", () => {
    expect(canSend(EMPTY_DRAFT)).toBe(false);
    expect(canSend({ ...EMPTY_DRAFT, message: "hi" })).toBe(false);
    expect(canSend({ ...EMPTY_DRAFT, message: "hi", email: "nope" })).toBe(
      false,
    );
    expect(canSend({ ...EMPTY_DRAFT, message: "   ", email: "a@b.co" })).toBe(
      false,
    );
    expect(canSend({ ...EMPTY_DRAFT, message: "hi", email: " a@b.co " })).toBe(
      true,
    );
  });
});

describe("messageBody", () => {
  test("trims, rounds the elapsed time and takes the page it was sent from", () => {
    expect(
      messageBody(
        { message: " hi ", email: " a@b.co ", honeypot: "" },
        4321.7,
        { host: "equin.ai", page: "/" },
      ),
    ).toEqual({
      message: "hi",
      replyTo: "a@b.co",
      honeypot: "",
      elapsedMs: 4322,
      host: "equin.ai",
      page: "/",
    });
  });
});

describe("phaseAfter", () => {
  test("sent thanks the address; rate-limited keeps composing with a notice", () => {
    expect(phaseAfter({ kind: "sent" }, "a@b.co")).toEqual({
      kind: "sent",
      replyTo: "a@b.co",
    });
    expect(
      phaseAfter({ kind: "rate-limited", retryAfterS: 90 }, "a@b.co"),
    ).toEqual({
      kind: "compose",
      notice: { kind: "rate-limited", retryAfterS: 90 },
    });
  });
});

describe("waitText", () => {
  test("rounds up to a minute, then to hours", () => {
    expect(waitText(5)).toBe("a minute");
    expect(waitText(420)).toBe("7 minutes");
    expect(waitText(3600)).toBe("an hour");
    expect(waitText(14 * 3600 - 30)).toBe("14 hours");
  });
});
