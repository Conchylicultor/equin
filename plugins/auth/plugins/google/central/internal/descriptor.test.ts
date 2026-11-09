import { describe, expect, test } from "bun:test";
import { diagnoseGoogleRefreshFailure } from "./descriptor";

const DAY_MS = 24 * 60 * 60 * 1000;
const INVALID_GRANT =
  '{"error": "invalid_grant", "error_description": "Token has been expired or revoked."}';

describe("diagnoseGoogleRefreshFailure", () => {
  test("names Testing mode for invalid_grant just past 7 days", () => {
    const hint = diagnoseGoogleRefreshFailure({
      responseText: INVALID_GRANT,
      grantAgeMs: 7 * DAY_MS + 3 * 60 * 60 * 1000,
    });
    expect(hint).toContain("Testing");
  });

  test("makes no claim before or well after the 7-day mark", () => {
    for (const days of [2, 6, 12]) {
      expect(
        diagnoseGoogleRefreshFailure({
          responseText: INVALID_GRANT,
          grantAgeMs: days * DAY_MS,
        }),
      ).toBeUndefined();
    }
  });

  test("makes no claim for another error", () => {
    expect(
      diagnoseGoogleRefreshFailure({
        responseText: '{"error": "invalid_client"}',
        grantAgeMs: 7 * DAY_MS + 1,
      }),
    ).toBeUndefined();
  });
});
