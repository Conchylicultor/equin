import { z } from "zod";

/**
 * The agent browser's MCP tools as data — a headless, per-conversation twin of
 * the Claude-in-Chrome tool set (same verbs and parameters where they fit), so
 * an agent's habits carry over and the only choice left is WHICH browser: this
 * one (its own build, isolated, invisible) or the user's real Chrome (their
 * sign-ins, a page they have open).
 *
 * Both halves read this one table: the backend registers each as an MCP tool
 * that forwards to the host, and the host (`bin/host-tools.ts`) implements
 * every name in it — a record over these keys, so a tool cannot exist on one
 * side only.
 */

const PREAMBLE =
  "Headless agent browser: one shared Chromium, an isolated session per conversation, " +
  "tabs that stay open across calls (and across server restarts). Routes (`/agents/…`) resolve " +
  "against THIS conversation's own worktree build (refused until it has one); an absolute http(s) URL " +
  "works with or without a build — a public website, main, another worktree.";

const tabArg = z
  .string()
  .optional()
  .describe("Tab id (t1, t2, …). Omitted: the last tab used.");

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

export const actionSchema = z.object({
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
export type Action = z.infer<typeof actionSchema>;

interface ToolSpec<S extends z.ZodRawShape> {
  description: string;
  inputSchema: S;
}

function spec<S extends z.ZodRawShape>(
  description: string,
  inputSchema: S,
): ToolSpec<S> {
  return { description: `${PREAMBLE}\n\n${description}`, inputSchema };
}

export const browserToolSpecs = {
  browser_tabs: spec("List, open or close this session's tabs.", {
    action: z.enum(["list", "new", "close"]).default("list"),
    tab: tabArg.describe("close: the tab to close."),
  }),
  browser_navigate: spec(
    'Navigate a tab (opening the first one when there is none) to a route of this worktree\'s build, an absolute URL, or "back" / "forward".',
    {
      url: z
        .string()
        .describe(
          'A route ("/agents"), an absolute http(s) URL, "back" or "forward".',
        ),
      tab: tabArg,
    },
  ),
  browser_read_page: spec(
    "The page's accessibility tree as YAML, each interactive element tagged [ref=eN] for browser_act. The default way to look at a page — far cheaper than a screenshot.",
    {
      tab: tabArg,
      ref: z.string().optional().describe("Scope the tree to this element."),
      depth: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Limit the tree depth."),
    },
  ),
  browser_find: spec(
    "Find elements whose accessibility-tree line matches a text or role (case-insensitive), with their refs.",
    {
      query: z
        .string()
        .min(1)
        .describe('Text or role to look for, e.g. "Save" or "button".'),
      tab: tabArg,
    },
  ),
  browser_get_page_text: spec(
    "The page's visible text (document.body.innerText).",
    { tab: tabArg },
  ),
  browser_act: spec(
    "One action on a tab: click / double_click / right_click / hover / fill / type / press / select / scroll / wait. Target by ref (preferred), selector, or coordinate. Returns the tab's url/title after it and any console errors it caused.",
    { ...actionSchema.shape, tab: tabArg },
  ),
  browser_batch: spec(
    "Several browser_act actions in one call, in order; stops at the first failure and says which.",
    {
      actions: z.array(actionSchema).min(1),
      tab: tabArg,
    },
  ),
  browser_javascript: spec(
    "Evaluate JavaScript in the page and return its (awaited, JSON-serialized) result. The code is a function body: use `return`.",
    {
      code: z
        .string()
        .min(1)
        .describe("Function body, e.g. `return document.title`."),
      tab: tabArg,
    },
  ),
  browser_screenshot: spec(
    "A PNG of the tab's viewport (or full page, or one element). Use when looks matter; prefer browser_read_page otherwise.",
    {
      tab: tabArg,
      fullPage: z.boolean().optional(),
      ref: z.string().optional().describe("Capture only this element."),
    },
  ),
  browser_console: spec(
    "The tab's console messages, page errors and dismissed dialogs, recorded since the tab opened (last 500).",
    {
      tab: tabArg,
      pattern: z.string().optional().describe("Regex the message must match."),
      errorsOnly: z.boolean().optional(),
      clear: z.boolean().optional().describe("Empty the buffer after reading."),
    },
  ),
  browser_network: spec(
    "The tab's network requests since it opened (last 500): method, url, status or failure.",
    {
      tab: tabArg,
      pattern: z.string().optional().describe("Regex the URL must match."),
      failedOnly: z
        .boolean()
        .optional()
        .describe("Only failed requests and HTTP >= 400."),
      clear: z.boolean().optional().describe("Empty the buffer after reading."),
    },
  ),
  browser_viewport: spec(
    "Resize a tab's viewport and/or switch its color scheme.",
    {
      tab: tabArg,
      width: z.number().int().min(200).optional(),
      height: z.number().int().min(200).optional(),
      colorScheme: z.enum(["light", "dark"]).optional(),
    },
  ),
  browser_attach: spec(
    "Run an e2e script INSIDE this session: opens a fresh tab and returns a ticket. Pass it as `./singularity run <script>.ts --attach <ticket>` — the script drives that tab instead of launching its own browser, and leaves it here when it ends, passing or failing. Then inspect or continue from the exact step it stopped at with the other browser_* tools on that tab. One ticket per run; single-session scripts only.",
    {},
  ),
  browser_close: spec(
    "Close this conversation's whole session (every tab) and revert the durable writes it made. Sessions also close after 30 idle minutes and when the conversation ends.",
    {},
  ),
};

export type BrowserToolName = keyof typeof browserToolSpecs;
export type BrowserToolArgs<N extends BrowserToolName> = z.output<
  z.ZodObject<(typeof browserToolSpecs)[N]["inputSchema"]>
>;

export function isBrowserToolName(name: string): name is BrowserToolName {
  return Object.hasOwn(browserToolSpecs, name);
}
