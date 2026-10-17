import { z } from "zod";
import type { Locator, Page } from "playwright";
import {
  browserToolSpecs,
  type Action,
  type BrowserToolArgs,
  type BrowserToolName,
} from "../shared/tools";
import type { HostTarget, HostToolResult } from "../shared/protocol";
import {
  closeSession,
  closeTab,
  DEFAULT_VIEWPORT,
  findTab,
  getSession,
  openTab,
  type Session,
  type Tab,
} from "./host-session";
import { issueAttachTicket } from "./host-attach";

/**
 * Every tool of `shared/tools.ts`, implemented on the host's live pages. A
 * record over the table's own keys, so a declared tool with no
 * implementation (or the reverse) is a type error.
 */

interface CallContext {
  conversationId: string;
  target: HostTarget;
}

function text(value: unknown): HostToolResult {
  return {
    content: [
      {
        type: "text",
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 1),
      },
    ],
  };
}

function session(ctx: CallContext): Promise<Session> {
  return getSession(ctx.conversationId, ctx.target);
}

/** The tab to act on — opening the first one when the session has none. */
async function tabOf(ctx: CallContext, id?: string): Promise<Tab> {
  const s = await session(ctx);
  return findTab(s, id) ?? (await openTab(s));
}

function resolveUrl(s: Session, url: string): string {
  if (url.startsWith("/")) return `${s.target.origin}${url}`;
  if (/^https?:\/\//.test(url)) return url;
  throw new Error(
    `"${url}" is neither a route ("/…", on this worktree's build) nor an absolute http(s) URL.`,
  );
}

/** Where the tab stands after a call, plus the errors that call caused. */
async function state(
  tab: Tab,
  consoleFrom: number,
): Promise<Record<string, unknown>> {
  const errors = tab.console
    .slice(consoleFrom)
    .filter(
      (e) =>
        e.type === "error" || e.type === "pageerror" || e.type === "dialog",
    )
    .map((e) => `${e.type}: ${e.text}`);
  return {
    tab: tab.id,
    url: tab.page.url(),
    title: await tab.page.title(),
    ...(errors.length > 0 ? { newErrors: errors } : {}),
  };
}

function locate(
  page: Page,
  t: { ref?: string; selector?: string },
): Locator | null {
  if (t.ref) return page.locator(`aria-ref=${t.ref}`);
  if (t.selector) return page.locator(t.selector);
  return null;
}

async function perform(page: Page, a: Action): Promise<void> {
  const loc = locate(page, a);
  const need = (): Locator => {
    if (!loc) throw new Error(`${a.action} needs a ref or a selector.`);
    return loc;
  };
  const xy = a.coordinate;
  switch (a.action) {
    case "click":
    case "double_click":
    case "right_click": {
      const button = a.action === "right_click" ? "right" : "left";
      const clickCount = a.action === "double_click" ? 2 : 1;
      if (xy && !loc)
        await page.mouse.click(xy[0], xy[1], { button, clickCount });
      else await need().click({ button, clickCount });
      return;
    }
    case "hover":
      if (xy && !loc) await page.mouse.move(xy[0], xy[1]);
      else await need().hover();
      return;
    case "fill":
      await need().fill(a.text ?? "");
      return;
    case "type":
      if (loc) await loc.pressSequentially(a.text ?? "");
      else await page.keyboard.type(a.text ?? "");
      return;
    case "press":
      if (!a.text) throw new Error("press needs `text`: the key.");
      if (loc) await loc.press(a.text);
      else await page.keyboard.press(a.text);
      return;
    case "select":
      if (a.value === undefined) throw new Error("select needs `value`.");
      await need().selectOption(a.value);
      return;
    case "scroll": {
      const [dx, dy] = a.delta ?? [0, 600];
      if (loc) await loc.hover();
      else if (xy) await page.mouse.move(xy[0], xy[1]);
      await page.mouse.wheel(dx, dy);
      return;
    }
    case "wait":
      await page.waitForTimeout(a.ms ?? 1000);
      return;
  }
}

/** Let the page react to an action before reporting where it stands. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(250);
}

type Impls = {
  [N in BrowserToolName]: (
    args: BrowserToolArgs<N>,
    ctx: CallContext,
  ) => Promise<HostToolResult>;
};

const impls: Impls = {
  async browser_tabs({ action, tab }, ctx) {
    const s = await session(ctx);
    if (action === "new") await openTab(s);
    if (action === "close") {
      const id = tab ?? s.current;
      if (id === null) throw new Error("No tab to close.");
      await closeTab(s, id);
    }
    const tabs = await Promise.all(
      [...s.tabs.values()].map(async (t) => ({
        id: t.id,
        url: t.page.url(),
        title: await t.page.title(),
        current: t.id === s.current,
      })),
    );
    return text({ target: s.target.origin, tabs });
  },

  async browser_navigate({ url, tab: id }, ctx) {
    const s = await session(ctx);
    const tab = findTab(s, id) ?? (await openTab(s));
    const from = tab.console.length;
    if (url === "back") await tab.page.goBack({ waitUntil: "load" });
    else if (url === "forward") await tab.page.goForward({ waitUntil: "load" });
    else {
      const res = await tab.page.goto(resolveUrl(s, url), {
        waitUntil: "load",
      });
      if (res && !res.ok()) {
        return text({ ...(await state(tab, from)), httpStatus: res.status() });
      }
    }
    await settle(tab.page);
    return text(await state(tab, from));
  },

  async browser_read_page({ tab: id, ref, depth }, ctx) {
    const tab = await tabOf(ctx, id);
    const root = ref ? tab.page.locator(`aria-ref=${ref}`) : tab.page;
    const snapshot = await root.ariaSnapshot({
      mode: "ai",
      ...(depth ? { depth } : {}),
    });
    return text(`# ${tab.id} ${tab.page.url()}\n${snapshot}`);
  },

  async browser_find({ query, tab: id }, ctx) {
    const tab = await tabOf(ctx, id);
    const snapshot = await tab.page.ariaSnapshot({ mode: "ai" });
    const needle = query.toLowerCase();
    const hits = snapshot
      .split("\n")
      .filter((l) => l.toLowerCase().includes(needle))
      .map((l) => l.trim());
    return text(
      hits.length > 0 ? hits.join("\n") : `No element matches "${query}".`,
    );
  },

  async browser_get_page_text({ tab: id }, ctx) {
    const tab = await tabOf(ctx, id);
    return text(await tab.page.evaluate(() => document.body.innerText));
  },

  async browser_act({ tab: id, ...action }, ctx) {
    const tab = await tabOf(ctx, id);
    const from = tab.console.length;
    await perform(tab.page, action);
    await settle(tab.page);
    return text(await state(tab, from));
  },

  async browser_batch({ actions, tab: id }, ctx) {
    const tab = await tabOf(ctx, id);
    const from = tab.console.length;
    for (const [i, action] of actions.entries()) {
      try {
        await perform(tab.page, action);
      } catch (err) {
        if (!(err instanceof Error)) throw err;
        return text({
          ...(await state(tab, from)),
          failedAt: i,
          action: action.action,
          error: err.message,
        });
      }
    }
    await settle(tab.page);
    return text({ ...(await state(tab, from)), done: actions.length });
  },

  async browser_javascript({ code, tab: id }, ctx) {
    const tab = await tabOf(ctx, id);
    // A string is evaluated as an expression in the page; awaited by Playwright.
    const result: unknown = await tab.page.evaluate(
      `(async () => { ${code} })()`,
    );
    return text(result === undefined ? "undefined" : result);
  },

  async browser_screenshot({ tab: id, fullPage, ref }, ctx) {
    const tab = await tabOf(ctx, id);
    const png = ref
      ? await tab.page.locator(`aria-ref=${ref}`).screenshot()
      : await tab.page.screenshot({ fullPage: fullPage ?? false });
    return {
      content: [
        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
        {
          type: "text",
          text: JSON.stringify(await state(tab, tab.console.length)),
        },
      ],
    };
  },

  async browser_console({ tab: id, pattern, errorsOnly, clear }, ctx) {
    const tab = await tabOf(ctx, id);
    const re = pattern ? new RegExp(pattern, "i") : null;
    const out = tab.console.filter(
      (e) =>
        (!errorsOnly || e.type === "error" || e.type === "pageerror") &&
        (!re || re.test(e.text)),
    );
    if (clear) tab.console.length = 0;
    return text(
      out
        .map((e) => `${new Date(e.t).toISOString()} [${e.type}] ${e.text}`)
        .join("\n") || "(none)",
    );
  },

  async browser_network({ tab: id, pattern, failedOnly, clear }, ctx) {
    const tab = await tabOf(ctx, id);
    const re = pattern ? new RegExp(pattern, "i") : null;
    const out = tab.network.filter(
      (e) =>
        (!failedOnly || e.failure !== null || (e.status ?? 0) >= 400) &&
        (!re || re.test(e.url)),
    );
    if (clear) tab.network.length = 0;
    return text(
      out
        .map((e) => `${e.method} ${e.status ?? e.failure} ${e.url}`)
        .join("\n") || "(none)",
    );
  },

  async browser_viewport({ tab: id, width, height, colorScheme }, ctx) {
    const tab = await tabOf(ctx, id);
    if (width !== undefined || height !== undefined) {
      const now = tab.page.viewportSize();
      await tab.page.setViewportSize({
        width: width ?? now?.width ?? DEFAULT_VIEWPORT.width,
        height: height ?? now?.height ?? DEFAULT_VIEWPORT.height,
      });
    }
    if (colorScheme) await tab.page.emulateMedia({ colorScheme });
    return text({
      ...(await state(tab, tab.console.length)),
      viewport: tab.page.viewportSize(),
    });
  },

  async browser_attach(_args, ctx) {
    const s = await session(ctx);
    const { ticket, tab } = await issueAttachTicket(s);
    return text({
      tab: tab.id,
      target: s.target.origin,
      flag: `--attach ${ticket}`,
    });
  },

  async browser_close(_args, ctx) {
    return text({ closed: await closeSession(ctx.conversationId) });
  },
};

/**
 * Run one tool call. The args are parsed here, against the same schema the
 * backend advertised: the socket is a process boundary, and a backend running
 * other code may send what this host does not accept.
 */
export function runTool<N extends BrowserToolName>(
  name: N,
  rawArgs: unknown,
  ctx: CallContext,
): Promise<HostToolResult> {
  const args = z
    .object(browserToolSpecs[name].inputSchema)
    .parse(rawArgs ?? {}) as BrowserToolArgs<N>;
  return impls[name](args, ctx);
}
