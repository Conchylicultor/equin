import { z } from "zod";

/**
 * Where the user was when they asked (the scratch profile's input, written
 * into the agent's CLAUDE.md): the focused app, the route, the focused tab's
 * title, and the page's outline — every named control on screen as its
 * `{ path, element }` pair (`ui-context`'s `formatOutline`), what a Show me
 * names. Captured at the first question, and again by a reply sent from
 * another page (its `<page-context>` token, `formatPageContext`).
 */
export const AskInputSchema = z.object({
  /** The focused app's id ("pages"); null when no app is focused. */
  app: z.string().min(1).nullable(),
  /** The focused app's display name ("Pages"); null with `app`. */
  appName: z.string().min(1).nullable(),
  /** The route the user is on ("/pages/p/…"). */
  path: z.string().min(1),
  /** The focused tab's content title (the open page, conversation…); null at an app's index. */
  title: z.string().min(1).nullable(),
  /** The page outline, as `formatOutline` prints it. */
  outline: z.string(),
});
export type AskInput = z.infer<typeof AskInputSchema>;
