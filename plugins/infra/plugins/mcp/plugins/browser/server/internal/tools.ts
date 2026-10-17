import { z } from "zod";
import type { Locator, Page } from "playwright";
import {
  Mcp,
  type McpToolContext,
  type McpToolResult,
} from "@plugins/infra/plugins/mcp/server";
import {
  closeSession,
  closeTab,
  findTab,
  getSession,
  openTab,
  type Session,
  type Tab,
} from "./host";
import { resolveTarget } from "./target";

/**
 * The agent browser's MCP tools — a headless, per-conversation twin of the
 * Claude-in-Chrome tool set (same verbs and parameters where they fit), so an
 * agent's habits carry over and the only choice left is WHICH browser: this one
 * (its own build, isolated, invisible) or the user's real Chrome (their
 * sign-ins, a page they have open).
 */

const PREAMBLE =
  "Headless agent browser: one shared Chromium, an isolated session per conversation, " +
  "tabs that stay open across calls. Routes (`/agents/…`) resolve against THIS conversation's " +
  "own worktree build; an absolute http:// URL is the escape hatch.";

const tabArg = z
  .string()
  .optional()
  .describe("Tab id (t1, t2, …). Omitted: the last tab used.");

function text(value: unknown): McpToolResult {
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

async function session(ctx: McpToolContext): Promise<Session> {
  return getSession(ctx.conversationId, () =>
    resolveTarget(ctx.conversationId),
  );
}

/** The tab to act on — opening the first one when the session has none. */
async function tabOf(ctx: McpToolContext, id?: string): Promise<Tab> {
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

const targetShape = {
  ref: z
    .string()
    .optional()
    .describe("Element ref from browser_read_page / browser_find (e.g. e12)."),
  selector: z
    .string()
    .optional()
    .describe("Playwright selector, when no ref fits."),
  coordinate: z
    .tuple([z.number(), z.number()])
    .optional()
    .describe(
      "[x, y] viewport CSS pixels — the fallback for canvas / drag surfaces.",
    ),
};

function locate(
  page: Page,
  t: { ref?: string; selector?: string },
): Locator | null {
  if (t.ref) return page.locator(`aria-ref=${t.ref}`);
  if (t.selector) return page.locator(t.selector);
  return null;
}

const actionSchema = z.object({
  action: z.enum([
    "click",
    "double_click",
    "right_click",
    "hover",
    "fill",
    "type",
    "press",
    "select",
    "scroll",
    "wait",
  ]),
  ...targetShape,
  text: z
    .string()
    .optional()
    .describe("fill / type: the text. press: the key (e.g. Enter, Control+A)."),
  value: z.string().optional().describe("select: the option value or label."),
  delta: z
    .tuple([z.number(), z.number()])
    .optional()
    .describe("scroll: [dx, dy] pixels (default [0, 600])."),
  ms: z
    .number()
    .int()
    .min(0)
    .max(30_000)
    .optional()
    .describe("wait: milliseconds."),
});
type Action = z.infer<typeof actionSchema>;

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

const browserTabs = Mcp.tool({
  name: "browser_tabs",
  description: `${PREAMBLE}\n\nList, open or close this session's tabs.`,
  inputSchema: {
    action: z.enum(["list", "new", "close"]).default("list"),
    tab: tabArg.describe("close: the tab to close."),
  },
  async handler({ action, tab }, ctx) {
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
});

const browserNavigate = Mcp.tool({
  name: "browser_navigate",
  description: `${PREAMBLE}\n\nNavigate a tab (opening the first one when there is none) to a route of this worktree's build, an absolute URL, or "back" / "forward".`,
  inputSchema: {
    url: z
      .string()
      .describe(
        'A route ("/agents"), an absolute http(s) URL, "back" or "forward".',
      ),
    tab: tabArg,
  },
  async handler({ url, tab: id }, ctx) {
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
});

const browserReadPage = Mcp.tool({
  name: "browser_read_page",
  description: `${PREAMBLE}\n\nThe page's accessibility tree as YAML, each interactive element tagged [ref=eN] for browser_act. The default way to look at a page — far cheaper than a screenshot.`,
  inputSchema: {
    tab: tabArg,
    ref: z.string().optional().describe("Scope the tree to this element."),
    depth: z.number().int().min(1).optional().describe("Limit the tree depth."),
  },
  async handler({ tab: id, ref, depth }, ctx) {
    const tab = await tabOf(ctx, id);
    const root = ref ? tab.page.locator(`aria-ref=${ref}`) : tab.page;
    const snapshot = await root.ariaSnapshot({
      mode: "ai",
      ...(depth ? { depth } : {}),
    });
    return text(`# ${tab.id} ${tab.page.url()}\n${snapshot}`);
  },
});

const browserFind = Mcp.tool({
  name: "browser_find",
  description: `${PREAMBLE}\n\nFind elements whose accessibility-tree line matches a text or role (case-insensitive), with their refs.`,
  inputSchema: {
    query: z
      .string()
      .min(1)
      .describe('Text or role to look for, e.g. "Save" or "button".'),
    tab: tabArg,
  },
  async handler({ query, tab: id }, ctx) {
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
});

const browserGetPageText = Mcp.tool({
  name: "browser_get_page_text",
  description: `${PREAMBLE}\n\nThe page's visible text (document.body.innerText).`,
  inputSchema: { tab: tabArg },
  async handler({ tab: id }, ctx) {
    const tab = await tabOf(ctx, id);
    return text(await tab.page.evaluate(() => document.body.innerText));
  },
});

const browserAct = Mcp.tool({
  name: "browser_act",
  description: `${PREAMBLE}\n\nOne action on a tab: click / double_click / right_click / hover / fill / type / press / select / scroll / wait. Target by ref (preferred), selector, or coordinate. Returns the tab's url/title after it and any console errors it caused.`,
  inputSchema: { ...actionSchema.shape, tab: tabArg },
  async handler({ tab: id, ...action }, ctx) {
    const tab = await tabOf(ctx, id);
    const from = tab.console.length;
    await perform(tab.page, action);
    await settle(tab.page);
    return text(await state(tab, from));
  },
});

const browserBatch = Mcp.tool({
  name: "browser_batch",
  description: `${PREAMBLE}\n\nSeveral browser_act actions in one call, in order; stops at the first failure and says which.`,
  inputSchema: {
    actions: z.array(actionSchema).min(1),
    tab: tabArg,
  },
  async handler({ actions, tab: id }, ctx) {
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
});

const browserJavascript = Mcp.tool({
  name: "browser_javascript",
  description: `${PREAMBLE}\n\nEvaluate JavaScript in the page and return its (awaited, JSON-serialized) result. The code is a function body: use \`return\`.`,
  inputSchema: {
    code: z
      .string()
      .min(1)
      .describe("Function body, e.g. `return document.title`."),
    tab: tabArg,
  },
  async handler({ code, tab: id }, ctx) {
    const tab = await tabOf(ctx, id);
    // A string is evaluated as an expression in the page; awaited by Playwright.
    const result: unknown = await tab.page.evaluate(
      `(async () => { ${code} })()`,
    );
    return text(result === undefined ? "undefined" : result);
  },
});

const browserScreenshot = Mcp.tool({
  name: "browser_screenshot",
  description: `${PREAMBLE}\n\nA PNG of the tab's viewport (or full page, or one element). Use when looks matter; prefer browser_read_page otherwise.`,
  inputSchema: {
    tab: tabArg,
    fullPage: z.boolean().optional(),
    ref: z.string().optional().describe("Capture only this element."),
  },
  async handler({ tab: id, fullPage, ref }, ctx) {
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
});

const browserConsole = Mcp.tool({
  name: "browser_console",
  description: `${PREAMBLE}\n\nThe tab's console messages, page errors and dismissed dialogs, recorded since the tab opened (last 500).`,
  inputSchema: {
    tab: tabArg,
    pattern: z.string().optional().describe("Regex the message must match."),
    errorsOnly: z.boolean().optional(),
    clear: z.boolean().optional().describe("Empty the buffer after reading."),
  },
  async handler({ tab: id, pattern, errorsOnly, clear }, ctx) {
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
});

const browserNetwork = Mcp.tool({
  name: "browser_network",
  description: `${PREAMBLE}\n\nThe tab's network requests since it opened (last 500): method, url, status or failure.`,
  inputSchema: {
    tab: tabArg,
    pattern: z.string().optional().describe("Regex the URL must match."),
    failedOnly: z
      .boolean()
      .optional()
      .describe("Only failed requests and HTTP >= 400."),
    clear: z.boolean().optional().describe("Empty the buffer after reading."),
  },
  async handler({ tab: id, pattern, failedOnly, clear }, ctx) {
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
});

const browserViewport = Mcp.tool({
  name: "browser_viewport",
  description: `${PREAMBLE}\n\nResize a tab's viewport and/or switch its color scheme.`,
  inputSchema: {
    tab: tabArg,
    width: z.number().int().min(200).optional(),
    height: z.number().int().min(200).optional(),
    colorScheme: z.enum(["light", "dark"]).optional(),
  },
  async handler({ tab: id, width, height, colorScheme }, ctx) {
    const tab = await tabOf(ctx, id);
    if (width !== undefined || height !== undefined) {
      const now = tab.page.viewportSize();
      await tab.page.setViewportSize({
        width: width ?? now?.width ?? 1400,
        height: height ?? now?.height ?? 900,
      });
    }
    if (colorScheme) await tab.page.emulateMedia({ colorScheme });
    return text({
      ...(await state(tab, tab.console.length)),
      viewport: tab.page.viewportSize(),
    });
  },
});

const browserClose = Mcp.tool({
  name: "browser_close",
  description: `${PREAMBLE}\n\nClose this conversation's whole session (every tab) and revert the durable writes it made. Sessions also close after 10 idle minutes and when the conversation ends.`,
  inputSchema: {},
  async handler(_args, ctx) {
    return text({ closed: await closeSession(ctx.conversationId) });
  },
});

export const browserTools = [
  browserTabs,
  browserNavigate,
  browserReadPage,
  browserFind,
  browserGetPageText,
  browserAct,
  browserBatch,
  browserJavascript,
  browserScreenshot,
  browserConsole,
  browserNetwork,
  browserViewport,
  browserClose,
];
