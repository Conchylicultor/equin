// Verify the overscroll-hint primitive on synthetic surfaces mounted into the
// live app:
//
//   - a wasted wheel gesture (nothing scrolls) rubber-bands the surface's
//     content, live — a second push moves it further; a real scroll does not,
//     nor does a gesture on a scroller with room left whose scroll event is late;
//   - at the END of a scrollable surface the bounce moves the content up while
//     the scroll position and the scroll length stay exactly where they were,
//     and are still there once it has sprung back — including when the page
//     overflows a one-viewport content box, as every pane's does;
//   - a sticky header stuck to the edge stays on the edge, at the end and at
//     the start — whether it is a direct child of the scroller or nested inside
//     the content — while a sticky still in flow further down moves with its
//     rows;
//   - a header inside a `display: contents` wrapper (a theme boundary) stays on
//     the edge, and a `position: fixed` widget inside the content stays where
//     it is on the viewport.
//
// Synthetic wheel events never scroll anything, so every gesture below is
// wasted by construction.
//
// Usage:
//   ./singularity run plugins/primitives/plugins/dom/plugins/overscroll-hint/e2e/overscroll-hint-verify.ts
//
// Manual only — nothing runs this automatically.
import {
  boot,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const r = report("overscroll hint");

await withBrowser(async (h) => {
  const { page } = await h.session();
  await boot(page, pathUrl("/"));

  const result = await page.evaluate(async () => {
    const frames = (n: number): Promise<void> =>
      new Promise((res) => {
        let left = n;
        const step = (): void => {
          left -= 1;
          if (left <= 0) res();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    const tick = (ms: number): Promise<void> =>
      new Promise((res) => setTimeout(() => res(), ms));
    const wheel = (target: Element, deltaY: number): boolean =>
      target.dispatchEvent(
        new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true }),
      );
    // moved by a relative inset (a layer in flow) or a transform (any other)
    const pulled = (el: HTMLElement): boolean =>
      /translate/.test(el.style.transform || "") ||
      (el.style.top !== "" && el.style.top !== "0px");
    const scroller = (height: number): HTMLElement => {
      const s = document.createElement("div");
      s.style.cssText = `position:fixed;top:0;left:0;width:300px;height:${height}px;overflow-y:auto;z-index:99999;`;
      document.body.appendChild(s);
      return s;
    };
    const block = (css: string, className = ""): HTMLElement => {
      const b = document.createElement("div");
      b.className = className;
      b.style.cssText = css;
      return b;
    };

    // --- a surface whose content fits: every gesture is wasted ---
    const dead = scroller(200);
    const deadChild = block("height:50px;");
    dead.appendChild(deadChild);
    wheel(deadChild, 120);
    await frames(2);
    const at = (el: HTMLElement): string => el.style.transform + el.style.top;
    const firstPush = at(deadChild);
    wheel(deadChild, 120);
    await frames(2);
    const fits = {
      pulled: pulled(deadChild),
      keepsMoving: pulled(deadChild) && at(deadChild) !== firstPush,
      boxStill: !pulled(dead),
      css: `${firstPush} || ${deadChild.style.cssText}`,
    };
    dead.remove();
    await tick(500);

    // --- a real scroll is not a wasted gesture ---
    const live = scroller(200);
    const liveChild = block("height:2000px;");
    live.appendChild(liveChild);
    wheel(liveChild, 120);
    live.scrollTop = 120;
    live.dispatchEvent(new Event("scroll"));
    await frames(2);
    const realScrollPulled = pulled(liveChild);
    // …nor is a gesture whose scroll event is late: a scroller with room left
    // in the gesture's direction is never at a dead end, event or no event.
    wheel(liveChild, 120);
    await frames(2);
    const realScroll = {
      pulled: realScrollPulled,
      lateEventPulled: pulled(liveChild),
    };
    live.remove();
    await tick(500);

    // --- a scrollable surface with pinned chrome ---
    //   header  — a direct child, stuck at the top;
    //   nested  — inside the content, stuck 30px down;
    //   group   — a sticky still in flow near the end, NOT stuck.
    const surface = scroller(200);
    const header = block(
      "position:sticky;top:0;height:30px;background:#000;",
      "sticky",
    );
    const content = block("");
    const nested = block(
      "position:sticky;top:30px;height:20px;background:#333;",
      "sticky",
    );
    const filler = block("height:1000px;");
    const section = block("");
    const group = block(
      "position:sticky;top:60px;height:20px;background:#666;",
      "sticky",
    );
    section.append(group, block("height:100px;"));
    content.append(nested, filler, section);
    surface.append(header, content);
    const childCount = surface.children.length;

    const tops = (): { header: number; nested: number; group: number } => ({
      header: header.getBoundingClientRect().top,
      nested: nested.getBoundingClientRect().top,
      group: group.getBoundingClientRect().top,
    });

    // At the end: push down.
    surface.scrollTop = surface.scrollHeight;
    await frames(2);
    const endBefore = {
      ...tops(),
      scrollTop: surface.scrollTop,
      scrollHeight: surface.scrollHeight,
    };
    wheel(filler, 150);
    await frames(2);
    const endDuring = {
      ...tops(),
      scrollTop: surface.scrollTop,
      scrollHeight: surface.scrollHeight,
      contentPulled: pulled(content),
      headerPulled: pulled(header),
    };
    await tick(700);
    const endAfter = {
      scrollTop: surface.scrollTop,
      cleared:
        content.style.transform === "" &&
        content.style.top === "" &&
        content.style.position === "" &&
        nested.style.translate === "" &&
        surface.children.length === childCount,
      left: `${content.style.cssText} | ${nested.style.cssText} | ${surface.children.length}/${childCount}`,
    };

    // At the start: push up.
    surface.scrollTop = 0;
    await frames(2);
    const startBefore = {
      ...tops(),
      filler: filler.getBoundingClientRect().top,
    };
    wheel(filler, -150);
    await frames(2);
    const startDuring = {
      ...tops(),
      filler: filler.getBoundingClientRect().top,
      scrollTop: surface.scrollTop,
    };
    surface.remove();
    await tick(500);

    // --- the end is past the last child's box ---
    // A pane's content box is `h-full` — one viewport tall — and the page
    // overflows out of it, so the scroll extent ends far below the last child.
    const pane = scroller(200);
    const paneHeader = block(
      "position:sticky;top:0;height:30px;background:#000;",
      "sticky",
    );
    const box = block("height:100%;");
    const page = block("height:1000px;");
    box.appendChild(page);
    pane.append(paneHeader, box);
    pane.scrollTop = pane.scrollHeight;
    await frames(2);
    const overflowBefore = {
      header: paneHeader.getBoundingClientRect().top,
      page: page.getBoundingClientRect().top,
      scrollTop: pane.scrollTop,
    };
    wheel(page, 150);
    await frames(2);
    const overflowDuring = {
      header: paneHeader.getBoundingClientRect().top,
      page: page.getBoundingClientRect().top,
      scrollTop: pane.scrollTop,
    };
    await tick(700);
    const overflowAfter = { scrollTop: pane.scrollTop };
    pane.remove();
    await tick(500);

    // --- a website page: the header inside a `display: contents` theme
    // boundary, and a fixed widget (a gauge rail) inside the content ---
    const site = scroller(200);
    const wrap = block("display:contents;");
    const siteHeader = block(
      "position:sticky;top:0;height:30px;background:#000;",
      "sticky",
    );
    wrap.appendChild(siteHeader);
    const sitePage = block("height:1000px;");
    const rail = block(
      "position:fixed;left:400px;top:120px;width:10px;height:10px;",
    );
    sitePage.appendChild(rail);
    site.append(wrap, sitePage);
    site.scrollTop = site.scrollHeight;
    await frames(2);
    const siteBefore = {
      header: siteHeader.getBoundingClientRect().top,
      page: sitePage.getBoundingClientRect().top,
      rail: rail.getBoundingClientRect().top,
    };
    wheel(sitePage, 150);
    await frames(2);
    const siteDuring = {
      header: siteHeader.getBoundingClientRect().top,
      page: sitePage.getBoundingClientRect().top,
      rail: rail.getBoundingClientRect().top,
    };
    site.remove();

    return {
      fits,
      realScroll,
      endBefore,
      endDuring,
      endAfter,
      startBefore,
      startDuring,
      overflowBefore,
      overflowDuring,
      overflowAfter,
      siteBefore,
      siteDuring,
    };
  });

  const {
    fits,
    realScroll,
    endBefore,
    endDuring,
    endAfter,
    startBefore,
    startDuring,
    overflowBefore,
    overflowDuring,
    overflowAfter,
    siteBefore,
    siteDuring,
  } = result;
  const same = (a: number, b: number): boolean => Math.abs(a - b) < 0.5;

  r.ok("a wasted gesture rubber-bands the content", fits.pulled, fits.css);
  r.ok("a second push moves it further (live, not one-shot)", fits.keepsMoving);
  r.ok("the scroll box itself never moves", fits.boxStill);
  r.ok("a real scroll does not bounce", !realScroll.pulled);
  r.ok(
    "a gesture whose scroll event is late does not bounce mid-scroll",
    !realScroll.lateEventPulled,
  );

  r.ok(
    "at the end, the content moves up",
    endDuring.contentPulled && endDuring.group < endBefore.group - 5,
    `group ${endBefore.group} → ${endDuring.group}`,
  );
  r.ok(
    "at the end, the scroll position does not move",
    same(endDuring.scrollTop, endBefore.scrollTop) &&
      same(endAfter.scrollTop, endBefore.scrollTop),
    `scrollTop ${endBefore.scrollTop} → ${endDuring.scrollTop} → ${endAfter.scrollTop}`,
  );
  r.ok(
    "at the end, the scroll length does not change",
    same(endDuring.scrollHeight, endBefore.scrollHeight),
    `scrollHeight ${endBefore.scrollHeight} → ${endDuring.scrollHeight}`,
  );
  r.ok(
    "at the end, a stuck header that is a direct child stays on the edge",
    !endDuring.headerPulled && same(endDuring.header, endBefore.header),
    `top ${endBefore.header} → ${endDuring.header}`,
  );
  r.ok(
    "at the end, a stuck header nested in the content stays on the edge",
    same(endDuring.nested, endBefore.nested),
    `top ${endBefore.nested} → ${endDuring.nested}`,
  );
  r.ok(
    "once sprung back, every style and the extent anchor are gone",
    endAfter.cleared,
    endAfter.left,
  );

  r.ok(
    "at the start, the content moves down",
    startDuring.filler > startBefore.filler + 5,
    `filler ${startBefore.filler} → ${startDuring.filler}`,
  );
  r.ok(
    "at the start, the scroll position stays at the top",
    startDuring.scrollTop === 0,
    `scrollTop ${startDuring.scrollTop}`,
  );
  r.ok(
    "at the start, the headers on the edge stay on it",
    same(startDuring.header, startBefore.header) &&
      same(startDuring.nested, startBefore.nested),
    `header ${startBefore.header} → ${startDuring.header}, nested ${startBefore.nested} → ${startDuring.nested}`,
  );
  r.ok(
    "a sticky still in flow moves with its rows",
    startDuring.group > startBefore.group + 5,
    `group ${startBefore.group} → ${startDuring.group}`,
  );

  r.ok(
    "content overflowing its box still bounces at the end",
    overflowDuring.page < overflowBefore.page - 5,
    `page ${overflowBefore.page} → ${overflowDuring.page}`,
  );
  r.ok(
    "…without moving the scroll position",
    same(overflowDuring.scrollTop, overflowBefore.scrollTop) &&
      same(overflowAfter.scrollTop, overflowBefore.scrollTop),
    `scrollTop ${overflowBefore.scrollTop} → ${overflowDuring.scrollTop} → ${overflowAfter.scrollTop}`,
  );
  r.ok(
    "…or its header",
    same(overflowDuring.header, overflowBefore.header),
    `top ${overflowBefore.header} → ${overflowDuring.header}`,
  );

  r.ok(
    "a page under a display:contents header still bounces",
    siteDuring.page < siteBefore.page - 5,
    `page ${siteBefore.page} → ${siteDuring.page}`,
  );
  r.ok(
    "…its header, inside the wrapper, stays on the edge",
    same(siteDuring.header, siteBefore.header),
    `top ${siteBefore.header} → ${siteDuring.header}`,
  );
  r.ok(
    "…and a fixed widget inside the content stays on the viewport",
    same(siteDuring.rail, siteBefore.rail),
    `top ${siteBefore.rail} → ${siteDuring.rail}`,
  );

  await r.finish();
});
