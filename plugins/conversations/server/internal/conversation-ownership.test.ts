import { describe, expect, test } from "bun:test";
import { isOwnConversation } from "./conversation-ownership";

const at = (iso: string) => ({ createdAt: new Date(iso) });

describe("isOwnConversation", () => {
  test("a database never forked owns every conversation", () => {
    expect(isOwnConversation(at("2020-01-01T00:00:00Z"), null)).toBe(true);
  });

  test("a fork owns only what was created after its fork point", () => {
    const forkedAt = new Date("2026-10-25T12:00:00Z");
    expect(isOwnConversation(at("2026-10-25T11:59:59Z"), forkedAt)).toBe(false);
    expect(isOwnConversation(at("2026-10-25T12:00:00Z"), forkedAt)).toBe(false);
    expect(isOwnConversation(at("2026-10-25T12:00:01Z"), forkedAt)).toBe(true);
  });
});
