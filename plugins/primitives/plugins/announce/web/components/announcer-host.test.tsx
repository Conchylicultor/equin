import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { announce } from "../internal/announcer-store";
import { AnnouncerHost } from "./announcer-host";

// A static render to HTML (react-dom/server, no DOM) reads the live regions'
// contents as the store holds them: it must not throw.
describe("AnnouncerHost under a server render", () => {
  it("renders both regions with what the store holds", () => {
    announce("Saved");
    const html = renderToStaticMarkup(<AnnouncerHost />);
    expect(html).toContain('role="status"');
    expect(html).toContain('role="alert"');
    expect(html).toContain(">Saved</div>");
  });
});
