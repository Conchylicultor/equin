import { z } from "zod";
import { BEFORE_AFTER_COLOR_SCHEMES } from "./entity";

/** The MCP tool that registers a pair — the one spelling, read by the tool and its extractor. */
export const REGISTER_BEFORE_AFTER_TOOL = "register_before_after";

/** The viewport a capture defaults to — the e2e harness's and the agent browser's. */
export const DEFAULT_CAPTURE_VIEWPORT = { width: 1400, height: 900 } as const;

/** The two sides of a capture: main, and the conversation's own build. */
export const CAPTURE_LABELS = { before: "main", after: "this build" } as const;

const title = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe(
    'What the pair shows, in a few words: the screen and state ("Agents list, empty state").',
  );

/** Capture `route` on main and on this conversation's build. */
const CaptureInputSchema = z.strictObject({
  title,
  route: z
    .string()
    .startsWith("/")
    .describe(
      'capture: the app route to capture ("/agents/c/…"), on main (before) and on this conversation\'s build (after).',
    ),
  width: z
    .number()
    .int()
    .min(200)
    .max(4000)
    .optional()
    .describe(
      `capture: viewport width in CSS pixels (default ${DEFAULT_CAPTURE_VIEWPORT.width}).`,
    ),
  height: z
    .number()
    .int()
    .min(200)
    .max(4000)
    .optional()
    .describe(
      `capture: viewport height in CSS pixels (default ${DEFAULT_CAPTURE_VIEWPORT.height}).`,
    ),
  colorScheme: z
    .enum(BEFORE_AFTER_COLOR_SCHEMES)
    .optional()
    .describe("capture: light or dark (default light)."),
});

/** Two PNG files the agent already made. */
const FilesInputSchema = z.strictObject({
  title,
  beforePath: z
    .string()
    .startsWith("/")
    .describe("files: absolute path of the before PNG."),
  afterPath: z
    .string()
    .startsWith("/")
    .describe("files: absolute path of the after PNG."),
  beforeLabel: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .optional()
    .describe('files: what the before side is (default "before").'),
  afterLabel: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .optional()
    .describe('files: what the after side is (default "after").'),
});

/**
 * The MCP input shape: every field of both forms (MCP takes one flat object),
 * each described with the form it belongs to. {@link parseRegisterInput} reads
 * it as exactly one form.
 */
export const registerBeforeAfterInputShape = {
  ...CaptureInputSchema.shape,
  ...FilesInputSchema.shape,
  route: CaptureInputSchema.shape.route.optional(),
  beforePath: FilesInputSchema.shape.beforePath.optional(),
  afterPath: FilesInputSchema.shape.afterPath.optional(),
};

/** What a call asked for: a capture, or two files. */
export type RegisterBeforeAfterInput =
  | ({ form: "capture" } & z.output<typeof CaptureInputSchema>)
  | ({ form: "files" } & z.output<typeof FilesInputSchema>);

/** Two forms at once, neither, or a field of the other form. */
export class RegisterInputError extends Error {}

/**
 * Read a call's arguments as exactly ONE of the two forms — `route` (capture)
 * or `beforePath` + `afterPath` (files) — with no field of the other. Throws a
 * {@link RegisterInputError} naming both forms otherwise: a call mixing them
 * has no one meaning.
 */
export function parseRegisterInput(args: unknown): RegisterBeforeAfterInput {
  const has = (key: string) =>
    typeof args === "object" &&
    args !== null &&
    (args as Record<string, unknown>)[key] !== undefined;
  const capture = has("route");
  const files = has("beforePath") || has("afterPath");
  if (capture === files) {
    throw new RegisterInputError(
      capture
        ? "Pass EITHER `route` (capture main vs this build) OR `beforePath` + `afterPath` (two PNG files), not both."
        : "Pass `route` (capture that route on main and on this build) or `beforePath` + `afterPath` (two PNG files you made).",
    );
  }
  const parsed = (capture ? CaptureInputSchema : FilesInputSchema).safeParse(
    args,
  );
  if (!parsed.success) {
    throw new RegisterInputError(
      `Invalid ${capture ? "capture (`route`)" : "files (`beforePath` / `afterPath`)"} arguments: ${z.prettifyError(parsed.error)}`,
    );
  }
  return capture
    ? {
        form: "capture",
        ...(parsed.data as z.output<typeof CaptureInputSchema>),
      }
    : { form: "files", ...(parsed.data as z.output<typeof FilesInputSchema>) };
}
