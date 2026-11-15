import { Mcp, type McpToolResult } from "@plugins/infra/plugins/mcp/server";
import { capturePair } from "@plugins/infra/plugins/mcp/plugins/browser/server";
import { readImageSize } from "@plugins/packages/plugins/image-size/core";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import {
  CAPTURE_LABELS,
  DEFAULT_CAPTURE_VIEWPORT,
  parseRegisterInput,
  REGISTER_BEFORE_AFTER_TOOL,
  registerBeforeAfterInputShape,
  type RegisterBeforeAfterInput,
} from "../../core";
import {
  registerBeforeAfterPair,
  type NewBeforeAfterPair,
} from "../../server/internal/pairs";

const DESCRIPTION = `Publish a before / after pair of screenshots: the user sees it as a swipe comparison under this call, in the conversation's Artifacts, and wherever you cite its id.

When: after you change something VISIBLE in the app, before you report back. One call per screen or state that changed (a list, its empty state, a dialog open) — not one for the whole change. Then cite the returned \`ba-…\` id in your final message (bare, as written), next to what it shows.

Two forms — pass exactly one:
- capture (default): \`route\` (+ \`title\`, optional \`width\` / \`height\` / \`colorScheme\`). Captures that route on MAIN (before) and on THIS conversation's build (after), at the same viewport (default ${DEFAULT_CAPTURE_VIEWPORT.width}×${DEFAULT_CAPTURE_VIEWPORT.height}, light), each once the page is ready (painted, network idle, no loader). Needs a build: run \`./equin build\` first. Main is read-only, so this shows a route as it loads — not a state that needs clicks.
- files: \`beforePath\` + \`afterPath\` (+ \`title\`, optional \`beforeLabel\` / \`afterLabel\`): two PNGs you already made — a state that needs interaction (\`screenshot.ts --click …\` writes \`<out>-before.png\` / \`<out>-after.png\`), or a comparison other than main vs this build.

Returns the pair's id and both images, so you see what you published.`;

/**
 * `register_before_after`: capture (main vs this build) or read (two PNGs) a
 * pair, store it under the agent's tool call, answer its id and both images.
 * Desktop-only: it drives the agent browser and reads the agent's files.
 */
export const registerBeforeAfterTool = Mcp.tool({
  name: REGISTER_BEFORE_AFTER_TOOL,
  description: DESCRIPTION,
  inputSchema: registerBeforeAfterInputShape,
  async handler(args, ctx): Promise<McpToolResult> {
    const input = parseRegisterInput(args);
    const { pair, notes } =
      input.form === "capture"
        ? await capturedPair(ctx.conversationId, input)
        : await filesPair(input);
    const id = await registerBeforeAfterPair({
      ...pair,
      conversationId: ctx.conversationId,
      toolUseId: ctx.toolUseId,
    });
    const what =
      pair.route === null
        ? `${pair.before.label} vs ${pair.after.label}`
        : `${pair.route} — ${pair.before.label} vs ${pair.after.label}, ${pair.width}×${pair.height} ${pair.colorScheme ?? ""}`.trim();
    return {
      content: [
        {
          type: "text",
          text: [
            `Registered before / after ${id}: "${pair.title}" (${what}).`,
            `Cite ${id} in your final message, next to what it shows — it renders as a chip that opens the comparison.`,
            ...notes,
            `Before (${pair.before.label}), then after (${pair.after.label}):`,
          ].join("\n"),
        },
        { type: "image", data: base64(pair.before.png), mimeType: "image/png" },
        { type: "image", data: base64(pair.after.png), mimeType: "image/png" },
      ],
    };
  },
});

type PairBody = Omit<NewBeforeAfterPair, "conversationId" | "toolUseId">;

async function capturedPair(
  conversationId: string,
  input: Extract<RegisterBeforeAfterInput, { form: "capture" }>,
): Promise<{ pair: PairBody; notes: string[] }> {
  const width = input.width ?? DEFAULT_CAPTURE_VIEWPORT.width;
  const height = input.height ?? DEFAULT_CAPTURE_VIEWPORT.height;
  const colorScheme = input.colorScheme ?? "light";
  const shot = await capturePair(conversationId, {
    route: input.route,
    width,
    height,
    colorScheme,
  });
  const notes: string[] = [];
  for (const [side, page] of [
    [CAPTURE_LABELS.before, shot.before],
    [CAPTURE_LABELS.after, shot.after],
  ] as const) {
    if (page.httpStatus !== null && page.httpStatus >= 400) {
      notes.push(
        `Note: ${side} answered HTTP ${page.httpStatus} (${page.url}).`,
      );
    }
    if (page.stillBusy.length > 0) {
      notes.push(
        `Note: ${side} still showed a loader when captured: ${page.stillBusy.join(" | ")}.`,
      );
    }
  }
  return {
    pair: {
      title: input.title,
      route: input.route,
      width,
      height,
      colorScheme,
      before: { png: shot.before.png, label: CAPTURE_LABELS.before },
      after: { png: shot.after.png, label: CAPTURE_LABELS.after },
    },
    notes,
  };
}

async function filesPair(
  input: Extract<RegisterBeforeAfterInput, { form: "files" }>,
): Promise<{ pair: PairBody; notes: string[] }> {
  const [before, after] = await Promise.all([
    readPng(input.beforePath),
    readPng(input.afterPath),
  ]);
  const notes =
    before.width === after.width && before.height === after.height
      ? []
      : [
          `Note: the two images differ in size (before ${before.width}×${before.height}, after ${after.width}×${after.height}) — a swipe compares them at the before's size.`,
        ];
  return {
    pair: {
      title: input.title,
      route: null,
      width: before.width,
      height: before.height,
      colorScheme: null,
      before: { png: before.bytes, label: input.beforeLabel ?? "before" },
      after: { png: after.bytes, label: input.afterLabel ?? "after" },
    },
    notes,
  };
}

/** One PNG file's bytes and pixel size; anything else is refused. */
async function readPng(
  path: string,
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const bytes = new Uint8Array(await readFile(path));
  if (!isPng(bytes)) throw new Error(`${path} is not a PNG file.`);
  const read = readImageSize(bytes);
  if (read.kind !== "size") {
    throw new Error(`${path}: cannot read the PNG's size (${read.kind}).`);
  }
  return { bytes, ...read.size };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
