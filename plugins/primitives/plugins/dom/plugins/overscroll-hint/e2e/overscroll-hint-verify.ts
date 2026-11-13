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
//     it is on the viewport;
//   - a centred flex row (a markdown table's bleed scroller) bounces at its
//     right end without its scroll position jumping back.
//
//   - on a phone: a touch drag the page claimed with `touch-action` never
//     bounces, and a touch capture on an element that claims nothing is
//     flagged by the touch-claim guard (a plain tap is not).
//
// Synthetic wheel events never scroll anything, so every gesture below is
// wasted by construction.
//
// That the motion is smooth (out and back once, never back-and-forth) is
// checked by web/internal/rubber-band.test.ts, deterministically: a headless
// browser on a loaded machine delivers input and frames 17–250 ms apart, so a
// frame-by-frame trace here measures the machine, not the physics.
//
// Usage:
//   ./equin run plugins/primitives/plugins/dom/plugins/overscroll-hint/e2e/overscroll-hint-verify.ts
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

    // The hint is mounted by a Core.Root contribution, which can land after
    // boot resolves: wait until a wasted gesture bounces before checking.
    const probe = scroller(200);
    const probeChild = block("height:50px;");
    probe.appendChild(probeChild);
    const probeUntil = performance.now() + 15_000;
    while (!pulled(probeChild) && performance.now() < probeUntil) {
      wheel(probeChild, 120);
      await frames(2);
    }
    const installed = pulled(probeChild);
    probe.remove();
    await tick(700);

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
    await tick(500);

    // --- a centred flex row scrolled to its right end (a markdown table's
    // bleed scroller): the anchor must not re-centre the row ---
    const row = scroller(80);
    row.style.cssText +=
      "overflow-x:auto;overflow-y:hidden;display:flex;justify-content:center;";
    const rowContent = block("flex:none;width:280px;");
    const wide = block("width:600px;height:50px;");
    rowContent.appendChild(wide);
    row.appendChild(rowContent);
    row.scrollLeft = row.scrollWidth;
    await frames(2);
    const rowBefore = {
      scrollLeft: row.scrollLeft,
      wide: wide.getBoundingClientRect().left,
    };
    wide.dispatchEvent(
      new WheelEvent("wheel", { deltaX: 150, bubbles: true, cancelable: true }),
    );
    await frames(2);
    const rowDuring = {
      scrollLeft: row.scrollLeft,
      wide: wide.getBoundingClientRect().left,
    };
    await tick(700);
    const rowAfter = { scrollLeft: row.scrollLeft };
    row.remove();
    return {
      rowBefore,
      rowDuring,
      rowAfter,
      installed,
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
    installed,
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
    rowBefore,
    rowDuring,
    rowAfter,
  } = result;
  const same = (a: number, b: number): boolean => Math.abs(a - b) < 0.5;

  r.ok("the hint is installed (a probe gesture bounced)", installed);
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

  r.ok(
    "a centred flex row bounces at its right end",
    rowDuring.wide < rowBefore.wide - 5,
    `left ${rowBefore.wide} → ${rowDuring.wide}`,
  );
  r.ok(
    "…without moving its scroll position",
    same(rowDuring.scrollLeft, rowBefore.scrollLeft) &&
      same(rowAfter.scrollLeft, rowBefore.scrollLeft),
    `scrollLeft ${rowBefore.scrollLeft} → ${rowDuring.scrollLeft} → ${rowAfter.scrollLeft}`,
  );

  // --- touch: a drag the page claimed with `touch-action` is not wasted ---
  // A phone session (touch events exist), on a surface whose content fits so
  // every unclaimed drag is wasted by construction.
  const phone = await h.session({ touch: true });
  await boot(phone.page, pathUrl("/"));
  const touch = await phone.page.evaluate(async () => {
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
    const pulled = (el: HTMLElement): boolean =>
      /translate/.test(el.style.transform || "") ||
      (el.style.top !== "" && el.style.top !== "0px") ||
      (el.style.left !== "" && el.style.left !== "0px");
    // A sideways or downward finger drag on `target`, held down at the end.
    const drag = async (target: Element, dx: number, dy: number) => {
      const at = (x: number, y: number): Touch =>
        new Touch({ identifier: 1, target, clientX: x, clientY: y });
      const fire = (type: string, t: Touch | null): void => {
        target.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: t ? [t] : [],
            changedTouches: [t ?? at(100 + dx * 6, 100 + dy * 6)],
          }),
        );
      };
      fire("touchstart", at(100, 100));
      for (let i = 1; i <= 6; i++) {
        fire("touchmove", at(100 + dx * i, 100 + dy * i));
        await frames(1);
      }
      await frames(2);
    };
    const release = (target: Element): void => {
      target.dispatchEvent(
        new TouchEvent("touchend", { bubbles: true, touches: [] }),
      );
    };
    const sheet = (): { box: HTMLElement; child: HTMLElement } => {
      const box = document.createElement("div");
      box.style.cssText =
        "position:fixed;top:0;left:0;width:300px;height:200px;overflow:auto;z-index:99999;";
      const child = document.createElement("div");
      child.style.cssText = "height:50px;";
      box.appendChild(child);
      document.body.appendChild(box);
      return { box, child };
    };
    const run = async (
      touchAction: string,
      dx: number,
      dy: number,
    ): Promise<boolean> => {
      const { box, child } = sheet();
      const control = document.createElement("div");
      control.style.cssText = `height:40px;touch-action:${touchAction};`;
      child.appendChild(control);
      await drag(control, dx, dy);
      const moved = pulled(child);
      release(control);
      await tick(600);
      box.remove();
      return moved;
    };
    // The control: an unclaimed drag bounces — retried until the hint is
    // mounted (its Core.Root controller can land after boot resolves).
    const until = performance.now() + 15_000;
    let free = false;
    while (!free && performance.now() < until) free = await run("auto", 0, -12);
    return {
      free,
      freeSideways: await run("auto", -12, 0),
      none: await run("none", -12, 0),
      noneVertical: await run("none", 0, -12),
      panYSideways: await run("pan-y", -12, 0),
      panYVertical: await run("pan-y", 0, -12),
    };
  });
  r.ok("touch: an unclaimed drag that scrolls nothing bounces", touch.free);
  r.ok("touch: …sideways too", touch.freeSideways);
  r.ok(
    "touch: a drag on touch-action:none (a dial) never bounces",
    !touch.none && !touch.noneVertical,
    JSON.stringify(touch),
  );
  r.ok(
    "touch: on touch-action:pan-y, a sideways drag is the page's own",
    !touch.panYSideways,
  );
  r.ok("touch: …while a vertical one still bounces", touch.panYVertical);

  // --- the touch-claim guard: a touch drag must declare its touch-action ---
  // Real taps (CDP), so the browser runs its own pointer events and capture.
  await phone.page.evaluate(() => {
    const w = window as unknown as { __unclaimed: string[] };
    w.__unclaimed = [];
    window.addEventListener("error", (e) => {
      if (String(e.message).includes("UnclaimedTouchDragError"))
        w.__unclaimed.push(String(e.message));
    });
  });
  const tapOn = async (
    touchAction: string,
    capture: boolean,
  ): Promise<number> => {
    await phone.page.evaluate(
      ({ touchAction, capture }) => {
        const el = document.createElement("div");
        el.id = "claim-probe";
        el.style.cssText = `position:fixed;top:300px;left:40px;width:200px;height:60px;z-index:99999;touch-action:${touchAction};`;
        if (capture)
          el.addEventListener("pointerdown", (e) =>
            el.setPointerCapture(e.pointerId),
          );
        document.body.appendChild(el);
        (window as unknown as { __unclaimed: string[] }).__unclaimed = [];
      },
      { touchAction, capture },
    );
    await phone.page.touchscreen.tap(140, 330);
    await phone.page.waitForTimeout(150);
    return phone.page.evaluate(() => {
      document.getElementById("claim-probe")?.remove();
      return (window as unknown as { __unclaimed: string[] }).__unclaimed
        .length;
    });
  };
  const plainTap = await tapOn("auto", false);
  const unclaimed = await tapOn("auto", true);
  const claimedNone = await tapOn("none", true);
  const claimedPanY = await tapOn("pan-y", true);
  r.ok(
    "guard: a plain tap (no capture of its own) is never flagged",
    plainTap === 0,
    `${plainTap}`,
  );
  r.ok(
    "guard: a touch capture on an element that claims no touch is flagged",
    unclaimed === 1,
    `${unclaimed}`,
  );
  r.ok(
    "guard: a capture on touch-action:none or pan-y is not",
    claimedNone === 0 && claimedPanY === 0,
    `${claimedNone} / ${claimedPanY}`,
  );

  await r.finish();
});
