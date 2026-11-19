// What the React Compiler's skipped components cost on a real interaction.
//
// Usage:
//   ./equin run plugins/framework/plugins/tooling/plugins/react-compiler/plugins/skips/e2e/render-cost.ts \
//     --path /agents --steps "type:Message:hello|click:Tasks|wheel:2000" \
//     [--settle 6000] [--step-wait 1200] [--top 12] [--url http://equin.localhost:<port>]
//
// Steps, separated by `|`, each run then waited out (--step-wait ms):
//   type:<placeholder or accessible name>:<text>   click the field, type the text a key at a time
//                                                  (`*`: the page's last text field)
//   click:<accessible name>                        click a control by its exact name
//   wheel:<px>                                     scroll the element under the viewport's centre
//   press:<key>                                    one key (Playwright's key names)
//
// A devtools hook (installed before React loads) walks every commit and counts
// the component fibers that rendered in it. A compiled component carries its
// memo cache on its fiber (`updateQueue.memoCache`, what `useMemoCache`
// allocates), so the hook tells compiled components from skipped ones at
// runtime, with no source map. Per step it prints:
//   - every component rendered, and how many were not compiled;
//   - each fiber's renderer: the nearest component above it that also rendered.
//     A child re-rendered by an UNCOMPILED renderer is what a skip costs — a
//     compiled parent would have handed it the same props and let it bail out
//     (an upper bound: some of those props really changed).
// Library components (Floating UI, dnd-kit …) are never compiled; the
// skipped list names them too, so read it against the compiler's inventory
// (`./equin check react-compiler:no-silent-skips` names every skipped
// component of this repo).

