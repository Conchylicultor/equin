import { z } from "zod";
import { HttpError } from "@plugins/infra/plugins/endpoints/core";

/**
 * One option of a terminal menu, as the CLI numbers it. `label` is the
 * option's own line; `description` the indented lines under it, when any.
 */
export const TerminalMenuOptionSchema = z.object({
  n: z.number().int().positive(),
  label: z.string(),
  description: z.string().nullable(),
});
export type TerminalMenuOption = z.infer<typeof TerminalMenuOptionSchema>;

/**
 * An interactive numbered menu open in a conversation's terminal (e.g. the
 * usage-limit "What do you want to do?" menu), read off the screen.
 *
 * - `title` — the question line above the options ("" when the menu has none).
 * - `body` — what the menu asks about, above the title: the dialog's content
 *   from its top border down (a permission prompt's command and the reason it
 *   is asked), one line per screen line, dedented. "" when the menu has none.
 * - `highlighted` — the `n` of the option the cursor is on.
 * - `footer` — the menu's key hints ("Enter to confirm · Esc to cancel").
 */
export const TerminalMenuSchema = z.object({
  title: z.string(),
  // Defaulted for a menu stored before the field existed: a live row read
  // back across the deploy that added it.
  body: z.string().default(""),
  options: z.array(TerminalMenuOptionSchema).min(1),
  highlighted: z.number().int().positive(),
  footer: z.string(),
});
export type TerminalMenu = z.infer<typeof TerminalMenuSchema>;

/**
 * The `waitingFor` a conversation carries while a terminal menu is open — the
 * key its pending-prompt card dispatches on. The menu itself rides beside it
 * as `waitingMenu`.
 */
export const TERMINAL_MENU_WAITING_FOR = "menu";

/**
 * Two reads of a menu show the same menu. Field by field rather than by
 * serialization: a menu read back from jsonb does not keep its key order.
 */
export function sameTerminalMenu(
  a: TerminalMenu | null,
  b: TerminalMenu | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.title === b.title &&
    a.body === b.body &&
    a.footer === b.footer &&
    a.highlighted === b.highlighted &&
    a.options.length === b.options.length &&
    a.options.every((o, i) => {
      const p = b.options[i]!;
      return (
        o.n === p.n && o.label === p.label && o.description === p.description
      );
    })
  );
}

/**
 * The menu the user answered is not the one on screen any more — answered in
 * the terminal, closed, or changed — so nothing was sent to it. A 409: the
 * answer is refused for the state it met, not malformed.
 */
export class TerminalMenuChangedError extends HttpError {
  constructor(message: string) {
    super(409, message);
    this.name = "TerminalMenuChangedError";
  }
}
