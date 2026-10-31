import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { TurnKind } from "@plugins/conversations/plugins/turn-ledger/core";
import { useSentTurnFollowKey } from "../internal/follow-key";

type Card = { id: string; kind: TurnKind };
const t = (id: string, kind: TurnKind): Card => ({ id, kind });

describe("useSentTurnFollowKey", () => {
  it("moves only when the user sends a turn", () => {
    const { result, rerender } = renderHook(
      ({ turns }: { turns: Card[] }) => useSentTurnFollowKey(turns),
      { initialProps: { turns: [] as Card[] } },
    );
    expect(result.current).toBeUndefined();

    // Watched tasks starting: event turns come and go.
    rerender({ turns: [t("e1", "event")] });
    rerender({ turns: [t("e1", "event"), t("e2", "event")] });
    rerender({ turns: [] });
    expect(result.current).toBeUndefined();

    rerender({ turns: [t("a", "turn")] });
    expect(result.current).toBe("a");

    // A second send, then it retires before the first: the key holds.
    rerender({ turns: [t("a", "turn"), t("b", "turn")] });
    expect(result.current).toBe("b");
    rerender({ turns: [t("a", "turn")] });
    expect(result.current).toBe("b");
    rerender({ turns: [t("e3", "event")] });
    expect(result.current).toBe("b");
  });

  it("a turn already pending at mount is not a new send", () => {
    const { result } = renderHook(() => useSentTurnFollowKey([t("a", "turn")]));
    expect(result.current).toBe("a");
  });
});
