// ---------------------------------------------------------------------------
// Pure-data route identity, reachable from BOTH server and web. Holds no React
// and no browser/runtime dependency, so a server plugin can build the exact
// same app-rooted link a pane resolves to at runtime — one source of truth for
// segment param substitution and `:param` name inference.
// ---------------------------------------------------------------------------

import type { AvatarColor } from "@plugins/primitives/plugins/avatar/core";
import type { SymbolRef } from "@plugins/ui/plugins/icons/core";

// ---------------------------------------------------------------------------
// Type machinery — extract `:param`, `:param*` and `:param?` names from a path
// template. An optional `:param?` (legal only as the LAST part of a segment —
// `defineRoute` throws otherwise) becomes an optional key.
// ---------------------------------------------------------------------------

type ParamName<S extends string> = S extends `${infer N}*` ? N : S;

type PartParams<Part extends string> = Part extends `:${infer P}?`
  ? { [K in P]?: string }
  : Part extends `:${infer P}`
    ? { [K in ParamName<P>]: string }
    : {};

type ExtractParams<Path extends string> =
  Path extends `${infer Seg}/${infer Rest}`
    ? PartParams<Seg> & ExtractParams<Rest>
    : PartParams<Path>;

// Keyed params — the `;name` suffix of a segment (`song/:songId;lens`). Every
// one is optional: a keyed param is a VIEW of the entity, absent by default.
type KeyedParams<Names extends string> =
  Names extends `${infer N};${infer Rest}`
    ? { [K in N]?: string } & KeyedParams<Rest>
    : { [K in Names]?: string };

// A segment's positional (`/`-separated) params and its keyed ones, joined.
type SegmentParams<Path extends string> =
  Path extends `${infer Positional};${infer Keyed}`
    ? ExtractParams<Positional> & KeyedParams<Keyed>
    : ExtractParams<Path>;

/**
 * Only the POSITIONAL params of a segment — the `/`-separated `:name`s, without
 * the `;name` keyed suffix. What decides whether a pane addresses an entity
 * (and so must declare `useResolve`): a keyed param is a view of whatever the
 * positional ones name, never an entity of its own.
 */
export type PositionalRouteParams<Path extends string> = {
  [
    K in keyof (Path extends `${infer P};${string}`
      ? ExtractParams<P>
      : ExtractParams<Path>)
  ]: string;
};

// Param inference for a route's own segment. The empty case is a plain `{}`
// with no index signature, deliberately: routes CHAIN their params
// (`ParentParams & RouteParams<Seg>`), and intersecting `Record<string, never>`
// (an `[k: string]: never` index signature) with a child's real params would
// collapse every property to `never`. `{} & { taskId: string }` stays precise.
// The closed, key-rejecting spelling is restored once, at the `PaneObject`
// boundary — see `Closed<>` in `web/pane.ts`.
//
// Exported so `Pane.define` can derive a route's OWN params from the `segment`
// literal its `RouteDef` carries — see the note on {@link RouteDef}.
//
// The template is the literal `string`, NOT `ExtractParams<Path>[K]`. Those are
// the same type for every concrete path — `ExtractParams` only ever produces
// `string`-valued properties — but the indexed-access spelling is one TS cannot
// evaluate while `Path` is still a type parameter, so `RouteParams<Seg>` did
// not satisfy `Record<string, string>` (TS2344: "`ExtractParams<Seg>[K]` is not
// assignable to `string`"). It has to: a route's own params are what
// `Pane.define` hands `ResolveHook`, which is keyed on `Record<string, string>`
// because URL params ARE strings. Saying `string` outright keeps that true and
// checkable rather than forcing the constraint to be loosened to `object`.
//
// The mapping is homomorphic (`K in keyof …`), so an optional `:param?` stays
// an optional key — and `{ stage?: string }` still satisfies
// `Record<string, string>`.
export type RouteParams<Path extends string> = {
  [K in keyof SegmentParams<Path>]: string;
};

// ---------------------------------------------------------------------------
// App identity — the base path an app is mounted under, passed explicitly to
// `link()`. Decoupled from the route so the same route can be linked under any
// app (the root app contributes "" via basePath "/").
// ---------------------------------------------------------------------------

export interface AppRef {
  readonly id: string;
  /**
   * Human-readable app name, e.g. "Pages", "Agent manager". THE single place an
   * app's display name is authored — chrome that points AT an app (rail
   * tooltip, tab fallback title, pane Expand) reads it from here rather than
   * restating it, so the same app can never be named two different things.
   */
  readonly name: string;
  /** App base path, e.g. "/agents", "/pages", or "/" for the root app. */
  readonly basePath: string;
  /**
   * Base paths the app was served at before (`["/website"]` for the website,
   * now at `/about`). A host that answers by HTTP sends a request under one to
   * the same path under `basePath` with a 301 — so a link published before
   * the move keeps working (the crawlable snapshot's `moved`). Omitted: never
   * moved.
   */
  readonly formerBasePaths?: readonly string[];
  /**
   * The app's icon glyph (`symbol("piano")`) — THE single place it is authored.
   * Every surface drawing the app reads it from here: the launchers and rail
   * (through `Apps.App`, which derives its icon from it), the server's web-app
   * manifest and icon PNGs, the release CLI's favicon / window icon. A
   * `symbol("…")` literal, so the icon manifest ships its glyph.
   */
  readonly icon: SymbolRef;
  /**
   * The app's declared tile colour. Omitted, every surface derives one from the
   * app id, so only an app whose colour is part of its identity declares it.
   */
  readonly iconColor?: AvatarColor;
  /**
   * How the app picks light or dark by default (see {@link AppColorMode}).
   * Omitted, it follows the global setting — so only an app whose scheme is
   * part of its identity declares it. The user can still override it per app;
   * theme-engine resolves the two (`effectiveColorMode`).
   */
  readonly colorMode?: AppColorMode;
  /**
   * `false` keeps the app out of every launcher — the rail, the app galleries
   * and launchers, the installable set — for an app that is opened at its URL
   * by something outside equin rather than picked from inside it (the
   * menu-bar panel the native helper loads). Omitted, the app is listed.
   */
  readonly listed?: false;
  /**
   * Who the app is for. `developer` keeps it out of the launchers unless the
   * user is in Developer mode (`@plugins/audience`) — still reachable at its
   * URL. Omitted, the app is for everyone.
   */
  readonly audience?: "developer";
}

