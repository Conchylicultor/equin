import { afterEach, describe, expect, it } from "vitest";
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

/** Gives `el` a fixed viewport box (jsdom lays nothing out). */
function place(el: Element, left: number, top: number, w: number, h: number) {
  el.getBoundingClientRect = () => new DOMRect(left, top, w, h);
}

describe("cloneWithScroll visibleOnly", () => {
  const source = document.createElement("div");
  afterEach(() => source.remove());

  it("empties what lies outside the source's box and its scrollers' clips", () => {
    source.innerHTML = `
      <div class="scroller" style="overflow: auto">
        <p class="in">in view</p>
        <p class="below" style="width: 100px; height: 20px">scrolled <b>out</b></p>
      </div>
      <div class="anchor"><b class="hangs">a zero-height box's overflow</b></div>
      <div class="pop" style="position: absolute">placed out of the scroller</div>
      <span class="inline">an <i>inline</i> box</span>
      <p class="beside">past the source's right edge</p>`;
    document.body.appendChild(source);
    const q = (s: string) => source.querySelector(s)!;
    place(source, 0, 0, 100, 100);
    // The scroller clips to the top half: a row under it is out of view.
    place(q(".scroller"), 0, 0, 100, 50);
    place(q(".in"), 0, 0, 100, 20);
    place(q(".below"), 0, 60, 100, 20);
    // On the scroller's edge but empty: never judged outside.
    place(q(".anchor"), 0, 50, 100, 0);
    place(q(".pop"), 0, 70, 100, 20);
    place(q(".inline"), 200, 0, 30, 10);
    place(q(".beside"), 120, 0, 50, 20);

    const { clone } = cloneWithScroll(source, { visibleOnly: true });

    expect(clone.querySelector(".in")?.textContent).toBe("in view");
    // Out of view: an empty box of the size it had, so what follows it
    // keeps its place.
    const below = clone.querySelector<HTMLElement>(".below")!;
    expect(below.childNodes).toHaveLength(0);
    expect(below.style.height).toBe("20px");
    expect(below.style.width).toBe("100px");
    expect(clone.querySelector(".beside")?.childNodes).toHaveLength(0);
    expect(clone.querySelector(".hangs")).not.toBeNull();
    // Absolutely placed: judged against the source's box, not the scroller's.
    expect(clone.querySelector(".pop")?.textContent).toBe(
      "placed out of the scroller",
    );
    // An inline box has no size of its own to hold: kept whole.
    expect(clone.querySelector(".inline i")).not.toBeNull();
  });
});
