import { describe, expect, it } from "bun:test";
import { fullscreenSupport } from "./fullscreen-support";

/** A document as far as fullscreen detection reads one. */
function fakeDocument(opts: {
  fullscreenEnabled?: boolean;
  hasMethod: boolean;
}): Document {
  const documentElement = opts.hasMethod
    ? { requestFullscreen: () => Promise.resolve() }
    : {};
  return {
    fullscreenEnabled: opts.fullscreenEnabled,
    documentElement,
  } as unknown as Document;
}

describe("fullscreenSupport", () => {
  it("is unsupported on a browser without the API (an iPhone)", () => {
    const doc = fakeDocument({ hasMethod: false });
    expect(fullscreenSupport(doc).kind).toBe("unsupported");
  });

  it("is unsupported in a frame that may not use it", () => {
    const doc = fakeDocument({ fullscreenEnabled: false, hasMethod: true });
    expect(fullscreenSupport(doc).kind).toBe("unsupported");
  });

  it("is unsupported when the flag is there but the method is not", () => {
    const doc = fakeDocument({ fullscreenEnabled: true, hasMethod: false });
    expect(fullscreenSupport(doc).kind).toBe("unsupported");
  });

  it("requests through the element where supported, one answer per document", () => {
    const doc = fakeDocument({ fullscreenEnabled: true, hasMethod: true });
    const support = fullscreenSupport(doc);
    expect(support.kind).toBe("supported");
    expect(fullscreenSupport(doc)).toBe(support);
    let asked = 0;
    const el = { requestFullscreen: () => (asked++, Promise.resolve()) };
    if (support.kind !== "supported") throw new Error("unreachable");
    void support.request(el as unknown as Element);
    expect(asked).toBe(1);
  });
});