/**
 * An app's DEFAULT colour scheme, declared once on `defineApp`:
 *
 *  - `global` — follow the global light/dark setting (what an app that
 *    declares nothing does);
 *  - `system` — follow the OS `prefers-color-scheme`, live;
 *  - `light` / `dark` — always that scheme.
 */
export type AppColorMode = (typeof APP_COLOR_MODES)[number];

/** Every {@link AppColorMode}, in the order a picker lists them. */
export const APP_COLOR_MODES = ["global", "system", "light", "dark"] as const;

export function defineApp(def: {
  id: string;
  name: string;
  basePath: string;
  formerBasePaths?: readonly string[];
  icon: SymbolRef;
  iconColor?: AvatarColor;
  colorMode?: AppColorMode;
  listed?: false;
  audience?: "developer";
}): AppRef {
  for (const former of def.formerBasePaths ?? []) {
    if (!/^\/[^/?#;]+(\/[^/?#;]+)*$/.test(former) || former === def.basePath) {
      throw new Error(
        `defineApp("${def.id}"): former base path "${former}" must be an absolute path (no trailing slash, not "/") other than the app's base path "${def.basePath}".`,
      );
    }
  }
  return Object.freeze({
    id: def.id,
    name: def.name,
    basePath: def.basePath,
    ...(def.formerBasePaths !== undefined &&
      def.formerBasePaths.length > 0 && {
        formerBasePaths: Object.freeze([...def.formerBasePaths]),
      }),
    icon: def.icon,
    ...(def.iconColor !== undefined && { iconColor: def.iconColor }),
    // "global" is what omission means: stored only when it says something.
    ...(def.colorMode !== undefined &&
      def.colorMode !== "global" && { colorMode: def.colorMode }),
    ...(def.listed === false && { listed: false as const }),
    ...(def.audience !== undefined && { audience: def.audience }),
  });
}

// ---------------------------------------------------------------------------
// Pure per-segment substitution — the encoding shared by buildRouteUrl (web)
// and `RouteDef.path`. Given ONE segment pattern and a flat params object,
// returns the resolved URL parts. Supports static parts, ":name",
// ":name*" (wildcard, splits the value on "/"), ":name?" (optional — written
// only when supplied), and encodeURIComponent. Throws on a missing required
// param (fail loud — matches buildRouteUrl).
// ---------------------------------------------------------------------------

/**
 * A wildcard value's URL parts: split on `/`, each encoded — except a `/` that
 * would leave an empty part (a leading or trailing one, or one of a run),
 * which is encoded into its neighbour as `%2F`. The address bar collapses a
 * `//` and drops an empty part (`normalizeRoutePath`), so an absolute path
 * `/Users/x` written as `…//Users/x` would read back as `Users/x`; written as
 * `%2FUsers/x` it decodes (per part, re-joined with `/`) to itself.
 */
function wildcardParts(val: string): string[] {
  const out: string[] = [];
  let carry = "";
  const segments = val.split("/");
  segments.forEach((seg, i) => {
    if (seg === "") {
      // The `/` after an empty part has no part of its own to separate.
      // The `/` after an empty part rides the next part; a trailing one (no
      // next part) rides the previous.
      if (i < segments.length - 1) carry += "%2F";
      else if (out.length > 0) out[out.length - 1] += "%2F";
      return;
    }
    out.push(carry + encodeURIComponent(seg));
    carry = "";
  });
  if (carry !== "") out.push(carry);
  return out;
}

/** One `/`-separated part of a segment pattern, classified. */
type SegmentPart =
  | { kind: "static"; text: string }
  | { kind: "param"; name: string }
  | { kind: "optional"; name: string }
  | { kind: "wildcard"; name: string };

/**
 * THE one reading of a segment pattern's parts, shared by the URL builder
 * (`fillSegment`), the matcher (`web/pane.ts`), the param-name listing and the
 * collision patterns — so what a `:name?` means cannot drift between them.
 */
export function parseSegmentParts(segment: string): SegmentPart[] {
  return positionalOf(segment)
    .split("/")
    .filter(Boolean)
    .map((part): SegmentPart => {
      if (!part.startsWith(":")) return { kind: "static", text: part };
      if (part.endsWith("*"))
        return { kind: "wildcard", name: part.slice(1, -1) };
      if (part.endsWith("?"))
        return { kind: "optional", name: part.slice(1, -1) };
      return { kind: "param", name: part.slice(1) };
    });
}

// ---------------------------------------------------------------------------
// Keyed params — `segment;name;other`. A positional `:name?` can only be the
// segment's last part (anything after it would be ambiguous), so a pane gets at
// most ONE optional view of its entity that way. A keyed param is the
// unbounded form: named in the URL, so any number of them are unambiguous, in
// any combination. Each is written as a matrix parameter on the pane's LAST URL
// part — `/song/abc/12;lens=notation` — so it is scoped to the pane that
// declares it: in a Miller URL holding several panes each part belongs to one
// pane, where a `?query` would be one bag every pane competes for. And it stays
// in the pathname, the one thing every routing consumer (tabs, history,
// pane-restore, links) already carries.
//
// `encodeURIComponent` escapes `;` and `=`, so neither ever appears raw inside
// a written value: a raw `;` in a part is always the keyed suffix.
// ---------------------------------------------------------------------------

/** The segment without its `;name` keyed suffix. */
function positionalOf(segment: string): string {
  const i = segment.indexOf(";");
  return i < 0 ? segment : segment.slice(0, i);
}

/** The `;name`s a segment declares, in declaration order. */
export function segmentKeyedParamNames(segment: string): string[] {
  const i = segment.indexOf(";");
  return i < 0 ? [] : segment.slice(i + 1).split(";");
}

/**
 * One URL part split into what the positional matcher compares (`base`) and its
 * keyed suffix (`keyed`, the text after the first raw `;`, or `null`).
 */
export function splitKeyedPart(part: string): {
  base: string;
  keyed: string | null;
} {
  const i = part.indexOf(";");
  return i < 0
    ? { base: part, keyed: null }
    : { base: part.slice(0, i), keyed: part.slice(i + 1) };
}

/**
 * Read a part's keyed suffix (`lens=notation;view.sonata.library=all`) against
 * the names a segment declares. Surface view keys (`view.<surface>`, see
 * {@link isSurfaceViewKey}) are kept whatever the segment declares — every pane
 * carries them. Any other name the segment does not declare is dropped, as is a
 * pair with no `=`: the address bar is untrusted input, and an unknown key — a
 * stale bookmark, a removed option, the retired bare `;view=` — must not make
 * the URL unroutable. The pane falls back to its default, exactly as for an
 * absent key.
 */
export function readKeyedParams(
  keyed: string,
  names: readonly string[],
): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of keyed.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = decodeURIComponent(pair.slice(0, eq));
    if (!names.includes(name) && !isSurfaceViewKey(name)) continue;
    params[name] = decodeURIComponent(pair.slice(eq + 1));
  }
  return params;
}

