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
  /** Optional single action button rendered in the toast (e.g. "Undo"). */
  action?: { label: string; onClick: () => void };
}
