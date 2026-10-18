import { z } from "zod";

/**
 * The drag-and-drop MIME type carrying host paths between surfaces (a file
 * browser row dragged onto a folder, onto a Favorites sidebar, …): JSON
 * `{ paths: string[] }`, every path absolute.
 */
export const HOST_PATHS_MIME = "application/x-singularity-host-paths+json";

const HostPathsPayloadSchema = z.object({
  paths: z.array(z.string()).min(1),
});

/** Put `paths` on a drag (in `dragstart`). */
export function writeHostPaths(
  dt: Pick<DataTransfer, "setData">,
  paths: readonly string[],
): void {
  if (paths.length === 0) throw new Error("writeHostPaths: no paths to drag");
  dt.setData(HOST_PATHS_MIME, JSON.stringify({ paths }));
}

/**
 * What a drop carries: `paths` (non-empty), `absent` when the drag holds no
 * host paths (a link, text, files from outside the app), or `malformed` when
 * it claims to but the payload does not decode.
 */
export type ReadHostPathsResult =
  | { kind: "paths"; paths: string[] }
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
  return { kind: "paths", paths: parsed.data.paths };
}

/**
 * Whether a drag carries host paths, from its `types` alone — what `dragover`
 * / `dragenter` can test, since the browser hides the data until `drop`.
 */
export function hasHostPaths(types: readonly string[]): boolean {
  return types.includes(HOST_PATHS_MIME);
}