const KEYED_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Surface view keys — `;view.<surface>=<view>`: the keyed params EVERY pane
// carries without declaring them, one per surface in the pane that shows one
// of several views (a DataView's active view instance, bound automatically by
// `usePaneViewParam(surface)`). The key is derived from the surface's own id,
// so two surfaces in one pane can never collide on it, and a plugin
// contributing one section of a pane it does not own needs to declare nothing.
//
// The `view.` prefix makes the family disjoint from declared keyed params
// (identifiers — no `.`), and no route may declare `view` itself (a keyed
// `;view` or a positional `:view` — `assertKeyedParams` throws), so the name
// means one thing in every URL.
//
// They are never part of a pane's TYPED params (`useParams`, `useResolve`,
// `openPane`): they view whatever the pane addresses, and only the binding
// writes them. Written after the declared keyed params, sorted — one spelling.
// ---------------------------------------------------------------------------

/** The prefix of every surface view key. */
export const SURFACE_VIEW_PREFIX = "view.";

const SURFACE_NAME = /^[A-Za-z0-9._-]+$/;

/** The URL key holding `surface`'s view: `view.<surface>`. Throws on a malformed surface. */
export function surfaceViewKey(surface: string): string {
  if (!SURFACE_NAME.test(surface)) {
    throw new Error(
      `surfaceViewKey("${surface}"): a surface id is [A-Za-z0-9._-]+, so its key ` +
        `needs no escaping in the URL.`,
    );
  }
  return SURFACE_VIEW_PREFIX + surface;
}

/** Is `name` a surface view key (`view.<surface>`)? */
export function isSurfaceViewKey(name: string): boolean {
  return (
    name.startsWith(SURFACE_VIEW_PREFIX) &&
    SURFACE_NAME.test(name.slice(SURFACE_VIEW_PREFIX.length))
  );
}

// A trailing run of `;view.<surface>=<value>` pairs — and the retired bare
// `;view=<value>`, so an old link still routes (its key is then dropped by
// `readKeyedParams`). Values are `encodeURIComponent`ed, so never hold a `;`.
const SURFACE_VIEW_SUFFIX =
  /^(.+?);((?:view(?:\.[A-Za-z0-9._-]+)?=[^;]*)(?:;view(?:\.[A-Za-z0-9._-]+)?=[^;]*)*)$/;

/**
 * {@link splitKeyedPart} for a segment declaring NO keyed params: it still
 * carries surface view keys, but reads any other raw `;` as text, as it always
 * did — only a trailing run of `;view.<surface>=…` pairs is the suffix there,
 * so a hand-typed `;` in a path keeps matching.
 */
export function splitSurfaceViewPart(part: string): {
  base: string;
  keyed: string | null;
} {
  const m = SURFACE_VIEW_SUFFIX.exec(part);
  return m ? { base: m[1]!, keyed: m[2]! } : { base: part, keyed: null };
}

