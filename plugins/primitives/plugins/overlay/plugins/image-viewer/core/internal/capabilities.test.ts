import { describe, expect, it } from "bun:test";
import { dataUriToBlob, dataUriType, imageCapabilities } from "./capabilities";

const ORIGIN = "http://equin.localhost:9000";
const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("imageCapabilities", () => {
  it("lets data: images be copied and downloaded, and opened through a blob: URL", () => {
    expect(imageCapabilities(PNG_1PX, ORIGIN)).toEqual({
      open: "blob-url",
      copy: true,
      download: true,
    });
  });

  it("never opens an SVG data: image, whose script would run in the app's origin", () => {
    expect(
      imageCapabilities("data:image/svg+xml;utf8,<svg/>", ORIGIN).open,
    ).toBe("none");
  });

  it("gives blob: and same-origin images every action", () => {
    expect(imageCapabilities(`blob:${ORIGIN}/0b1c`, ORIGIN)).toEqual({
      open: "url",
      copy: true,
      download: true,
    });
    expect(imageCapabilities("/api/code/wt/image?path=a.png", ORIGIN)).toEqual({
      open: "url",
      copy: true,
      download: true,
    });
    expect(imageCapabilities(`${ORIGIN}/a.png`, ORIGIN).copy).toBe(true);
  });

  it("gives another site's image only 'Open original'", () => {
    expect(imageCapabilities("https://example.com/a.png", ORIGIN)).toEqual({
      open: "url",
      copy: false,
      download: false,
    });
    // A different port is a different origin.
    expect(
      imageCapabilities("http://equin.localhost:9001/a.png", ORIGIN).copy,
    ).toBe(false);
  });

  it("offers nothing for an address it cannot safely open", () => {
    expect(imageCapabilities("javascript:alert(1)", ORIGIN)).toEqual({
      open: "none",
      copy: false,
      download: false,
    });
  });
});

describe("dataUriToBlob", () => {
  it("decodes a base64 payload to bytes of the declared type", async () => {
    const blob = dataUriToBlob(PNG_1PX);
    expect(blob.type).toBe("image/png");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // The PNG signature.
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("decodes a percent-encoded payload", async () => {
    const blob = dataUriToBlob("data:image/svg+xml,%3Csvg%2F%3E");
    expect(await blob.text()).toBe("<svg/>");
    expect(dataUriType("data:image/svg+xml,%3Csvg%2F%3E")).toBe(
      "image/svg+xml",
    );
  });

  it("throws on something that is not a data: URI", () => {
    expect(() => dataUriToBlob("https://example.com/a.png")).toThrow();
    expect(() => dataUriToBlob("data:image/png;base64")).toThrow();
  });
});
