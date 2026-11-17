import { describe, expect, test } from "bun:test";
import { BotChallengeError } from "./bot-challenge";

// This error is a cross-plugin contract in two directions at once: `refresh`'s
// classifier reads its NAME, and the user reads its MESSAGE off the source row
// after the run ledger truncated it to 300 characters. Both are pinned here.

/** `shortMessage`'s ceiling in `refresh/server/internal/classify-error.ts`. */
const MAX_MESSAGE_LEN = 300;

describe("BotChallengeError", () => {
  test("its name is the contract the classifier matches on", () => {
    // Never `instanceof`, and never inherited from `NonRetryableError` — see the
    // class comment. A rename here silently downgrades a terminal refusal to a
    // retry-forever.
    const err = BotChallengeError.inPlainMode(429, {
      signal: "x-vercel-mitigated: challenge",
    });
    expect(err.name).toBe("BotChallengeError");
    expect(err).toBeInstanceOf(Error);
  });

  test("it is NOT branded as a NonRetryableError", () => {
    // `run-source` skips its wrap branch for an already-branded error, so
    // inheriting the brand would drop the classification before it reached the
    // source row.
    const err = BotChallengeError.afterRender(403, null);
    expect(err.name).not.toBe("NonRetryableError");
    const brand = Object.getOwnPropertySymbols(err).map(String);
    expect(brand.join(",")).not.toContain("NonRetryable");
  });

  test("plain mode names the field and the value to put in it", () => {
    const err = BotChallengeError.inPlainMode(429, {
      signal: "x-vercel-mitigated: challenge",
    });
    expect(err.message).toBe(
      'This page answers automated requests with a bot challenge (HTTP 429, x-vercel-mitigated: challenge). Set this source\'s Fetch mode to "Browser render" to load it in a real browser.',
    );
  });

  test("after a render it says there is nothing left to try", () => {
    const err = BotChallengeError.afterRender(429, {
      signal: "x-vercel-mitigated: challenge",
    });
    expect(err.message).toBe(
      "A bot challenge blocks this page and a real browser did not get past it either (in a browser: HTTP 429, x-vercel-mitigated: challenge). This page cannot be read automatically — remove the source, or point it at a URL that is not behind the challenge.",
    );
  });

  test("an unattributable browser refusal quotes no header it did not see", () => {
    // A bare 403/429 from a real browser is still a refusal — it is just one we
    // cannot name a vendor for, and naming one anyway would be a guess printed
    // as evidence.
    const err = BotChallengeError.afterRender(403, null);
    expect(err.message).toContain("in a browser: HTTP 403)");
    expect(err.mitigation).toBeNull();
  });

  test("both messages fit the run ledger's 300-character ceiling", () => {
    // The remedy sits BEFORE any URL in both, so if anything is ever cut it is
    // the part the user does not need.
    const long = { signal: "x-vercel-mitigated: challenge" };
    expect(
      BotChallengeError.inPlainMode(429, long).message.length,
    ).toBeLessThanOrEqual(MAX_MESSAGE_LEN);
    expect(
      BotChallengeError.afterRender(429, long).message.length,
    ).toBeLessThanOrEqual(MAX_MESSAGE_LEN);
  });

  test("the evidence it saw travels with it", () => {
    const err = BotChallengeError.inPlainMode(503, {
      signal: "cf-mitigated: challenge",
    });
    expect(err.status).toBe(503);
    expect(err.mitigation).toEqual({ signal: "cf-mitigated: challenge" });
  });
});
