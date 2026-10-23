import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { PrototypeProblemSchema } from "./validate";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import type { MocksDeclaration } from "./mocks";
import { PrototypeViewportSchema } from "./viewport";
import type { OptionPicks, PrototypeOption } from "./options";

/**
 * The wire shape of a parsed `mocks` declaration. Mirrors `MocksDeclaration`
 * exactly — the `satisfies` below is what keeps the two from drifting.
 */
export const MocksDeclarationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("malformed"),
    raw: z.string(),
    reason: z.string(),
  }),
  z.object({ kind: z.literal("declared"), tag: z.string(), ref: z.string() }),
]) satisfies ZodParser<MocksDeclaration>;

/** The wire shape of one valid option. Mirrors `PrototypeOption` exactly. */
export const PrototypeOptionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("choice"),
    name: z.string(),
    values: z.tuple([z.string(), z.string()]).rest(z.string()).readonly(),
    default: z.string(),
    group: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("color"),
    name: z.string(),
    suggestions: z
      .array(z.object({ name: z.string(), color: z.string() }))
      .readonly(),
    default: z.string(),
    group: z.string().nullable(),
  }),
]) satisfies ZodParser<PrototypeOption>;

/**
 * Metadata for a single prototype, parsed out of `<slug>/index.html` under the
 * host-global prototypes dir. There is no `meta.json`: a prototype is one
 * self-contained HTML file, so its metadata is expressed the way HTML already
 * expresses metadata.
 *
 * - `name` — the directory slug (injected by the server; what URLs address)
 * - `title` — `<title>`, the display name (falls back to `UNTITLED_PROTOTYPE`,
 *   never to `name`, which is an opaque id)
 * - `blurb` — `<meta name="description">` (defaults to `""`)
 * - `viewport` — `<meta name="prototype-viewport" content="window">`: a
 *   size preset's name, `window` or `responsive` (see `viewport.ts`). Absent or
 *   unreadable ⇒ responsive; an unreadable line is also a `problems[]` entry
 * - `mocks` — `<meta name="mocks" content="<kind>:<ref>">`, the real app thing
 *   this prototype is a mockup OF (`exhibit:task-draft/composer`,
 *   `route:/agents/c/123`), so the Compare stage can show the two side by
 *   side. Parsed by `parseMocks` into a three-way value: `none` (the ordinary
 *   case — most prototypes mock nothing), `malformed` (also a `problems[]`
 *   entry), or `declared` with the kind tag and the ref. The tag is carried
 *   unjudged: kinds are an open set contributed on the web, and the ref is
 *   resolved only there — the exhibit catalog is per-worktree while prototypes
 *   are host-global, so the pairing can only ever be a runtime lookup.
 * - `options` — every valid `<meta name="prototype-option">`, in picker order,
 *   each with its default read off the page's own `<html>` — `data-<name>` for
 *   a choice, `style="--<name>: …"` for a color (see `options.ts`). A line that cannot be an option is left out here and
 *   reported in `problems`. Empty for most prototypes.
 * - `problems` — every way the folder breaks the self-contained contract, empty
 *   when it holds. Prototypes are user content, not code, so this rides the
 *   wire to the gallery card instead of gating a push.
 */
// All fields required: this is the wire/output shape (the resource + endpoint
// broadcast fully-populated metas). `list.ts` supplies a default for every key
// the HTML omits before constructing one, so input === output here.
export const PrototypeMetaSchema = z.object({
  name: z.string(),
  /**
   * A short hash of this prototype's own files (names, sizes, mtimes). The live
   * document's url carries it, so a frame reloads exactly when ITS files change
   * — never for another prototype's edit, and never for a backend restart (the
   * same bytes give the same rev in every process).
   */
  rev: z.string(),
  /**
   * When the prototype folder was created (its birth time), epoch ms — for
   * sorting the gallery by age.
   */
  createdAt: z.number(),
  /**
   * When any of its files last changed, epoch ms: the newest mtime among the
   * files `rev` hashes (the folder's birth time when it holds none), so this
   * moves exactly when `rev` does.
   */
  modifiedAt: z.number(),
  title: z.string(),
  blurb: z.string(),
  viewport: PrototypeViewportSchema,
  mocks: MocksDeclarationSchema,
  options: z.array(PrototypeOptionSchema),
  problems: z.array(PrototypeProblemSchema),
});
export type PrototypeMeta = z.infer<typeof PrototypeMetaSchema>;

/**
 * The list of all prototypes. Served from the data dir (`source: "external"`)
 * and re-broadcast (push) whenever a file under `prototypes/` changes, so the
 * gallery reflects new/edited mocks live. No placeholder: until the list is
 * read it is pending, never "no prototypes". An external array needs no
 * stated bound — it is bounded by the folders on disk.
 */
export const prototypesList = liveValue("prototypes.list", {
  schema: z.array(PrototypeMetaSchema),
});

/** Base path for the raw file-serving routes. */
export const PROTOTYPES_API_BASE = "/api/prototypes";

