import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";

/** The attachment a file chip stands for. */
export interface AttachedFileRef {
  attachmentId: string;
  filename: string;
}

/**
 * How a file chip OPENS its attachment. This primitive sits below every app, so
 * it cannot name the pane that previews a file; a plugin that can contributes
 * the link here. The first contribution wins; with none, a chip opens the raw
 * file in a browser tab.
 */
export interface AttachmentOpener {
  useTarget: Hook<() => (file: AttachedFileRef) => LinkTarget>;
}

export const AttachmentSlots = {
  Opener: defineSlot<AttachmentOpener>({ docLabel: () => "opener" }),
};
