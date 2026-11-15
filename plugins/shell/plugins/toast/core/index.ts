import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import type { Audience } from "@plugins/audience/core";

export type ToastVariant = "default" | "success" | "error" | "warning" | "info";

export interface ToastArgs {
  title?: string;
  description: string;
  variant?: ToastVariant;
  /**
   * Why it is shown. `reply` (the default) answers something the user just
   * did and is shown whatever the page's state; `announcement` is something
   * that happened on its own (the server reconnecting) and is raised only on
   * a page on screen. Either way a text toast leaves after sonner's default
   * duration, whatever its variant — a text toast is never sticky.
   */
  kind?: "announcement" | "reply";
  /**
   * Who the toast is for: a `developer` toast is shown only in Developer mode,
   * with the developer mark beside its title, so a developer can tell it from
   * what every user sees. Default `user` — shown to everyone, no mark.
   */
  audience?: Audience;
  /**
   * Optional single action button rendered in the toast: a plain action
   * (`onClick`, e.g. "Undo"), or a `link` to somewhere in the app — plain
   * click opens it here, ⌘/Ctrl-click in a new browser tab.
   */
  action?:
    | { label: string; onClick: () => void }
    | { label: string; link: LinkTarget };
}