/**
 * Route key for the bare per-prototype route. Kept as a named const (not a
 * string literal in `httpRoutes`) because the response is a redirect, not JSON —
 * it can't go through `defineEndpoint`/`implement()`. Same pattern as
 * asset-mirror's `MIRROR_ROUTE_KEY`.
 */
export const PROTOTYPE_FILE_ROUTE = "GET /api/prototypes/:name";

/**
 * Route key for one file inside a prototype folder. The trailing segment is what
 * makes a prototype self-contained: because the document is served at
 * `/api/prototypes/<name>/index.html`, a relative `href="styles.css"` inside it
 * resolves to `/api/prototypes/<name>/styles.css` — the same relative reference
 * that works when the file is opened straight off disk with `file://`.
 *
 * The router matches each `:param` as exactly one segment and has no wildcard,
 * so a prototype folder is flat by construction (`<name>/assets/x.svg` is
 * unserveable — the `prototypes:self-contained` check enforces that).
 */
export const PROTOTYPE_ASSET_ROUTE = "GET /api/prototypes/:name/:file";

/**
 * Route key for one file of one recorded VERSION of a prototype. A path prefix
 * per version, for the same reason the live route has one: a relative
 * `href="styles.css"` inside that version's `index.html` resolves to the same
 * version's `styles.css`. The sha addresses the content, so the response is
 * immutable. Raw handler, like the live file route. Built by
 * {@link prototypeVersionUrl}.
 *
 * Six segments against the live route's four, and the router matches on the
 * segment count, so the two never compete for a URL.
 */
export const PROTOTYPE_VERSION_FILE_ROUTE =
  "GET /api/prototypes/:name/versions/:sha/:file";

/**
 * Typed list endpoint. JSON, so it goes through `implement()` (raw JSON
 * handlers are banned by `endpoints:no-raw-json-handlers`). The `:name` file
 * routes stay raw handlers — they return per-file bytes/html with a custom
 * Content-Type, which `implement()`'s 200/204 JSON contract doesn't fit.
 */
export const listPrototypes = defineEndpoint({
  route: "GET /api/prototypes",
  response: z.array(PrototypeMetaSchema),
});

/**
 * Build the URL the iframe loads: the prototype's own `index.html`, addressed
 * through the folder so its relative sub-resources resolve. `v` cache-busts on
 * edit; `picks` become `?<option>=<value>`, which the server stamps onto the
 * page's `<html>` (`data-<option>`, or `--<option>` for a color) — so a frame reloaded by an edit comes back on
 * the variant it was showing, and the URL on its own is a link to that variant.
 */
export function prototypeUrl(
  name: string,
  opts: { v?: string; picks?: OptionPicks } = {},
): string {
  const params = new URLSearchParams();
  if (opts.v !== undefined) params.set("v", opts.v);
  for (const [option, value] of Object.entries(opts.picks ?? {})) {
    params.set(option, value);
  }
  const qs = params.size === 0 ? "" : `?${params.toString()}`;
  return `${PROTOTYPES_API_BASE}/${encodeURIComponent(name)}/index.html${qs}`;
}

/**
 * Build the URL of a recorded version's document — the one builder for
 * {@link PROTOTYPE_VERSION_FILE_ROUTE}. No `v`: a version never changes. `picks`
 * are stamped exactly as on the live route, but judged against THAT version's
 * own declaration (`PrototypeVersion.options`) — the live page's options may
 * not exist in it.
 */
export function prototypeVersionUrl(
  name: string,
  sha: string,
  opts: { picks?: OptionPicks } = {},
): string {
  const qs = new URLSearchParams(opts.picks ?? {});
  const query = qs.size === 0 ? "" : `?${qs.toString()}`;
  return `${PROTOTYPES_API_BASE}/${encodeURIComponent(name)}/versions/${sha}/index.html${query}`;
}

/**
 * Mint a prototype: create a freshly id'd folder holding the blank template,
 * and answer with its id.
 *
 * The gallery's New prototype flow calls this BEFORE it launches the agent, so
 * the agent is handed a folder that already exists and is never asked to name
 * anything — which is what stops it from naming it wrong. `title` is optional
 * because at that moment nobody knows the name yet; the agent's first save is
 * what fills the card in.
 *
 * A POST, so it does not share the list route's handler: the keys in
 * `httpRoutes` carry the method.
 */
export const createPrototype = defineEndpoint({
  route: "POST /api/prototypes",
  body: z.object({ title: z.string().optional() }),
  response: z.object({ id: z.string() }),
});

/**
 * Delete a prototype: move its folder out of the gallery into the data dir's
 * `_trash/` (`shared/trash.ts`). A soft delete — the folder on disk is the only
 * copy of the work, so it is set aside rather than erased, and a mistaken
 * delete is undone by moving `_trash/<id>` back. 404 for an unknown prototype;
 * 403 for an automated session, whose write could not be put back (the
 * agent-write ledger snapshots files, not folders) on a tree every worktree
 * shares.
 */
export const deletePrototype = defineEndpoint({
  route: "DELETE /api/prototypes/:name",
});
