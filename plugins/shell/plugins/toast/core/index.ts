import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import type { Audience } from "@plugins/audience/core";

export type ToastVariant = "default" | "success" | "error" | "warning" | "info";

export interface ToastArgs {
  title?: string;
  description: string;
  variant?: ToastVariant;
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
