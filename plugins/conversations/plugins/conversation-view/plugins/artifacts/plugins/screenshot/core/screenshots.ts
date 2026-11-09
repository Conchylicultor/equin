import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import type { ArtifactHit } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/core";

/** This kind's id — the one spelling, shared by the contribution and its hits. */
export const SCREENSHOT_KIND = "screenshot";

/**
 * The extensions a screenshot artifact is drawn as an image for.
 *
 * One of several copies of this set — the Read tool row's `IMAGE_EXTS` is
 * another, a local const inside a component file. It belongs beside the file
 * viewer's image renderer (`file-viewer/image`'s `supportsImage`); see this
 * plugin's CLAUDE.md.
 */
const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "ico",
  "bmp",
  "avif",
]);

/** Does this path name a picture? A classification — every path has an answer. */
export function isImagePath(filePath: string): boolean {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot > 0 && IMAGE_EXTS.has(base.slice(dot + 1));
}

/**
 * PURE. Every picture this one transcript event put in front of the agent.
 *
 * Only `Read` counts, and it counts as `created`: an agent reads an image after
 * taking it — a screenshot of the app it just changed, a diff sheet — so the
 * picture exists *because* of this conversation even though the tool that
 * brought it here is a read. The key is the path exactly as the tool got it,
 * which is what file-viewer's `locationForPath` takes: screenshots usually land
 * in a temp directory, outside any worktree, and are then read from the host.
 */
export function extractScreenshots(event: JsonlEvent): ArtifactHit[] {
  if (event.kind !== "tool-call" || event.name !== "Read") return [];

  const input = event.input as { file_path?: unknown } | null | undefined;
  const filePath = input?.file_path;
  if (typeof filePath !== "string" || !isImagePath(filePath)) return [];

  return [
    { kind: SCREENSHOT_KIND, key: filePath, relation: "created", at: event.at },
  ];
}

/** The file name, which is all the room a thumbnail's caption has. */
export function screenshotName(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}