/** The surface view keys `params` holds, sorted. */
function surfaceViewKeysOf(params: Record<string, string>): string[] {
  return Object.keys(params).filter(isSurfaceViewKey).sort();
}

/**
 * `params`' surface views, keyed by SURFACE (`{ "sonata.library": "all" }`) —
 * the same object shape whatever order the URL wrote them in.
 */
export function surfaceViewsOf(
  params: Record<string, string>,
): Record<string, string> {
  const views: Record<string, string> = {};
  for (const key of surfaceViewKeysOf(params)) {
    views[key.slice(SURFACE_VIEW_PREFIX.length)] = params[key]!;
  }
  return views;
}

/** `params` without its surface view keys (the same object when it has none). */
export function withoutSurfaceViews(
  params: Record<string, string>,
): Record<string, string> {
  if (!Object.keys(params).some(isSurfaceViewKey)) return params;
  return Object.fromEntries(
    Object.entries(params).filter(([name]) => !isSurfaceViewKey(name)),
  );
}

/** `params`' surface view keys alone (`{}` when it has none). */
export function onlySurfaceViews(
  params: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).filter(([name]) => isSurfaceViewKey(name)),
  );
}

// ---------------------------------------------------------------------------
// The embed tail — `<the page's URL>/at/<location>` and `;full=1`: where an
// app embedded in a pane (`apps-core/app-embed`) is, and whether its host
// maximized it, kept in the page's own URL so a reload, a link or a new tab
// comes back to it.
//
// It is two reserved surface views of the pane instance hosting the embed
// (`view.embed`, `view.embed.full`), so it rides every path a surface view
// rides (the store, history snapshots, persisted tabs, restores). Only its
// SPELLING differs: on the route's last instance — its last slot, or its
// landing pane when it has none — the location is written after everything
// else as `/at/<location parts>` (each part encoded, so a raw `;` in it is
// always ours), and maximized as `;full=1` on the URL's very last part,
// with or without a location (`/demo;full=1`, `/demo/at/pages;full=1`) —
// instead of as `;view.…` pairs. Anywhere else (a pane that is not the last,
// one whose segment ends open) the keys keep the plain `;view.…` spelling;
// both read back to the same route. No route may declare `full`
// (`assertKeyedParams`), so the flag means one thing in every URL.
// ---------------------------------------------------------------------------

/** The surface whose view is an embed's location (an app-rooted URL, `/agents/c/x`). */
export const EMBED_PLACE_SURFACE = "embed";
/** The surface whose view says the embed is maximized ({@link EMBED_MAXIMIZED}). */
export const EMBED_MAXIMIZED_SURFACE = "embed.full";
/** {@link EMBED_MAXIMIZED_SURFACE}'s one value. */
export const EMBED_MAXIMIZED = "1";

/** The URL part that starts an embed tail. */
const EMBED_TAIL_MARK = "at";
/** The keyed name of the maximized flag — reserved: no route may declare it. */
const RESERVED_FULL_NAME = "full";
/** The maximized flag, on the URL's last part. */
const EMBED_TAIL_FULL = `;${RESERVED_FULL_NAME}=${EMBED_MAXIMIZED}`;

const EMBED_PLACE_KEY = SURFACE_VIEW_PREFIX + EMBED_PLACE_SURFACE;
const EMBED_MAXIMIZED_KEY = SURFACE_VIEW_PREFIX + EMBED_MAXIMIZED_SURFACE;

/**
 * Split the embed place off the params of the route's LAST instance: the
 * params left to write as usual, the location's URL parts (`[]` for none),
 * and whether the URL ends in the maximized flag.
 */
export function splitEmbedTail(params: Record<string, string>): {
  params: Record<string, string>;
  tail: string[];
  maximized: boolean;
} {
  const location = params[EMBED_PLACE_KEY];
  const parts =
    location === undefined ? [] : wildcardParts(location.replace(/^\/+/, ""));
  const maximized = params[EMBED_MAXIMIZED_KEY] === EMBED_MAXIMIZED;
  if (parts.length === 0 && !maximized) return { params, tail: [], maximized };
  const rest = { ...params };
  // The root ("/") has no part to spell: it keeps its plain key.
  if (parts.length > 0) delete rest[EMBED_PLACE_KEY];
  if (maximized) delete rest[EMBED_MAXIMIZED_KEY];
  return {
    params: rest,
    tail: parts.length > 0 ? [EMBED_TAIL_MARK, ...parts] : [],
    maximized,
  };
}

/**
 * `url` (an app-relative URL from `joinUrlParts`) with the maximized flag on
 * its last part — the bare root's `/;full=1` joins its base path itself
 * (`/demo;full=1`), as a landing pane's keyed suffix does.
 */
export function withEmbedMaximized(url: string): string {
  return url + EMBED_TAIL_FULL;
}

/**
 * Read the maximized flag off a URL's last part: the parts without it, and
 * whether it was there (a part left empty by it is dropped).
 */
export function splitEmbedMaximized(parts: readonly string[]): {
  parts: string[];
  maximized: boolean;
} {
  const last = parts[parts.length - 1];
  if (last === undefined || !last.endsWith(EMBED_TAIL_FULL))
    return { parts: [...parts], maximized: false };
  const rest = last.slice(0, -EMBED_TAIL_FULL.length);
  return {
    parts: [...parts.slice(0, -1), ...(rest === "" ? [] : [rest])],
    maximized: true,
  };
}

