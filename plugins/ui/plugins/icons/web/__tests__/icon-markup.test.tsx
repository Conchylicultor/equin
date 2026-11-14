import { afterEach, describe, expect, it } from "vitest";
import { useMemo } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { symbol } from "../../core/icon-ref";
import { glyphId } from "../../core";
import { useIconMarkup } from "../internal/icon-markup";
import { pageRuntimeSymbols } from "../internal/runtime-symbol-store";

/**
 * `useIconMarkup`'s reader is a function of what the stores hold: a read
 * memoized on the reader (as `useMemo` or the React Compiler memoizes one) is
 * re-read once its glyph lands — never a `pending` held forever.
 */

afterEach(() => cleanup());

const sailing = symbol("sailing");

const readers: unknown[] = [];

function Glyph({ tick }: { tick: number }) {
  const read = useIconMarkup();
  readers.push(read);
  // Keyed on the reader only, exactly as the React Compiler caches a read.
  const markup = useMemo(() => read(sailing, { active: false }), [read]);
  return (
    <span data-testid="kind" data-tick={tick}>
      {markup.kind}
    </span>
  );
}

describe("useIconMarkup", () => {
  it("keeps one reader while nothing lands, and hands out a new one when a glyph does", () => {
    const { getByTestId, rerender } = render(<Glyph tick={0} />);
    expect(getByTestId("kind").textContent).toBe("pending");
    rerender(<Glyph tick={1} />);
    // Stable while the stores hold the same: a memoized consumer is not re-run.
    expect(readers.at(-1)).toBe(readers.at(-2));
    const id = glyphId("default-outline-400", "sailing");
    act(() => {
      pageRuntimeSymbols.provide(
        "icon-markup-test",
        `<svg><symbol id="${id}" viewBox="0 0 24 24"><path d="M0 0h24v24z"/></symbol></svg>`,
        [{ key: "default-outline-400", name: "sailing" }],
      );
    });
    expect(readers.at(-1)).not.toBe(readers.at(-2));
    expect(getByTestId("kind").textContent).toBe("ready");
  });
});