import {
  arg,
  numArg,
  pageUrl,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const url = pageUrl(arg("path", "/"));
const steps = arg("steps", "")
  .split("|")
  .filter((s) => s.length > 0);
const settle = numArg("settle", 6000);
const stepWait = numArg("step-wait", 1200);
const top = numArg("top", 12);

interface CommitTally {
  rendered: number;
  uncompiled: Record<string, number>;
  byUncompiledRenderer: Record<string, number>;
}

await withBrowser(async (h) => {
  const { page } = await h.session({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    interface Fiber {
      tag: number;
      flags: number;
      type: unknown;
      child: Fiber | null;
      sibling: Fiber | null;
      updateQueue: { memoCache?: unknown } | null;
    }
    const w = window as unknown as {
      __rcCommits: CommitTally[];
      __REACT_DEVTOOLS_GLOBAL_HOOK__?: Record<string, unknown>;
    };
    w.__rcCommits = [];
    const nameOf = (t: unknown): string => {
      if (typeof t === "function")
        return (t as { displayName?: string }).displayName ?? t.name;
      if (t !== null && typeof t === "object") {
        const o = t as {
          displayName?: string;
          render?: unknown;
          type?: unknown;
        };
        return o.displayName ?? nameOf(o.render ?? o.type);
      }
      return "?";
    };
    // Function, forwardRef and simple-memo components: the kinds the compiler
    // compiles (class components never are).
    const COMPONENT_TAGS = [0, 11, 15];
    const seen = new WeakMap<object, WeakSet<Fiber>>();
    const onCommit = (_id: number, root: { current: Fiber }) => {
      const prev = seen.get(root) ?? new WeakSet<Fiber>();
      const now = new WeakSet<Fiber>();
      seen.set(root, now);
      const tally: CommitTally = {
        rendered: 0,
        uncompiled: {},
        byUncompiledRenderer: {},
      };
      // [fiber, nearest rendered component above it (or null), its compiled-ness]
      const stack: [Fiber, string | null, boolean][] = [
        [root.current, null, true],
      ];
      while (stack.length > 0) {
        const [f, renderer, rendererCompiled] = stack.pop()!;
        now.add(f);
        let nextRenderer = renderer;
        let nextCompiled = rendererCompiled;
        // A fiber object the previous commit did not hold, with work performed:
        // rendered this commit (a bailed-out subtree keeps its old fibers).
        if (
          COMPONENT_TAGS.includes(f.tag) &&
          (f.flags & 1) !== 0 &&
          !prev.has(f)
        ) {
          const name = nameOf(f.type) || "(anonymous)";
          const compiled = f.updateQueue?.memoCache != null;
          tally.rendered++;
          if (!compiled)
            tally.uncompiled[name] = (tally.uncompiled[name] ?? 0) + 1;
          if (renderer !== null && !rendererCompiled)
            tally.byUncompiledRenderer[renderer] =
              (tally.byUncompiledRenderer[renderer] ?? 0) + 1;
          nextRenderer = name;
          nextCompiled = compiled;
        }
        if (f.sibling) stack.push([f.sibling, renderer, rendererCompiled]);
        if (f.child) stack.push([f.child, nextRenderer, nextCompiled]);
      }
      if (tally.rendered > 0) w.__rcCommits.push(tally);
    };
    const existing = w.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (existing) {
      const prevCommit = existing.onCommitFiberRoot as
        ((...a: unknown[]) => void) | undefined;
      existing.onCommitFiberRoot = (...a: unknown[]) => {
        prevCommit?.(...a);
        onCommit(a[0] as number, a[1] as { current: Fiber });
      };
    } else {
      w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true,
        renderers: new Map(),
        inject: () => 1,
        checkDCE: () => {},
        onScheduleFiberRoot: () => {},
        onCommitFiberUnmount: () => {},
        onPostCommitFiberRoot: () => {},
        onCommitFiberRoot: onCommit,
      };
    }
  });
  await page.goto(url, { waitUntil: "commit" });
  await page.waitForTimeout(settle);
  const drain = () =>
    page.evaluate(() =>
      (window as unknown as { __rcCommits: CommitTally[] }).__rcCommits.splice(
        0,
      ),
    );
  await drain();
  console.log(`page: ${url}`);
  const grand = { rendered: 0, uncompiled: 0, propagated: 0 };
  const grandBy: Record<string, number> = {};
  const report = async (label: string) => {
    const commits = await drain();
    const uncompiled: Record<string, number> = {};
    const by: Record<string, number> = {};
    let rendered = 0;
    for (const c of commits) {
      rendered += c.rendered;
      for (const [n, k] of Object.entries(c.uncompiled))
        uncompiled[n] = (uncompiled[n] ?? 0) + k;
      for (const [n, k] of Object.entries(c.byUncompiledRenderer))
        by[n] = (by[n] ?? 0) + k;
    }
    const sum = (r: Record<string, number>) =>
      Object.values(r).reduce((a, b) => a + b, 0);
    grand.rendered += rendered;
    grand.uncompiled += sum(uncompiled);
    grand.propagated += sum(by);
    for (const [n, k] of Object.entries(by)) grandBy[n] = (grandBy[n] ?? 0) + k;
    console.log(
      `[${label}] ${commits.length} commits · ${rendered} components rendered · ${sum(uncompiled)} not compiled · ${sum(by)} re-rendered by a non-compiled parent`,
    );
    const list = (r: Record<string, number>) =>
      Object.entries(r)
        .sort((a, b) => b[1] - a[1])
        .slice(0, top)
        .map(([n, k]) => `${n} ${k}`)
        .join(", ");
    if (sum(by) > 0) console.log(`    renderers: ${list(by)}`);
    if (sum(uncompiled) > 0)
      console.log(`    not compiled: ${list(uncompiled)}`);
  };
  for (const step of steps) {
    const [kind, ...rest] = step.split(":");
    if (kind === "type") {
      const [name, ...text] = rest;
      // `*` is the page's last text field (a conversation's prompt editor).
      const field =
        name === "*"
          ? page.getByRole("textbox").last()
          : page
              .getByPlaceholder(name!)
              .or(page.getByRole("textbox", { name: name! }))
              .first();
      await field.click();
      await page.waitForTimeout(stepWait);
      await drain();
      for (const ch of text.join(":")) {
        await page.keyboard.press(ch === " " ? "Space" : ch);
        await page.waitForTimeout(stepWait);
        await report(`type "${ch}"`);
      }
      continue;
    }
    if (kind === "click") {
      const name = rest.join(":");
      await page
        .getByRole("button", { name, exact: true })
        .or(page.getByRole("link", { name, exact: true }))
        .or(page.getByText(name, { exact: true }))
        .first()
        .click();
    } else if (kind === "wheel") {
      await page.mouse.move(720, 450);
      await page.mouse.wheel(0, Number(rest[0]));
    } else if (kind === "press") {
      await page.keyboard.press(rest.join(":"));
    } else {
      throw new Error(`unknown step kind "${kind}" in "${step}"`);
    }
    await page.waitForTimeout(stepWait);
    await report(step);
  }
  console.log(
    `[total] ${grand.rendered} components rendered · ${grand.uncompiled} not compiled · ${grand.propagated} (${((100 * grand.propagated) / Math.max(1, grand.rendered)).toFixed(0)}%) re-rendered by a non-compiled parent`,
  );
  console.log(
    `    renderers: ${Object.entries(grandBy)
      .sort((a, b) => b[1] - a[1])
      .slice(0, top * 2)
      .map(([n, k]) => `${n} ${k}`)
      .join(", ")}`,
  );
});
