import { describe, expect, test } from "bun:test";
import { userPromptText } from "./user-prompt";

const userLine = (content: unknown) => ({
  type: "user",
  uuid: "u1",
  message: { role: "user", content },
});

describe("userPromptText", () => {
  test("a typed message is the user's", () => {
    expect(userPromptText(userLine("fix the build"))).toBe("fix the build");
  });

  test("an event turn the app delivered is not — a rewind never cuts at it", () => {
    expect(
      userPromptText(userLine("<equin-event>\nreported\n</equin-event>")),
    ).toBe(null);
    expect(
      userPromptText(
        userLine([
          { type: "text", text: "<equin-event>\nreported\n</equin-event>" },
        ]),
      ),
    ).toBe(null);
  });
});
