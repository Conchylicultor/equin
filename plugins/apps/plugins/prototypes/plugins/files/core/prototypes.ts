import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  wholeList,
  wholeTuple,
} from "@plugins/packages/plugins/list-bound/core";
import {
  assetPath,
  blob,
  defineEndpoint,
  type AssetPath,
} from "@plugins/infra/plugins/endpoints/core";
import { PROTOTYPE_ENTRY_FILE, PrototypeProblemSchema } from "./validate";
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
]) satisfies z.ZodType<MocksDeclaration>;

/** Why an option's values are loaded whole. */
const OPTION_REASON =
  'the values one hand-written <meta name="prototype-option"> line declares — a handful';

/** Why a prototype's options are loaded whole. */
export const PROTOTYPE_OPTIONS_REASON =
  "the options one prototype's index.html declares — a handful of hand-written lines";

/** The wire shape of one valid option. Mirrors `PrototypeOption` exactly. */
export const PrototypeOptionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("choice"),
    name: z.string(),
    values: wholeTuple([z.string(), z.string()], z.string(), {
      reason: OPTION_REASON,
    }).readonly(),
    default: z.string(),
    group: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("color"),
    name: z.string(),
    suggestions: wholeList(z.object({ name: z.string(), color: z.string() }), {
      reason: OPTION_REASON,
    }).readonly(),
    default: z.string(),
    group: z.string().nullable(),
  }),
]) satisfies z.ZodType<PrototypeOption>;

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
  options: wholeList(PrototypeOptionSchema, {
    reason: PROTOTYPE_OPTIONS_REASON,
  }),
  problems: wholeList(PrototypeProblemSchema, {
    reason:
      "the ways one prototype folder breaks the contract — a handful of checks",
  }),
});
export type PrototypeMeta = z.infer<typeof PrototypeMetaSchema>;

/**
 * The list of all prototypes. Served from the data dir (`source: "external"`)
 * and re-broadcast (push) whenever a file under `prototypes/` changes, so the
 * gallery reflects new/edited mocks live. No placeholder: until the list is
 * read it is pending, never "no prototypes". Whole: the gallery lists, filters
 * and groups every prototype.
 */
export const prototypesList = liveValue("prototypes.list", {
  schema: wholeList(PrototypeMetaSchema, {
    reason:
      "every prototype folder on disk — each made by hand, and the gallery lists, filters and groups them all",
  }),
});

/**
 * The raw file routes, served on every host: the tree is read through the
 * app's file root (the disk on the desktop, memory in a browser host), so
 * their raw handlers (per-file bytes / html with a custom Content-Type, or a
 * redirect, which `implement()`'s JSON contract does not fit) are the plugin's
 * portable `server/` barrel's.
 */

/**
 * The query a document is asked for with: `?<option>=<value>` picks (plus `v`,
 * the live route's cache-bust), which the server stamps onto its `<html>`.
 */
const DocumentQuerySchema = z.record(z.string(), z.string());

/**
 * The bare per-prototype route: a 302 to its `index.html`, carrying the query
 * across — so a hand-typed or older URL still lands somewhere sensible.
 */
export const getPrototypeEntry = defineEndpoint({
  route: "GET /api/prototypes/:name",
  query: DocumentQuerySchema,
});

/**
 * One file inside a prototype folder. The trailing segment is what makes a
 * prototype self-contained: because the document is served at
 * `/api/prototypes/<name>/index.html`, a relative `href="styles.css"` inside it
 * resolves to `/api/prototypes/<name>/styles.css` — the same relative reference
 * that works when the file is opened straight off disk with `file://`.
 *
 * The router matches each `:param` as exactly one segment and has no wildcard,
 * so a prototype folder is flat by construction (`<name>/assets/x.svg` is
 * unserveable — the `prototypes:self-contained` check enforces that).
 */
export const getPrototypeFile = defineEndpoint({
  route: "GET /api/prototypes/:name/:file",
  query: DocumentQuerySchema,
  response: blob(),
});

/**
 * One file of one recorded VERSION of a prototype. A path prefix per version,
 * for the same reason the live route has one: a relative `href="styles.css"`
 * inside that version's `index.html` resolves to the same version's
 * `styles.css`. The sha addresses the content, so the response is immutable.
 *
 * Six segments against the live route's four, and the router matches on the
 * segment count, so the two never compete for a URL.
 */
export const getPrototypeVersionFile = defineEndpoint({
  route: "GET /api/prototypes/:name/versions/:sha/:file",
  query: DocumentQuerySchema,
  response: blob(),
});

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
 * The query a prototype document is asked for with: `v` cache-busts the live
 * document on edit; `picks` become `?<option>=<value>`, which the server
 * stamps onto the page's `<html>` (`data-<option>`, or `--<option>` for a
 * color) — so a frame reloaded by an edit comes back on the variant it was
 * showing, and the URL on its own is a link to that variant.
 */
export function prototypeDocumentQuery(
  opts: { v?: string; picks?: OptionPicks } = {},
): Record<string, string> {
  return { ...(opts.v === undefined ? {} : { v: opts.v }), ...opts.picks };
}

/**
 * The document a frame loads: the prototype's own `index.html`, addressed
 * through the folder so its relative sub-resources resolve. An iframe loads it
 * by URL (its sub-resources too), so its src comes from `frameUrlOver` (the
 * transport's frame base: the page's origin, or a browser host's frame scope).
 */
export function prototypeDocument(
  name: string,
  opts: { v?: string; picks?: OptionPicks } = {},
): AssetPath {
  return assetPath(
    getPrototypeFile,
    { name, file: PROTOTYPE_ENTRY_FILE },
    prototypeDocumentQuery(opts),
  );
}

/**
 * A recorded version's document. No `v`: a version never changes. `picks`
 * are stamped exactly as on the live route, but judged against THAT version's
 * own declaration (`PrototypeVersion.options`) — the live page's options may
 * not exist in it.
 */
export function prototypeVersionDocument(
  name: string,
  sha: string,
  opts: { picks?: OptionPicks } = {},
): AssetPath {
  return assetPath(
    getPrototypeVersionFile,
    { name, sha, file: PROTOTYPE_ENTRY_FILE },
    prototypeDocumentQuery({ picks: opts.picks }),
  );
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
 *
 * Desktop-only (`needsMachine`): a mint copies the running checkout's
 * `prototypes/_template/` off disk, and exists to hand the folder to an agent
 * it then launches — neither of which a host without the computer has.
 */
export const createPrototype = defineEndpoint({
  route: "POST /api/prototypes",
  body: z.object({ title: z.string().optional() }),
  response: z.object({ id: z.string() }),
  needsMachine: { feature: "New prototype" },
});