/** The surface-view param the maximized flag reads back as. */
export const EMBED_MAXIMIZED_PARAMS: Readonly<Record<string, string>> = {
  [EMBED_MAXIMIZED_KEY]: EMBED_MAXIMIZED,
};

/**
 * Read an embed location back: `parts` (a URL's `/`-split parts, its
 * maximized flag already split off) at `at` — the index of an `at` part — as
 * the surface-view param it spells, or `null` when `at` does not start one
 * (no location after it).
 */
export function readEmbedTail(
  parts: readonly string[],
  at: number,
): Record<string, string> | null {
  if (parts[at] !== EMBED_TAIL_MARK || at + 1 >= parts.length) return null;
  const location =
    "/" +
    parts
      .slice(at + 1)
      .map((p) => decodeURIComponent(p))
      .join("/")
      .replace(/^\/+/, "");
  return { [EMBED_PLACE_KEY]: location };
}

/**
 * The embed tail an app-relative URL ends with for an embed at `location`
 * (`/at/agents/c/x`, `;full=1` when `maximized`) — appended to the URL of the
 * page hosting it. For a script that addresses an embed from outside (an
 * e2e); the app writes it through the route (`splitEmbedTail`).
 */
export function embedTailPath(
  location: string,
  opts?: { maximized?: boolean },
): string {
  const { tail } = splitEmbedTail({ [EMBED_PLACE_KEY]: location });
  if (tail.length === 0)
    throw new Error(`embedTailPath("${location}"): no tail spells the root.`);
  const path = "/" + tail.join("/");
  return opts?.maximized === true ? path + EMBED_TAIL_FULL : path;
}

/** The indexes of the parts that may start an embed tail, left to right. */
export function embedTailStarts(parts: readonly string[]): number[] {
  return parts.flatMap((p, i) => (p === EMBED_TAIL_MARK ? [i] : []));
}

/**
 * The keyed names a pane's OWN URL part carries for `params`: its declared
 * ones, then the surface view keys `params` holds, sorted.
 */
export function slotKeyedParamNames(
  segment: string,
  params: Record<string, string>,
): string[] {
  return [...segmentKeyedParamNames(segment), ...surfaceViewKeysOf(params)];
}

/** `name=value` pairs for the supplied `names`, in order, encoded. */
function keyedPairs(
  names: readonly string[],
  params: Record<string, string>,
): string[] {
  return names.flatMap((name) => {
    const val = params[name];
    return val === undefined
      ? []
      : [`${encodeURIComponent(name)}=${encodeURIComponent(val)}`];
  });
}

/**
 * The keyed suffix an app's LANDING (index) pane writes on the app's base path
 * — `;page=x;view.sonata.library=all` in `/places;page=x;view.sonata.library=all`
 * — or `""` when it carries none. An index pane has no URL part of its own (it
 * is what the bare root shows), so its keyed params ride the base path.
 *
 * Written in one spelling: the index segment's `declared` names first, in
 * declaration order; then any other identifier key `params` holds, sorted (a
 * key read off the URL before the index pane registered, or one it no longer
 * declares — kept rather than silently dropped, and ignored by the pane); then
 * the surface view keys, sorted.
 */
export function indexKeyedSuffix(
  params: Record<string, string>,
  declared: readonly string[] = [],
): string {
  const others = Object.keys(params)
    .filter((name) => !declared.includes(name) && !isSurfaceViewKey(name))
    .sort();
  const pairs = keyedPairs(
    [...declared, ...others, ...surfaceViewKeysOf(params)],
    params,
  );
  return pairs.length > 0 ? ";" + pairs.join(";") : "";
}

/**
 * Read {@link indexKeyedSuffix}'s text back (without its leading `;`): every
 * well-formed identifier key and every surface view key. The parse knows no
 * base path, so it cannot know which index pane's names to keep — the index
 * match filters them against the pane's declared names (an undeclared key is
 * ignored there, as on any pane). A malformed name, a pair with no `=` and the
 * retired bare `;view=` are dropped.
 */
export function readIndexKeyedParams(keyed: string): Record<string, string> {
  const names = keyed.split(";").flatMap((pair) => {
    const eq = pair.indexOf("=");
    if (eq < 0) return [];
    const name = decodeURIComponent(pair.slice(0, eq));
    return KEYED_NAME.test(name) && name !== RESERVED_VIEW_NAME ? [name] : [];
  });
  return readKeyedParams(keyed, names);
}

/** The name the surface view family is spelled under — no route may declare it. */
const RESERVED_VIEW_NAME = "view";

/**
 * Throws on a malformed keyed suffix: a name that is not an identifier, the
 * reserved `view`, or one declared twice or also used positionally. Called by
 * `defineRoute`.
 *
 * A segment with keyed params and NO positional part (`";page"`) is legal: it
 * is an app's index pane, whose keyed params ride the app's base path
 * (`/places;page=x`) — `Pane.define` throws for one that is not `appIndex`.
 */
