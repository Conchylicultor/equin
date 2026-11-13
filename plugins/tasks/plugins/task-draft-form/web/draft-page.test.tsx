import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DraftPageProvider, NO_DRAFT_PAGE, useDraftPage } from "./draft-page";

function Probe() {
  const { readUrl, picker } = useDraftPage();
  return (
    <i>{`${readUrl === null ? "no-url" : "url"},${picker?.kind ?? "none"}`}</i>
  );
}

describe("useDraftPage", () => {
  it("is this document by default: a URL to read, picked in place", () => {
    expect(renderToStaticMarkup(<Probe />)).toBe("<i>url,in-page</i>");
  });

  it("is what a provider declares — no page at all", () => {
    expect(
      renderToStaticMarkup(
        <DraftPageProvider value={NO_DRAFT_PAGE}>
          <Probe />
        </DraftPageProvider>,
      ),
    ).toBe("<i>no-url,none</i>");
  });

  it("is what a provider declares — a page elsewhere", () => {
    expect(
      renderToStaticMarkup(
        <DraftPageProvider
          value={{
            readUrl: () => "https://example.com/",
            picker: { kind: "remote", pick: () => Promise.reject(new Error()) },
          }}
        >
          <Probe />
        </DraftPageProvider>,
      ),
    ).toBe("<i>url,remote</i>");
  });
});
