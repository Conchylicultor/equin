import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createRevealStore,
  usePendingReveal,
  type RevealStore,
} from "./reveal-store";

function Probe({ store }: { store: RevealStore }) {
  const pending = usePendingReveal(store);
  return (
    <i>
      {pending === null ? "none" : `${pending.sectionId}@${String(pending.at)}`}
    </i>
  );
}

// A static render to HTML (react-dom/server, no DOM) reads the reveal store
// as it stands: it must not throw.
describe("usePendingReveal under a server render", () => {
  it("reads no reveal when none was requested", () => {
    expect(renderToStaticMarkup(<Probe store={createRevealStore()} />)).toBe(
      "<i>none</i>",
    );
  });

  it("reads a pending reveal requested before the render", () => {
    const store = createRevealStore();
    store.set({ sectionId: "notes", at: 5 });
    expect(renderToStaticMarkup(<Probe store={store} />)).toBe(
      "<i>notes@5</i>",
    );
  });
});