function assertKeyedParams(id: string, segment: string): void {
  for (const part of parseSegmentParts(segment)) {
    if (part.kind !== "static" && part.name === RESERVED_VIEW_NAME) {
      throw new Error(
        `Route "${id}": param ":${part.name}" in segment "${segment}" is reserved — every pane ` +
          `already carries ";${SURFACE_VIEW_PREFIX}<surface>" keys (see surfaceViewKey). Rename it.`,
      );
    }
  }
  const names = segmentKeyedParamNames(segment);
  if (names.length === 0) return;
  const positional = new Set(
    parseSegmentParts(segment).flatMap((p) =>
      p.kind === "static" ? [] : [p.name],
    ),
  );
  const seen = new Set<string>();
  for (const name of names) {
    if (!KEYED_NAME.test(name)) {
      throw new Error(
        `Route "${id}": keyed param ";${name}" in segment "${segment}" is not an identifier.`,
      );
    }
    if (name === RESERVED_FULL_NAME) {
      throw new Error(
        `Route "${id}": keyed param ";${name}" in segment "${segment}" is reserved — it is ` +
          `an embedded app's maximized flag (the embed tail, see splitEmbedTail).`,
      );
    }
    if (name === RESERVED_VIEW_NAME) {
      throw new Error(
        `Route "${id}": keyed param ";${name}" in segment "${segment}" is reserved — every ` +
          `pane already carries ";${SURFACE_VIEW_PREFIX}<surface>" keys (the views on screen, ` +
          `see surfaceViewKey). Name yours after what it views instead.`,
      );
    }
    if (seen.has(name) || positional.has(name)) {
      throw new Error(
        `Route "${id}": param "${name}" is declared twice in segment "${segment}".`,
      );
    }
    seen.add(name);
  }
}

/**
 * Throws unless an optional `:name?` is the segment's LAST part (and there is
 * at most one). Anywhere else it would make the parts after it ambiguous — is
 * `proto/x/y` the optional `x` then `y`, or `x` skipped? — so it has no
 * spelling there. Called by `defineRoute`, the one place a segment is authored.
 */
function assertOptionalIsLast(id: string, segment: string): void {
  const parts = parseSegmentParts(segment);
  parts.forEach((part, i) => {
    if (part.kind === "optional" && i !== parts.length - 1) {
      throw new Error(
        `Route "${id}": optional param ":${part.name}?" in segment "${segment}" must be the ` +
          `segment's last part — anywhere else the parts after it would be ambiguous.`,
      );
    }
  });
}

/**
 * A segment named a `:param` nobody supplied, so this route has no URL.
 *
 * A TYPE rather than a message to match on, because exactly one caller has a
 * legitimate reason to treat it as an answer instead of a crash: a pane's
 * cross-app Expand asks for its own app-rooted URL from wherever it is being
 * rendered, and a pane whose ancestor is paramful can sit in a route that does
 * not contain that ancestor — nothing supplies the ancestor's param, so there
 * genuinely is no URL to offer. That caller narrows on this class and lets
 * every other failure propagate; a substring match on the message could not.
 */
export class MissingRouteParamError extends Error {
  constructor(
    readonly param: string,
    readonly segment: string,
  ) {
    super(`Missing param "${param}" for segment "${segment}"`);
    this.name = "MissingRouteParamError";
  }
}

/**
 * Is `segment` keyed-only — keyed params (`";page"`) and no positional part?
 * Only an app's index pane has one (`Pane.define` enforces it): it owns no URL
 * part, so its keyed params ride the base path.
 */
export function isKeyedOnlySegment(segment: string): boolean {
  return (
    parseSegmentParts(segment).length === 0 &&
    segmentKeyedParamNames(segment).length > 0
  );
}

/**
 * `segment`'s URL parts for `params`. `ownSlot` also writes the surface view
 * keys — only a slot's own segment carries them, never an ancestor's
 * (`RouteDef.path` fills every segment of the chain from ONE flat param set,
 * which would otherwise stamp the same views on each of them).
 *
 * A segment with no positional part of its own (an index pane's `";page"`)
 * returns its keyed pairs as ONE part starting with `;` — a suffix of whatever
 * comes before it (the base path, for an index pane), joined on by
 * {@link joinUrlParts}. Nothing to write ⇒ no part at all.
 */
export function fillSegment(
  segment: string,
  params: Record<string, string>,
  opts?: { ownSlot?: boolean },
): string[] {
  if (!segment || segment === "/") return [];

  const parts: string[] = [];
  for (const part of parseSegmentParts(segment)) {
    if (part.kind === "static") {
      parts.push(part.text);
      continue;
    }
    const val = params[part.name];
    if (val === undefined) {
      if (part.kind === "optional") continue;
      throw new MissingRouteParamError(part.name, segment);
    }
    if (part.kind === "wildcard") {
      parts.push(...wildcardParts(val));
    } else {
      parts.push(encodeURIComponent(val));
    }
  }
  // Keyed params ride the last part written, in declaration order so a route
  // has ONE spelling — the surface view keys last, sorted. A segment with no
  // part of its own writes them as a `;…` suffix part (see above).
  const keyed = keyedPairs(
    opts?.ownSlot === true
      ? slotKeyedParamNames(segment, params)
      : segmentKeyedParamNames(segment),
    params,
  );
  if (keyed.length === 0) return parts;
  if (parts.length === 0) return [";" + keyed.join(";")];
  parts[parts.length - 1] += ";" + keyed.join(";");
  return parts;
}

/**
 * The app-relative URL (`/a/b`, or `"/"`) of {@link fillSegment}'s parts. A
 * part starting with `;` is a keyed suffix of the part before it; first, it is
 * the leading `/;…` part a base path joins onto itself (see
 * {@link joinBasePath}).
 */
