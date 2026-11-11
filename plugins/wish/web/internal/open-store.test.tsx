import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  insertIntoWishDraft,
  setWishOpen,
  useWishOpenState,
} from "./open-store";

function Probe() {
  const { open, insert } = useWishOpenState();
  return <i>{`${String(open)},${insert === undefined ? "none" : "insert"}`}</i>;
}

// A static render to HTML (react-dom/server, no DOM) reads the store as it
// stands.
describe("useWishOpenState under a server render", () => {
  it("answers closed with nothing pending", () => {
    expect(renderToStaticMarkup(<Probe />)).toBe("<i>false,none</i>");
  });

  it("answers what a caller opened it with", () => {
    insertIntoWishDraft("hello");
    try {
      expect(renderToStaticMarkup(<Probe />)).toBe("<i>true,insert</i>");
    } finally {
      setWishOpen(false);
    }
  });
});
