import { serveValue } from "@plugins/network/plugins/live/server";
import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import {
  PROTOTYPE_ENTRY_FILE,
  protoIdKind,
  prototypeHistory,
  prototypeVersionCounts,
  restorePrototypeVersion,
  type PrototypeVersion,
} from "../../core";
import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";
import {
  isFlatFileName,
  isVersionSha,
  openHistoryStore,
  type CheckpointInput,
  type HistoryStore,
} from "../../shared/history/store";
import { contentTypeForPath } from "./paths";
import { hasPicks, servePickedDocument } from "./picked-document";

// The server's face of the version store (`shared/history/`): the per-prototype
// history resource, a version's files over HTTP, the restore endpoint, and
// `checkpointPrototype` for the `checkpoints` plugin's end-of-turn job.
//
// Nothing here notifies the resource after a write. Every write stamps
// `_history/<id>.git/latest.json`, and the one watcher over the tree turns that
// stamp into a notify — on EVERY backend, which is the point: the version may
// have been recorded by main while this backend's tab is the one watching.

/** The store over the data dir, resolved per call (the data root is env-overridable). */
function store(): HistoryStore {
  return openHistoryStore(prototypesDir.path);
}

/**
 * `prototypes.history` — one prototype's versions and its dirty flag. Push,
 * keyed by `name`; notified by the watcher (`watcher.ts`) when the folder is
 * edited or a version is recorded.
 *
 * Reading adopts: a prototype with no history yet gets its `v0` on first read,
 * so the stepper never meets a prototype with no versions. A missing folder or
 * a name that is not a minted id throws — the detail pane only mounts for a
 * prototype the list vouches for, so there is no empty answer to give.
 */
export const prototypeHistoryServed = serveValue(prototypeHistory, {
  source: "external",
  changes: "notified",
  loader: async ({ name }) => {
    if (!protoIdKind.is(name)) {
      throw new Error(`prototypes.history: not a prototype id: ${name}`);
    }
    const read = await store().readHistory(name);
    if (read.kind === "no-such-prototype") {
      throw new Error(`prototypes.history: no such prototype: ${name}`);
    }
    return read.history;
  },
});

/**
 * `prototypes.versionCounts` — every prototype's version count, from the
 * repos' `latest.json` stamps (`HistoryStore.readVersionCounts`): async file
 * reads, no git, so the whole-gallery read never spawns a process per
 * prototype. Push; notified by the watcher whenever a stamp is written — by
 * any backend, as for the per-prototype history.
 */
export const prototypeVersionCountsServed = serveValue(prototypeVersionCounts, {
  source: "external",
  changes: "notified",
  loader: async () => store().readVersionCounts(),
});

/**
 * Record the prototype folder as a new version, if it changed since the last
 * one. The `checkpoints` plugin calls this at the end of every agent turn that
 * touched the prototype; `messageId` makes that idempotent (the turn event is
 * at-least-once, and several backends can emit it for one turn).
 */
export async function checkpointPrototype(
  id: string,
  input: CheckpointInput,
): Promise<
  | { kind: "recorded"; version: PrototypeVersion }
  | { kind: "unchanged" }
  | { kind: "no-such-prototype" }
> {
  return store().checkpoint(id, input);
}

/** Give every minted prototype without a history its `v0` (the folder as it is now). */
export async function adoptPrototypeHistories(): Promise<void> {
  await store().adoptAll();
}

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

  const read = await store().readVersionFile(name, sha, file);
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

/** `POST /api/prototypes/:name/versions/:sha/restore` → the new `restore` version. */
export const handleRestoreVersion = implement(
  restorePrototypeVersion,
  async ({ params }) => {
    if (!protoIdKind.is(params.name) || !isVersionSha(params.sha)) {
      throw new HttpError(404, "no such prototype version");
    }
    const result = await store().restoreVersion(params.name, params.sha);
    switch (result.kind) {
      case "restored":
        return result.version;
      case "no-such-prototype":
        throw new HttpError(404, `no such prototype: ${params.name}`);
      case "unknown-version":
        throw new HttpError(
          404,
          `${params.sha} is not a version of ${params.name}`,
        );
    }
  },
);
