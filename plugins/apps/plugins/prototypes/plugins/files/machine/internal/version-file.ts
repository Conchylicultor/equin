import { PROTOTYPE_ENTRY_FILE, protoIdKind } from "../../core";
import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";
import {
  isFlatFileName,
  isVersionSha,
  openHistoryStore,
} from "../../shared/history/store";
import { contentTypeForPath } from "../../server/internal/paths";
import { hasPicks, servePickedDocument } from "./picked-document";

// A recorded version's files over HTTP — desktop-only: read out of the
// prototype's private git repo in the data dir, so `../index.ts` mounts it
// through `machineHandler`.

/**
 * `GET /api/prototypes/:name/versions/:sha/:file` → that file as it was in that
 * version. The sha addresses the content, so it is cacheable forever —
 * `immutable`, the opposite of the live route's `no-store` — and so is each
 * picked variant of it: `index.html?palette=azure` is stamped exactly as on
 * the live route, judged against the options THIS version declares. A
 * malformed name, sha or file is a 404 like an unknown one: none of them names
 * a version.
 */
export async function handlePrototypeVersionFile(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const { name, sha, file } = params;
  if (
    name === undefined ||
    sha === undefined ||
    file === undefined ||
    !protoIdKind.is(name) ||
    !isVersionSha(sha) ||
    !isFlatFileName(file)
  ) {
    return new Response("not found", { status: 404 });
  }

  const read = await openHistoryStore(prototypesDir.path).readVersionFile(
    name,
    sha,
    file,
  );
  if (read.kind === "not-found") {
    return new Response("not found", { status: 404 });
  }
  const headers = {
    "content-type": contentTypeForPath(file),
    "cache-control": "public, max-age=31536000, immutable",
  };
  const search = new URL(req.url).searchParams;
  if (file === PROTOTYPE_ENTRY_FILE && hasPicks(search)) {
    const html = new TextDecoder().decode(read.bytes);
    return servePickedDocument(html, search, headers);
  }
  return new Response(read.bytes, { headers });
}
