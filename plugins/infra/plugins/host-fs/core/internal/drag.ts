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
  if (!hasHostPaths(dt.types)) return { kind: "absent" };
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
  return types.includes(HOST_PATHS_MIME);
}
