import type { IconRef } from "@plugins/ui/plugins/icons/core";
import type { FileViewerGit } from "@plugins/primitives/plugins/file-viewer/core";
import type { BrowsableFileSystem } from "@plugins/infra/plugins/paths/plugins/file-systems/core";

/** A folder a browser shows: its file system, and its absolute path there. */
export interface ExplorerFolder {
  fs: BrowsableFileSystem;
  dir: string;
}

/**
 * A rule hiding some entries behind a toolbar toggle, like Show hidden files.
 * Hidden by default; the toggle's state persists per device under the rule's
 * `id`.
 */
export interface LensHideRule {
  /** Stable across sessions: the toggle's persisted state is keyed by it. */
  id: string;
  /** What the rule hides, as a noun: "ignored files" → "Show ignored files". */
  label: string;
  icon: IconRef;
  /** Whether the entry at `path` (absolute) is one this rule hides. */
  isHidden(path: string): boolean;
}

/**
 * What one `FileBrowserSlots.Lens` contribution makes of the folder the
 * browser shows. It answers for any depth below that folder, so lazily
 * expanded subfolders are covered. Every path is absolute.
 */
export interface ExplorerLens {
  hide?: LensHideRule;
  /** The git context of the file at `path`, when this lens knows it. */
  fileGit?(path: string): FileViewerGit | undefined;
}
