import { z } from "zod";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import { FileEntrySchema } from "./reads";
import type { BrowsableFileSystem } from "./folders";

/**
 * The drag-and-drop MIME type carrying files between surfaces (a file browser
 * row dragged onto a folder, onto a Favorites sidebar, …): JSON
 * `{ fs, entries: { path, kind }[] }`, every path absolute in its system.
 */
export const FILE_LOCATIONS_MIME = `${LEGACY_IDS.mimePrefix}file-locations+json`;

const DraggedFileSchema = z.object({
  path: z.string(),
  kind: FileEntrySchema.shape.kind,
});

/**
 * One dragged file, with the kind of entry it is as the surface it was
 * dragged from listed it — so a drop that needs the kind (pinning a folder vs
 * a file) has it without reading the system again.
 */
export type DraggedFile = z.infer<typeof DraggedFileSchema>;

const PayloadSchema = z.object({
  fs: z.enum(["computer", "browser"]),
  entries: z.array(DraggedFileSchema).min(1),
});

/** What one drag carries: files of ONE file system. */
export interface DraggedFiles {
  fs: BrowsableFileSystem;
  entries: DraggedFile[];
}

/**
 * The page's own drag handed to the OS as real files
 * ({@link handOffComputerFiles}), or `null`. Back over this page it arrives as
 * a drag from outside — `Files`, no {@link FILE_LOCATIONS_MIME}, and `File`s
 * without a path — so the readers below take it from here instead: the page
 * knows what it is dragging.
 */
let handedOff: readonly DraggedFile[] | null = null;

/**
 * Drag files of the computer's disk as real files through `start` (the host's
 * native drag — `useNativeFileDrag`, in an installed app window), in place of
 * the browser drag — only the computer's disk has files the OS can take.
 * Answers the drag's end; until then, a `Files` drag over this page is this
 * one, read by {@link hasFileLocations} / {@link readFileLocations} as if it
 * carried {@link FILE_LOCATIONS_MIME}.
 *
 * Its end and its drop on this page come by two roads (the host's answer, the
 * page's `drop` event) in no promised order, so the end does not forget the
 * drag: the next drag to enter the page — another one — does.
 */
export function handOffComputerFiles<T>(
  entries: readonly DraggedFile[],
  start: (paths: readonly string[]) => Promise<T>,
): Promise<T> {
  if (entries.length === 0) {
    throw new Error("handOffComputerFiles: no files to drag");
  }
  handedOff = entries;
  const forget = () => {
    if (handedOff === entries) handedOff = null;
  };
  return start(entries.map((e) => e.path)).finally(() => {
    globalThis.addEventListener("dragenter", forget, {
      capture: true,
      once: true,
    });
  });
}

/** The handed-off drag, when a drag of `types` is it. */
function handedOffIn(types: readonly string[]): readonly DraggedFile[] | null {
  return handedOff !== null && types.includes("Files") ? handedOff : null;
}

/** Put files of `fs` on a drag (in `dragstart`). */
export function writeFileLocations(
  dt: Pick<DataTransfer, "setData">,
  fs: BrowsableFileSystem,
  entries: readonly DraggedFile[],
): void {
  if (entries.length === 0) {
    throw new Error("writeFileLocations: no files to drag");
  }
  dt.setData(FILE_LOCATIONS_MIME, JSON.stringify({ fs, entries }));
}

/**
 * What a drop carries: `files` (of one system, non-empty), `absent` when the
 * drag holds none (a link, text, files from outside the app), or `malformed`
 * when it claims to but the payload does not decode.
 */
export type ReadFileLocationsResult =
  | ({ kind: "files" } & DraggedFiles)
  | { kind: "absent" }
  | { kind: "malformed"; error: string };

/** Read the files a drop carries (in `drop` — the data is unreadable before). */
export function readFileLocations(
  dt: Pick<DataTransfer, "getData" | "types">,
): ReadFileLocationsResult {
  if (!dt.types.includes(FILE_LOCATIONS_MIME)) {
    const own = handedOffIn(dt.types);
    return own === null
      ? { kind: "absent" }
      : { kind: "files", fs: "computer", entries: [...own] };
  }
  const raw = dt.getData(FILE_LOCATIONS_MIME);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) {
      return { kind: "malformed", error: err.message };
    }
    throw err;
  }
  const parsed = PayloadSchema.safeParse(json);
  if (!parsed.success) {
    return { kind: "malformed", error: parsed.error.message };
  }
  return { kind: "files", ...parsed.data };
}

/**
 * Whether a drag carries files, from its `types` alone — what `dragover` /
 * `dragenter` can test, since the browser hides the data until `drop` (so a
 * drop target cannot tell their file system before the drop).
 */
export function hasFileLocations(types: readonly string[]): boolean {
  return types.includes(FILE_LOCATIONS_MIME) || handedOffIn(types) !== null;
}
