/**
 * What a browser_* call shows: a one-line summary and, for the tools that carry
 * code or a list of actions, a body of its own. One table over the tool's short
 * name (`mcp__equin__browser_<x>` -> `<x>`), so a tool is a row, not a view.
 *
 * Tolerates a still-streaming input: any field may be missing, the wrong type,
 * or a string cut short.
 */

export interface BrowserCallBody {
  code: string;
  lang: "javascript" | null;
}

export interface BrowserCallView {
  summary: string;
  body?: BrowserCallBody;
}

type Input = Record<string, unknown>;

const SUFFIX = /browser_([a-z_]+)$/;

export function browserToolShortName(toolName: string): string {
  const m = SUFFIX.exec(toolName);
  if (!m) throw new Error(`not a browser_* tool: ${toolName}`);
  return m[1]!;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? ""
  );
}

function pair(v: unknown): string | undefined {
  return Array.isArray(v) && v.length === 2 ? `${v[0]}, ${v[1]}` : undefined;
}

/** The target an action acts on: ref, selector or coordinate. */
function targetOf(a: Input): string | undefined {
  const ref = str(a.ref);
  if (ref) return ref;
  const selector = str(a.selector);
  if (selector) return selector;
  const at = pair(a.coordinate);
  return at && `(${at})`;
}

/** "click e12", "fill e3 \"hello\"", "scroll (0, 600)", "wait 500ms". */
export function describeAction(a: Input): string {
  const action = str(a.action) ?? "";
  const parts = [action];
  if (action === "wait") {
    const ms = num(a.ms);
    if (ms !== undefined) parts.push(`${ms}ms`);
    return parts.join(" ");
  }
  const target = targetOf(a);
  if (target) parts.push(target);
  const text = str(a.text) ?? str(a.value);
  if (text) parts.push(JSON.stringify(text));
  const delta = pair(a.delta);
  if (action === "scroll" && delta) parts.push(`[${delta}]`);
  return parts.join(" ");
}

function viewportOf(i: Input): string {
  const w = num(i.width);
  const h = num(i.height);
  const size =
    w !== undefined || h !== undefined ? `${w ?? "–"}×${h ?? "–"}` : "";
  return [size, str(i.colorScheme)].filter(Boolean).join(" ");
}

function filtered(label: string, i: Input, flags: string[]): string {
  const bits = [str(i.pattern) && `/${str(i.pattern)}/`];
  for (const flag of flags) if (i[flag] === true) bits.push(flag);
  const text = bits.filter(Boolean).join(" ");
  return text === "" ? label : text;
}

const TABLE: Record<string, (i: Input) => BrowserCallView> = {
  javascript: (i) => {
    const code = str(i.code);
    return {
      summary: code ? firstLine(code) : "javascript",
      body: code ? { code, lang: "javascript" } : undefined,
    };
  },
  navigate: (i) => ({ summary: str(i.url) ?? "navigate" }),
  screenshot: (i) => ({
    summary:
      [str(i.ref), i.fullPage === true ? "full page" : undefined]
        .filter(Boolean)
        .join(" · ") || "viewport",
  }),
  act: (i) => ({ summary: describeAction(i) || "act" }),
  find: (i) => ({ summary: str(i.query) ?? "find" }),
  get_page_text: () => ({ summary: "page text" }),
  console: (i) => ({
    summary: filtered("console", i, ["errorsOnly", "clear"]),
  }),
  close: () => ({ summary: "close session" }),
  viewport: (i) => ({ summary: viewportOf(i) || "viewport" }),
  tabs: (i) => ({
    summary: [str(i.action) ?? "list", str(i.tab)].filter(Boolean).join(" "),
  }),
  attach: () => ({ summary: "attach an e2e run" }),
  read_page: (i) => ({
    summary:
      [
        str(i.ref),
        num(i.depth) !== undefined ? `depth ${num(i.depth)}` : undefined,
      ]
        .filter(Boolean)
        .join(" · ") || "accessibility tree",
  }),
  network: (i) => ({
    summary: filtered("network", i, ["failedOnly", "clear"]),
  }),
  batch: (i) => {
    const actions = Array.isArray(i.actions)
      ? i.actions.filter((a): a is Input => typeof a === "object" && a !== null)
      : [];
    const lines = actions.map(describeAction);
    return {
      summary:
        lines.length === 0
          ? "batch"
          : lines.length === 1
            ? lines[0]!
            : `${lines.length} actions: ${lines[0]} …`,
      body:
        lines.length > 1 ? { code: lines.join("\n"), lang: null } : undefined,
    };
  },
};

export function describeBrowserCall(
  toolName: string,
  input: unknown,
): BrowserCallView {
  const short = browserToolShortName(toolName);
  const row = TABLE[short];
  if (!row) throw new Error(`no browser tool row for ${toolName}`);
  const i = typeof input === "object" && input !== null ? (input as Input) : {};
  return row(i);
}
