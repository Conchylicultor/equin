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
  icon: SymbolRef;
  iconColor?: AvatarColor;
  colorMode?: AppColorMode;
  listed?: false;
  audience?: "developer";
}): AppRef {
  return Object.freeze({
    id: def.id,
    name: def.name,
    basePath: def.basePath,
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
 * — `;view.sonata.library=all` in `/sonata;view.sonata.library=all` — or `""`
 * when it carries none. An index pane has no URL part of its own (it is what
 * the bare root shows), so its keyed params ride the base path; it declares
 * none, so only surface view keys are ever written there.
 */
export function indexKeyedSuffix(params: Record<string, string>): string {
  const pairs = keyedPairs(surfaceViewKeysOf(params), params);
  return pairs.length > 0 ? ";" + pairs.join(";") : "";
}

/** Read {@link indexKeyedSuffix}'s text back (without its leading `;`). */
export function readIndexKeyedParams(keyed: string): Record<string, string> {
  return readKeyedParams(keyed, []);
}

/** The name the surface view family is spelled under — no route may declare it. */
const RESERVED_VIEW_NAME = "view";

/**
 * Throws on a malformed keyed suffix: a name that is not an identifier, one
 * declared twice or also used positionally, or keyed params on a segment with
 * no URL part of its own to carry them. Called by `defineRoute`.
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
  if (parseSegmentParts(segment).length === 0) {
    throw new Error(
      `Route "${id}": keyed params in segment "${segment}" need a URL part of the ` +
        `segment's own to be written on.`,
    );
  }
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
 * `segment`'s URL parts for `params`. `ownSlot` also writes the surface view
 * keys — only a slot's own segment carries them, never an ancestor's
 * (`RouteDef.path` fills every segment of the chain from ONE flat param set,
 * which would otherwise stamp the same views on each of them).
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
      parts.push(...val.split("/").map(encodeURIComponent));
    } else {
      parts.push(encodeURIComponent(val));
    }
  }
  // Keyed params ride the last part written (`assertKeyedParams` guarantees the
  // segment has one for its declared names), in declaration order so a route
  // has ONE spelling — the surface view keys last, sorted. A segment with no
  // part of its own cannot carry them, so they are dropped there.
  const keyed = keyedPairs(
    opts?.ownSlot === true
      ? slotKeyedParamNames(segment, params)
      : segmentKeyedParamNames(segment),
    params,
  );
  if (keyed.length > 0 && parts.length > 0) {
    parts[parts.length - 1] += ";" + keyed.join(";");
  }
  return parts;
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
// Segment match-pattern normalization — param *names* are erased, only their
// structural shape survives. `s/:pageId` and `s/:serverId` both normalize to
// `s/:`, so two panes that match the same URLs collide; `page/:pageId`
// (`page/:`) does not collide with `s/:`. A segment ending in an optional
// `:name?` matches TWO shapes of URL — with that part and without — so it has
// two patterns, and collides with anything claiming either (`proto/:name/:stage?`
// is both `proto/:` and `proto/:/:`). THE single definition: the runtime
// registry (`useSyncPaneRegistry`) enforces the globally-unique-segment
// invariant at registration, and the `pane:segments-unique` check enforces the
// same invariant statically at build time — both call this, so they can't drift.
// ---------------------------------------------------------------------------

export function segmentMatchPatterns(segment: string): string[] {
  const parts = parseSegmentParts(segment);
  const shape = (ps: SegmentPart[]) =>
    ps
      .map((part) => {
        if (part.kind === "static") return part.text;
        return part.kind === "wildcard" ? ":*" : ":";
      })
      .join("/");
  if (parts.at(-1)?.kind !== "optional") return [shape(parts)];
  return [shape(parts.slice(0, -1)), shape(parts)];
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
    return parts.length > 0 ? "/" + parts.join("/") : "/";
  }

  function link(app: AppRef, params: Record<string, string>): string {
    const base = app.basePath === "/" ? "" : app.basePath;
    return base + path(params);
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