export function joinUrlParts(parts: readonly string[]): string {
  const joined: string[] = [];
  for (const part of parts) {
    if (part.startsWith(";") && joined.length > 0) {
      joined[joined.length - 1] += part;
    } else {
      joined.push(part);
    }
  }
  return joined.length > 0 ? "/" + joined.join("/") : "/";
}

/**
 * `appUrl` (app-relative, from {@link joinUrlParts}) under `basePath`. The
 * index pane's `;…` suffix joins the base path itself (`/places;page=x`),
 * never a part of its own (`/places/;page=x`); the root app (`"/"` or `""`)
 * contributes nothing. An empty URL stays `basePath + "/"` — the bare root's
 * historical spelling for a link.
 */
export function joinBasePath(basePath: string, appUrl: string): string {
  const base = basePath === "/" ? "" : basePath;
  if (base && appUrl.startsWith("/;")) return base + appUrl.slice(1);
  return base + appUrl;
}

/** The names a segment declares — required, optional, wildcard and keyed alike. */
export function segmentParamNames(segment: string): string[] {
  return [
    ...parseSegmentParts(segment).flatMap((part) =>
      part.kind === "static" ? [] : [part.name],
    ),
    ...segmentKeyedParamNames(segment),
  ];
}

/** The `:name`s a segment cannot be filled without (every name but `:name?`). */
export function segmentRequiredParamNames(segment: string): string[] {
  return parseSegmentParts(segment).flatMap((part) =>
    part.kind === "param" || part.kind === "wildcard" ? [part.name] : [],
  );
}

// ---------------------------------------------------------------------------
// Route-path canonicalization — the address bar is UNTRUSTED INPUT.
//
// `window.location.pathname` is whatever the user typed, pasted, or a bad link
// carried. A pathname with repeated slashes (`//agents/c/x`) is not merely ugly:
//
//   • As a HISTORY URL it is a *scheme-relative* reference. `replaceState(s, "",
//     "//agents/c/x")` resolves against the document to `http://agents/c/x` — a
//     different origin — and the browser throws SecurityError, taking down boot.
//   • As a MATCH KEY it silently misses. `"//agents/c/x".startsWith("/agents/")`
//     is false, so the URL owns no app: the deep link resolves to nothing and
//     falls back to the default app.
//
// Both failures come from reading the raw pathname, so the fix is one canonical
// reader every routing consumer goes through — collapse repeated `/` runs and
// guarantee exactly one leading `/`. The `pane/no-raw-location-path` lint rule
// keeps it the only reader. Idempotent, so re-normalizing is always safe.
// ---------------------------------------------------------------------------

export function normalizeRoutePath(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, "/");
  return collapsed.startsWith("/") ? collapsed : "/" + collapsed;
}

// ---------------------------------------------------------------------------
// Segment collisions — two segments collide when some URL is matched whole by
// both. Param *names* don't disambiguate (`s/:pageId` and `s/:serverId` both
// match `s/<x>`); a static part does (`page/:pageId` vs `s/:serverId`). A
// wildcard `:name*` matches ANY run of one or more parts, so `at/:url*`
// collides with `at/:dir` — and with `at/:a/:b`, `at/x/y/z`, … — though they
// are different shapes: the matcher takes the longer match, so the wildcard
// silently swallows the other pane's URLs (and, across apps, carries the tab
// off to the wildcard's app). A segment ending in an optional `:name?` matches
// TWO shapes of URL — with that part and without — so it collides with
// anything matching either. A segment with no positional part matches no URL.
// THE single definition: the runtime registry (`useSyncPaneRegistry`) enforces
// the no-collision invariant at registration, and the `pane:segments-unique`
// check enforces the same invariant statically at build time — both call
// this, so they can't drift.
// ---------------------------------------------------------------------------

type ShapePart =
  { kind: "static"; text: string } | { kind: "param" | "wildcard" };

/** The fixed-length shapes of URL a segment matches (two for a `:name?`). */
function segmentShapes(segment: string): ShapePart[][] {
  const parts = parseSegmentParts(segment);
  // No positional part (`""`, `"/"`, an index pane's keyed-only `";page"`):
  // the segment owns no URL part, so it matches no URL —
  // index panes are resolved by `appIndex`, never by URL matching.
  if (parts.length === 0) return [];
  const shape = (ps: SegmentPart[]): ShapePart[] =>
    ps.map((part): ShapePart =>
      part.kind === "static"
        ? part
        : { kind: part.kind === "wildcard" ? "wildcard" : "param" },
    );
  if (parts.at(-1)?.kind !== "optional") return [shape(parts)];
  return [shape(parts.slice(0, -1)), shape(parts)];
}

/** A URL (static parts kept, a param written `:`, a wildcard's run `:…`) both shapes match whole, or `null`. */
function shapesOverlap(a: ShapePart[], b: ShapePart[]): string | null {
  const url: string[] = [];
  for (let i = 0; ; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) {
      return x === undefined && y === undefined ? url.join("/") : null;
    }
    // A wildcard is the shape's last part and takes every remaining part
    // (at least one): the other shape still having a part here is enough.
    if (x.kind === "wildcard" || y.kind === "wildcard") {
      const rest = x.kind === "wildcard" ? b.slice(i) : a.slice(i);
      return [...url, ...rest.map(spellPart)].join("/");
    }
    if (x.kind === "static" && y.kind === "static" && x.text !== y.text) {
      return null;
    }
    url.push(spellPart(x.kind === "static" ? x : y));
  }
}

function spellPart(part: ShapePart): string {
  if (part.kind === "static") return part.text;
  return part.kind === "wildcard" ? ":…" : ":";
}

