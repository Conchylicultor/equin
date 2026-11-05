import { z } from "zod";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import { HostFsEntryKindSchema } from "./endpoints";

/**
 * The drag-and-drop MIME type carrying host paths between surfaces (a file
 * browser row dragged onto a folder, onto a Favorites sidebar, …): JSON
 * `{ entries: { path, kind }[] }`, every path absolute.
 */
export const HOST_PATHS_MIME = `${LEGACY_IDS.mimePrefix}host-paths+json`;

const DraggedHostPathSchema = z.object({
  path: z.string(),
  kind: HostFsEntryKindSchema,
});

/**
 * One dragged host path, with the kind of entry it is as the surface it was
 * dragged from listed it — so a drop that needs the kind (pinning a folder vs
 * a file) has it without reading the disk again.
 */
export type DraggedHostPath = z.infer<typeof DraggedHostPathSchema>;

const HostPathsPayloadSchema = z.object({
  entries: z.array(DraggedHostPathSchema).min(1),
});

/**
 * The page's own drag handed to the OS as real files (`handOffHostPaths`), or
 * `null`. Back over this page it arrives as a drag from outside — `Files`,
 * no {@link HOST_PATHS_MIME}, and `File`s without a path — so the readers
 * below take it from here instead: the page knows what it is dragging.
 */
let handedOff: readonly DraggedHostPath[] | null = null;

/**
 * Drag `entries` as real files through `start` (the host's native drag —
 * `useNativeFileDrag`, in an installed app window), in place of the browser
 * drag. Answers the drag's end; until then, a `Files` drag over this page is
 * this one, read by {@link hasHostPaths} / {@link readHostPaths} as if it
 * carried {@link HOST_PATHS_MIME}.
 *
 * Its end and its drop on this page come by two roads (the host's answer, the
 * page's `drop` event) in no promised order, so the end does not forget the
 * drag: the next drag to enter the page — another one — does.
 */
export function handOffHostPaths<T>(
  entries: readonly DraggedHostPath[],
  start: (paths: readonly string[]) => Promise<T>,
): Promise<T> {
  if (entries.length === 0) {
    throw new Error("handOffHostPaths: no paths to drag");
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
function handedOffIn(
  types: readonly string[],
): readonly DraggedHostPath[] | null {
  return handedOff !== null && types.includes("Files") ? handedOff : null;
}

/** Put `entries` on a drag (in `dragstart`). */
export function writeHostPaths(
  dt: Pick<DataTransfer, "setData">,
  entries: readonly DraggedHostPath[],
): void {
  if (entries.length === 0) {
    throw new Error("writeHostPaths: no paths to drag");
  }
  dt.setData(HOST_PATHS_MIME, JSON.stringify({ entries }));
}

/**
 * What a drop carries: `paths` (non-empty entries), `absent` when the drag
 * holds no host paths (a link, text, files from outside the app), or
 * `malformed` when it claims to but the payload does not decode.
 */
export type ReadHostPathsResult =
  | { kind: "paths"; entries: DraggedHostPath[] }
  | { kind: "absent" }
  | { kind: "malformed"; error: string };

/** Read the host paths a drop carries (in `drop` — the data is unreadable before). */
export function readHostPaths(
  dt: Pick<DataTransfer, "getData" | "types">,
): ReadHostPathsResult {
  if (!dt.types.includes(HOST_PATHS_MIME)) {
    const own = handedOffIn(dt.types);
    return own === null
      ? { kind: "absent" }
      : { kind: "paths", entries: [...own] };
  }
  const raw = dt.getData(HOST_PATHS_MIME);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) {
      return { kind: "malformed", error: err.message };
    }
    throw err;
  }
  const parsed = HostPathsPayloadSchema.safeParse(json);
  if (!parsed.success) {
    return { kind: "malformed", error: parsed.error.message };
  }
  return { kind: "paths", entries: parsed.data.entries };
}

/**
 * Whether a drag carries host paths, from its `types` alone — what `dragover`
 * / `dragenter` can test, since the browser hides the data until `drop`.
 */
export function hasHostPaths(types: readonly string[]): boolean {
  return types.includes(HOST_PATHS_MIME) || handedOffIn(types) !== null;
}
