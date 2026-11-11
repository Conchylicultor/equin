import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useDraftMap, type SurfaceDrafts } from "./view-drafts";

/** A surface whose storage would hand back a working copy, counting reads. */
function surface(): SurfaceDrafts & { reads: number } {
  const s = {
    reads: 0,
    read() {
      s.reads += 1;
      return { list: { type: "list" } };
    },
    write() {},
    subscribe: () => () => {},
  };
  return s;
}

function Probe({ drafts, on }: { drafts: SurfaceDrafts; on: boolean }) {
  return <i>{JSON.stringify(useDraftMap(drafts, on))}</i>;
}

// A static render to HTML (react-dom/server, no DOM, no session storage)
// belongs to no tab: no tab's working copies apply, and storage is never read.
describe("useDraftMap under a server render", () => {
  it("reads no drafts, without touching the surface's storage", () => {
    const drafts = surface();
    expect(renderToStaticMarkup(<Probe drafts={drafts} on />)).toBe(
      "<i>{}</i>",
    );
    expect(drafts.reads).toBe(0);
  });

  it("reads no drafts on a surface that keeps none", () => {
    expect(renderToStaticMarkup(<Probe drafts={surface()} on={false} />)).toBe(
      "<i>{}</i>",
    );
  });
});
