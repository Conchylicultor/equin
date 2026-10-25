import { describe, expect, test } from "bun:test";
import { parseResendResponse, resendRequestBody } from "./send-email";

describe("parseResendResponse", () => {
  test("a 200 with an id is sent", () => {
    expect(parseResendResponse(200, JSON.stringify({ id: "abc-123" }))).toEqual(
      { ok: true, id: "abc-123" },
    );
  });

  test("a 2xx without an id is a failure, never an empty id", () => {
    const result = parseResendResponse(200, JSON.stringify({}));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(200);
      expect(result.error).toContain("without an email id");
    }
  });

  test("an error body keeps Resend's own name and message", () => {
    expect(
      parseResendResponse(
        403,
        JSON.stringify({
          statusCode: 403,
          name: "validation_error",
          message: "The equin.ai domain is not verified.",
        }),
      ),
    ).toEqual({
      ok: false,
      status: 403,
      error: "validation_error: The equin.ai domain is not verified.",
    });
  });

  test("a non-JSON answer names its head", () => {
    const result = parseResendResponse(502, "<html>Bad Gateway</html>");
    expect(result).toEqual({
      ok: false,
      status: 502,
      error: "Not JSON: <html>Bad Gateway</html>",
    });
  });

  test("JSON that is not Resend's error shape keeps the raw body", () => {
    expect(parseResendResponse(500, JSON.stringify({ oops: 1 }))).toEqual({
      ok: false,
      status: 500,
      error: '{"oops":1}',
    });
  });
});

describe("resendRequestBody", () => {
  test("uses Resend's field names, the recipient as a list", () => {
    expect(
      JSON.parse(
        resendRequestBody({
          from: "equin <noreply@equin.ai>",
          to: "hello@equin.ai",
          replyTo: "visitor@example.com",
          subject: "Hi",
          text: "Body",
        }),
      ),
    ).toEqual({
      from: "equin <noreply@equin.ai>",
      to: ["hello@equin.ai"],
      reply_to: "visitor@example.com",
      subject: "Hi",
      text: "Body",
    });
  });
});
