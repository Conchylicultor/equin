import { describe, expect, test } from "bun:test";
import type { TurnKind } from "@plugins/conversations/plugins/turn-ledger/core";
import { latestUserTurnId } from "./follow-key";

const t = (id: string, kind: TurnKind) => ({ id, kind });

describe("latestUserTurnId", () => {
  test("the newest turn the user sent", () => {
    expect(latestUserTurnId([t("a", "turn"), t("b", "turn")])).toBe("b");
  });

  test("an automatic turn after it is not the user acting", () => {
    // A watched task started: its event turn queues behind the user's.
    expect(
      latestUserTurnId([t("a", "turn"), t("e", "event"), t("c", "compact")]),
    ).toBe("a");
  });

  test("none: only automatic turns, or no cards", () => {
    expect(latestUserTurnId([t("e", "event"), t("l", "launch")])).toBeNull();
    expect(latestUserTurnId([])).toBeNull();
  });
});
