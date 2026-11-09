import { describe, expect, it } from "vitest";
import { cloneWithScroll } from "../clone-with-scroll";

describe("cloneWithScroll", () => {
  it("copies frames and media as empty boxes that load nothing", () => {
    const source = document.createElement("div");
    source.innerHTML = `
      <iframe class="frame" src="blob:x/1" srcdoc="<p>x</p>"></iframe>
      <video class="video" src="/v.mp4" poster="/p.png"><source src="/v.webm"><track src="/t.vtt"></video>
      <object class="pdf" data="/doc.pdf"></object>
      <embed class="emb" src="/doc.pdf">
      <p class="text">kept</p>`;
    const { clone } = cloneWithScroll(source);

    for (const el of clone.querySelectorAll("iframe, video, object, embed")) {
      for (const name of ["src", "srcdoc", "data", "poster"]) {
        expect(el.hasAttribute(name)).toBe(false);
      }
    }
    expect(clone.querySelectorAll("source, track")).toHaveLength(0);
    // The boxes keep their look, so the copy holds the same place.
    expect(clone.querySelector("iframe")?.className).toBe("frame");
    expect(clone.querySelector(".text")?.textContent).toBe("kept");
    // The original is untouched.
    expect(source.querySelector("iframe")?.getAttribute("src")).toBe(
      "blob:x/1",
    );
    expect(source.querySelectorAll("source")).toHaveLength(1);
  });
});