/**
 * Whether two pane segments match some URL in common — and if so one such URL
 * (`at/:` for `at/:dir` vs `at/:url*`), for the error to name; `null` when no
 * URL is matched by both.
 */
export function segmentCollision(a: string, b: string): string | null {
  for (const sa of segmentShapes(a)) {
    for (const sb of segmentShapes(b)) {
      const url = shapesOverlap(sa, sb);
      if (url !== null) return url;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// RouteDef — a typed, pure route identity. Chains to a parent route; `path`
// builds the app-relative URL, `link` prepends an app's base path.
// ---------------------------------------------------------------------------

/**
 * A route carries TWO param sets, and confusing them is a live class of bug.
 *
 * - The CHAINED set — every ancestor's `:name` plus this route's own. That is
 *   what a URL needs, so it is what `path` / `link` take and what an opener
 *   must supply. It is the `Params` parameter.
 * - The OWN set — only the `:name`s in THIS route's `segment`. That is what the
 *   runtime hands a pane back: `MatchEntry.params` is own-only (the accumulated
 *   set lives beside it in `fullParams`), so a pane's `useParams()` and its
 *   `useResolve` hook see own params and nothing else.
 *
 * The own set is NOT a second type parameter of its own: it is a function of
 * the `segment` this route already carries, which is why `segment` is typed by
 * its literal. `Pane.define` reads `RouteParams<Seg>` off it. (A separate
 * phantom `Own` parameter would appear in no member — `noUnusedParameters`
 * rejects that, and rightly: it would be inferred positionally rather than from
 * anything the value itself says, so annotating a route by hand could silently
 * drop it.) Before this, a chained pane's `useParams()` claimed its ancestor's
 * params too and returned `undefined` for them.
 */
export interface RouteDef<
  Params extends Record<string, string> = {},
  Seg extends string = string,
> {
  readonly id: string;
  /**
   * This route's own URL fragment, e.g. `"source/:sourceId"`. Typed by its
   * LITERAL so a consumer can derive the own param set from it (above).
   */
  readonly segment: Seg;
  readonly parent?: RouteDef<any, any>;
  /** Root-first ancestor pane ids (parent chain). Empty for a root route. */
  readonly parentPaneIds: string[];
  /** App-relative path, e.g. "/build/r/<id>". Takes the CHAINED params. */
  path(params: Params): string;
  /** Full app-rooted link, e.g. "/agents/build/r/<id>". Root app (basePath "/") contributes "". */
  link(app: AppRef, params: Params): string;
}

/**
 * `Seg` is a `const` type parameter, and that is load-bearing rather than a
 * nicety. Written INLINE — `Pane.define({ route: defineRoute({ … }) })` — the
 * outer call's contextual type is an unresolved `Seg` type parameter, which
 * widens the inner `segment` literal all the way back to `string`.
 * `RouteParams<string>` is then `{}`, so the pane silently resolves PARAMLESS:
 * `useParams()` returns nothing and `useResolve` types as FORBIDDEN on a route
 * that plainly has a `:param`. `const` preserves the literal through the
 * contextual type, so the inline form means what it reads as, and "paramful
 * pane written inline with no `useResolve`" becomes a compile error instead of a
 * silently paramless pane.
 *
 * Nothing already written changes shape: every call site passes a literal to a
 * `const` binding, where the literal was already inferred.
 */
export function defineRoute<
  const Seg extends string,
  ParentParams extends Record<string, string> = {},
>(def: {
  id: string;
  segment: Seg;
  parent?: RouteDef<ParentParams, any>;
}): RouteDef<ParentParams & RouteParams<Seg>, Seg> {
  type Params = ParentParams & RouteParams<Seg>;

  assertOptionalIsLast(def.id, def.segment);
  assertKeyedParams(def.id, def.segment);
  if (def.parent && isKeyedOnlySegment(def.parent.segment)) {
    // A keyed-only segment is an app's index pane, its params riding the base
    // path. A child route would make it an ancestor slot in the middle of a
    // URL, where its keyed params have no part to ride and an open from
    // scratch drops them — not well-defined, so not allowed until an app
    // needs it.
    throw new Error(
      `Route "${def.id}": its parent "${def.parent.id}" (segment "${def.parent.segment}") ` +
        `declares keyed params on no URL part of its own — an app index pane, whose ` +
        `params ride the base path. Such a route cannot have child routes: the keyed ` +
        `params would have nowhere to be written. Drop the keyed params or the parent.`,
    );
  }

  // Root-first chain of RouteDefs, this route last.
  const chain: RouteDef<any, any>[] = [];
  for (let r: RouteDef<any, any> | undefined = def.parent; r; r = r.parent) {
    chain.unshift(r);
  }
  const parentPaneIds = chain.map((r) => r.id);

  function path(params: Record<string, string>): string {
    const parts: string[] = [];
    for (const r of [...chain, route]) {
      parts.push(...fillSegment(r.segment, params));
    }
    return joinUrlParts(parts);
  }

  function link(app: AppRef, params: Record<string, string>): string {
    return joinBasePath(app.basePath, path(params));
  }

  const route: RouteDef<Params, Seg> = {
    id: def.id,
    segment: def.segment,
    parent: def.parent,
    parentPaneIds,
    path: path as RouteDef<Params, Seg>["path"],
    link: link as RouteDef<Params, Seg>["link"],
  };
  return route;
}
