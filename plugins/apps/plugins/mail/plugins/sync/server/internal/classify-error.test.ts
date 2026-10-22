import { describe, expect, test } from "bun:test";
import { GmailApiError } from "@plugins/apps/plugins/mail/plugins/gmail-api/core";
import { RetryDeadlineError } from "@plugins/packages/plugins/retry/core";
import { GmailTokenUnavailableError } from "@plugins/apps/plugins/mail/plugins/mail-core/core";
import { classifyMailSyncError } from "./classify-error";

describe("classifyMailSyncError", () => {
  test("token-unavailable → auth/terminal", () => {
    const c = classifyMailSyncError(
      new GmailTokenUnavailableError("not connected"),
    );
    expect(c.code).toBe("auth");
    expect(c.terminal).toBe(true);
  });

  test("401 → auth/terminal", () => {
    const c = classifyMailSyncError(new GmailApiError(401, "Unauthorized"));
    expect(c).toMatchObject({ code: "auth", terminal: true });
  });

  test("403 accessNotConfigured → api_disabled/terminal", () => {
    const c = classifyMailSyncError(
      new GmailApiError(403, "Gmail API has not been used", "accessNotConfigured"),
    );
    expect(c).toMatchObject({ code: "api_disabled", terminal: true });
  });

  test("403 with disabled message (no reason) → api_disabled", () => {
    const c = classifyMailSyncError(
      new GmailApiError(403, "Gmail API is disabled for this project"),
    );
    expect(c.code).toBe("api_disabled");
  });

  test("403 insufficientPermissions → auth/terminal", () => {
    const c = classifyMailSyncError(
      new GmailApiError(403, "Request had insufficient authentication scopes", "insufficientPermissions"),
    );
    expect(c).toMatchObject({ code: "auth", terminal: true });
  });

  test("403 otherwise → unknown/terminal", () => {
    const c = classifyMailSyncError(new GmailApiError(403, "Forbidden", "someOther"));
    expect(c).toMatchObject({ code: "unknown", terminal: true });
  });

  test("429 → quota/non-terminal", () => {
    const c = classifyMailSyncError(new GmailApiError(429, "Too many requests"));
    expect(c).toMatchObject({ code: "quota", terminal: false });
  });

  test("5xx → unknown/non-terminal", () => {
    const c = classifyMailSyncError(new GmailApiError(503, "Backend error"));
    expect(c).toMatchObject({ code: "unknown", terminal: false });
  });

  test("400 → unknown/terminal", () => {
    const c = classifyMailSyncError(new GmailApiError(400, "Bad request"));
    expect(c).toMatchObject({ code: "unknown", terminal: true });
  });

  test("RetryDeadlineError → quota/non-terminal", () => {
    const c = classifyMailSyncError(new RetryDeadlineError(120_000));
    expect(c).toMatchObject({ code: "quota", terminal: false });
  });

  test("unknown error → unknown/non-terminal", () => {
    const c = classifyMailSyncError(new Error("boom"));
    expect(c).toMatchObject({ code: "unknown", terminal: false });
  });

  test("message is capped at ~200 chars", () => {
    const c = classifyMailSyncError(new Error("x".repeat(500)));
    expect(c.message.length).toBeLessThanOrEqual(200);
  });
});
