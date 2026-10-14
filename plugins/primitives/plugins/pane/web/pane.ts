import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";
import { getDeferredLoadState } from "@plugins/framework/plugins/web-sdk/core";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import { SurfaceIdContext } from "@plugins/primitives/plugins/scope/plugins/surface-id/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { defineInstallSink } from "@plugins/primitives/plugins/scope/plugins/install-sink/web";
import {
  fillSegment,
  MissingRouteParamError,
  normalizeRoutePath,
  parseSegmentParts,
  readKeyedParams,
  segmentKeyedParamNames,
  segmentMatchPatterns,
  segmentParamNames,
  segmentRequiredParamNames,
  splitKeyedPart,
  type AppRef,
  type PositionalRouteParams,
  type RouteDef,
  type RouteParams,
} from "../core";
import { Pane as PaneSlots } from "./slots";
import { useRenderSync } from "./use-render-sync";
import {
  historySink,
  liveStoreAccessorSink,
  type SerializedSlot,
} from "./history-sink";
import { appNavSink, navigateApp } from "./app-nav-sink";
import {
  linkProps,
  type LinkGestureProps,
} from "@plugins/primitives/plugins/link-gesture/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { definePaneHeaderSlot, type PaneHeaderSlot } from "./header-slot";
import type { ResolveResult } from "./resolve";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";

export type { PaneHeaderItem } from "./components/pane-header-item";

// ---------------------------------------------------------------------------
// Resolve hook — mandatory for parameterized panes, opt-out with `false`.
// The answer's vocabulary (`ResolveResult`) and its builders live in
// `./resolve`.
// ---------------------------------------------------------------------------

export type ResolveHook<Params extends Record<string, string>> = Hook<
  (params: Params) => ResolveResult
>;

let nextInstanceId = 0;

/**
 * Caller-provided, non-URL pane OPTIONS. Unlike `params` (which serialize into
 * the URL and so must be strings), options live in `history.state` and are
 * persisted via the structured-clone algorithm — booleans, numbers, and nested
 * objects round-trip faithfully. The storage type is therefore an arbitrary
 * structured-cloneable bag, NOT `Record<string, string>`.
 *
 * A slot stores only the PARTIAL the opener supplied; `useOptions()` merges it
 * under the pane's declared `options: {…}` defaults. So the deep-link value of
 * every option is stated once, at the pane definition, and changing a default
 * later applies to routes already sitting in `history.state`.
 */
export type PaneOptions = Record<string, unknown>;

/**
 * The erased runtime storage for a pane's optimistic {@link Hint}. In-memory
 * ONLY — deliberately absent from every serialized form (see `setRoute`).
 */
type PaneHintBag = Record<string, unknown>;

export interface PaneSlot {
  instanceId: number;
  uuid: string;
  paneId: string;
  params: Record<string, string>;
  /** The opener-supplied PARTIAL. Merged under the pane's defaults on read. */
  options: PaneOptions;
  /** Ephemeral. Never serialized; `{}` on every rebuilt route. */
  hint: PaneHintBag;
}

function createSlot(
  paneId: string,
  params: Record<string, string>,
  options: PaneOptions = {},
  hint: PaneHintBag = {},
  uuid?: string,
): PaneSlot {
  return {
    instanceId: nextInstanceId++,
    uuid: uuid ?? crypto.randomUUID(),
    paneId,
    params,
    options,
    hint,
  };
}

// ---------------------------------------------------------------------------
// `Hint<T>` — an optimistic mirror of server-owned state, supplied by whoever
// opened the pane so the surface can pre-paint before the canonical resource
// settles.
// ---------------------------------------------------------------------------

/**
 * A hint is NOT pane data. It is absent on any route the browser rebuilt (deep
 * link, reload, back/forward), and possibly stale when present. It must never
 * become a source of truth.
 *
 * Two properties make that structural rather than aspirational:
 *
 *  1. `Hint` carries **no enumerable data** — it is a closure. `pick` is the
 *     only accessor, and it REQUIRES the canonical value as an argument. You
 *     cannot obtain a hinted value "bare": you must already hold the truth to
 *     see the hint at all — and if you hold the truth, you have no reason to
 *     write the hint.
 *  2. The hint is ephemeral (never serialized), so it cannot outlive the
 *     navigation that created it.
 *
 * The residual `?? "<fabricated default>"` on `pick`'s `T[K] | undefined` result
 * is banned by the `pane/no-hint-fabrication` lint rule: a hint's fallback must
 * be `null`, `undefined`, or a ReactNode — never a value that could be written
 * back. See `research/2026-07-10-global-pane-input-hint-vs-options.md`.
 */
export interface Hint<T extends object> {
  /**
   * Read one hinted field. `canonical` is the authoritative value, or
   * `undefined` while it is still loading. Returns `canonical` when it is
   * defined (a canonical `null` wins — that is a real value), otherwise the
   * opener's optimistic hint, itself `undefined` on a rebuilt route.
   */
  pick<K extends keyof T>(
    key: K,
    canonical: T[K] | undefined,
  ): T[K] | undefined;
}

function makeHint(bag: PaneHintBag): Hint<Record<string, unknown>> {
  return {
    pick: (key, canonical) =>
      canonical !== undefined ? canonical : bag[key as string],
  };
}

const EMPTY_HINT: Hint<Record<string, unknown>> = makeHint({});

/**
 * The generic default for a pane that declares no `options` / no `hint`. Not
 * `{}` — TypeScript treats `{}` as "any non-nullish value", so an object literal
 * would sail through the excess-property check and a caller could pass options
 * to a pane that declares none (which is how a dead `input: { convId }` survived
 * on `attemptPane` for months). `Record<string, never>` rejects every key.
 */
type NoOptions = Record<string, never>;
type NoHint = Record<string, never>;

// ---------------------------------------------------------------------------
// `type<T>()` — a phantom marker used to declare the `hint` shape at the
// type level. The runtime value is irrelevant; only the generic parameter
// matters.
// ---------------------------------------------------------------------------

export interface TypeMarker<T> {
  readonly __marker: (value: T) => void;
}

export function type<T>(): TypeMarker<T> {
  return { __marker: (_: T) => {} };
}

// ---------------------------------------------------------------------------
// Internal registry. Populated at module-load time by `Pane.define` calls.
// ---------------------------------------------------------------------------

/**
 * A pane title's text source: a React hook resolving the title string from the
 * pane's CHAINED params, its optimistic `hint` and its `options`.
 *
 * It runs OUTSIDE the owning app's providers — at the tab surface, for
 * background tabs too — so it may read only its arguments and GLOBAL hooks
 * (live-state resources), never app-local context. `hint` and `options` arrive
 * as VALUES, not hooks: this runs above the pane match context, so
 * `useHint()`/`useOptions()` are unavailable here. Return `undefined` while the
 * data is not known yet; the title then falls back to `fallback`.
 */
export type PaneTitleHook<
  Params,
  HintT extends object = NoHint,
  Options extends object = NoOptions,
> = Hook<
  (params: Params, hint: Hint<HintT>, options: Options) => string | undefined
>;

/**
 * Everything a pane's title is, declared once on `Pane.define({ title })`. The
 * one source for the tab label, the browser document title and the pane
 * header's title item — `PaneChrome` takes no title of its own.
 *
 * - `useText` — the title string: a literal, or a {@link PaneTitleHook}.
 * - `fallback` — shown while `useText` yields `undefined` (a loading entity): a
 *   literal, or derived from the chained URL params. Must not fabricate the
 *   entity's name — it is the generic noun ("Task", "Page").
 * - `component` — a RICH header title (a breadcrumb, an editable field). It is
 *   mounted INSIDE the pane, in the header's title cell, so it may read
 *   `pane.useParams()` and app context and be interactive. It replaces the text
 *   in the header only; tab and document titles still use `useText`/`fallback`.
 *   It must not render a slot: the header row is ONE slot (`pane.Actions`), and
 *   a render slot mounted inside the title throws.
 */
export interface PaneTitleSpec<
  Params,
  HintT extends object = NoHint,
  Options extends object = NoOptions,
> {
  useText?: string | PaneTitleHook<Params, HintT, Options>;
  fallback?: string | ((params: Params) => string);
  component?: ComponentType;
}

/** `Pane.define({ title })`: a literal is shorthand for `{ useText: literal }`. */
export type PaneTitle<
  Params,
  HintT extends object = NoHint,
  Options extends object = NoOptions,
> = string | PaneTitleSpec<Params, HintT, Options>;

/** The title as stored on {@link PaneInternal}: every field erased and normalized. */
export interface NormalizedPaneTitle {
  /** Always present (a no-op for a pane with no `useText`), so it can be called unconditionally. */
  useText: PaneTitleHook<
    Record<string, string>,
    Record<string, unknown>,
    PaneOptions
  >;
  fallback?: string | ((params: Record<string, string>) => string);
  component?: ComponentType;
}

const NO_TITLE_TEXT = (): string | undefined => undefined;

function normalizeTitle(
  title:
    PaneTitle<Record<string, string>, PaneHintBag, PaneOptions> | undefined,
): NormalizedPaneTitle {
  const spec: PaneTitleSpec<
    Record<string, string>,
    PaneHintBag,
    PaneOptions
  > = typeof title === "string" ? { useText: title } : (title ?? {});
  const { useText } = spec;
  return {
    useText:
      useText === undefined
        ? NO_TITLE_TEXT
        : typeof useText === "string"
          ? () => useText
          : (useText as NormalizedPaneTitle["useText"]),
    fallback: spec.fallback,
    component: spec.component,
  };
}

export interface PaneChromeConfig {
  history?: boolean;
  /**
   * Show a close button (leftmost) that calls `pane.close()`. Defaults to
   * `true` for panes with a parent. Set to `false` to hide it (e.g. for
   * top-level panes where "close" has no meaningful destination, or panes
   * that render their own bespoke header).
   */
  close?: boolean;
  /**
   * Show a promote button that detaches this pane from its ancestors and
   * makes it the root of a fresh route. Defaults to `true`; only shown
   * when `depth > 0`. Set to `false` for panes that should never be
   * promoted (e.g. compact side-panels with their own expand action).
   */
  promote?: boolean;
  /**
   * When true, the layout renderer (Miller columns) keeps the pane's
   * component subtree mounted when the column is collapsed, hiding it via
   * `display: none` instead of unmounting. Use for panes with live
   * connections (e.g. terminal) to avoid a reconnect cycle on re-expand.
   */
  keepMountedWhenCollapsed?: boolean;
}

interface NormalizedChrome {
  history: boolean;
  close: boolean;
  promote: boolean;
  keepMountedWhenCollapsed: boolean;
}

export interface PaneInternal {
  id: string;
  /**
   * Ancestor pane ids, root-first. It IS the route's `parentPaneIds` — the whole
   * transitive chain rather than one declared level — and wears that name for
   * two reasons: the old `defaultAncestors` re-wrapped each id in a `{ id }`
   * object that bought nothing, and it read as a field an author writes, which
   * it has not been since identity moved onto the `RouteDef`.
   *
   * It is read on BOTH open paths, under two different rules, and the second is
   * new — say so rather than let the field quietly widen:
   *
   *  - FROM SCRATCH (no caller to be relative to) it is the ancestry, whole: the
   *    route becomes the chain plus this pane. That is what it has always meant.
   *  - RELATIVE (push / swap) the caller's own prefix stands where the ancestry
   *    would, so it is consulted only to insert the ancestors that CARRY
   *    something the caller supplied and that the prefix does not already hold.
   *
   * Neither rule constrains where the pane may appear: any pane can sit at any
   * position in a route. See {@link chainSlots} for both rules in one place.
   */
  parentPaneIds: string[];
  /** Own URL segment (no leading slash). Used by the route URL parser/builder. */
  segment: string;
  /**
   * Marks this pane as the index/landing pane of {@link app} — the pane the
   * app's bare root resolves to. A boolean, not a path: the path is
   * `app.basePath`, which this pane already carries, so an index pane cannot
   * name the wrong app.
   *
   * At a bare app root the route is empty; `useIndexMatch` resolves the index
   * pane whose app's basePath matches the surface's, and the main-area renderer
   * paints it. There is no global fallback — an app with no index pane shows an
   * empty main area at its bare root.
   *
   * Two invariants, both thrown on at registry sync (`useSyncPaneRegistry`):
   * an index pane has NO URL segment of its own (it is reached at the bare
   * root), and an app has at most one.
   */
  appIndex: boolean;
  /**
   * The app this pane BELONGS to — its home, not wherever it happens to be
   * rendered. A pane is reusable chrome: the agent manager hosts the page
   * detail beside a conversation, and Pages could host a conversation the same
   * way. Being displayable anywhere does NOT make a pane app-less; it still has
   * one official home, and declaring it is what lets Expand mean "show this on
   * its own, in the app it belongs to" instead of stranding it in the host app.
   *
   * Mandatory: an omission is not a decision, so there is nothing to omit.
   */
  app: AppRef;
  component: ComponentType;
  chrome: NormalizedChrome;
  /** Default column width in pixels. Read by layout renderers (e.g. Miller). */
  width?: number;
  /**
   * This pane's header: the ONE slot its whole header row is rendered from,
   * title included. Auto-minted by `Pane.define` unless the pane borrows
   * another's (`Pane.define({ actions })`).
   */
  actionsSlot: PaneHeaderSlot;
  /**
   * The pane's resolve hook, from `Pane.define({ useResolve })`. Hook-named on
   * purpose: the React Compiler memoizes a plain-named call whose inputs did
   * not change, which would skip the hook's own hooks on a re-render (React
   * #311). The `use` prefix makes every caller's call site a hook call.
   */
  useResolve?: ResolveHook<Record<string, string>> | false;
  /**
   * The pane's title, from `Pane.define({ title })` — see {@link PaneTitleSpec}.
   * Read through {@link usePaneTitle} (text) and the header's title item
   * (`component`, else that text).
   */
  title: NormalizedPaneTitle;
  /**
   * The literal defaults record from `Pane.define({ options })`. Merged under
   * each slot's opener-supplied partial to produce a TOTAL option set — so a
   * pane's deep-link behavior is declared once, here, and never re-invented at a
   * read site with a `??`.
   */
  optionDefaults: PaneOptions;
  /**
   * Declares this pane a MAIN SURFACE — a pane whose entity is the identity of
   * the page (a conversation, a task, a page), as opposed to navigation
   * (lists/trees) or auxiliary tools (file peek, review, terminal). The
   * tab/document title resolves against the FIRST title owner in the route, so
   * aux panes stacked to its right never steal the title, and a main pane
   * opened as a drill-in under another main pane (e.g. a conversation under a
   * task) stays subordinate. Routes with no title owner fall back to the leaf.
   */
  titleOwner: boolean;
  /**
   * Declares this pane a COMPANION — it accompanies what is on screen rather
   * than being a destination of its own (an attached file's preview, opened
   * from a prompt being composed). At the HEAD of a route it keeps its surface's
   * index pane on screen to its left, so opening one from an app's bare root
   * (`/agents`, where the route is empty) lands beside the landing pane instead
   * of replacing it. Read by {@link usePaneRoute}; the URL is unchanged — the
   * index pane has none, so a reload resolves the same arrangement.
   */
  companion: boolean;
}

// Populated synchronously via useSyncPaneRegistry (called by MillerColumns).
// pane.close / pane.expand / parseUrl read from it; nobody writes to it
// outside the sync hook.
const registry = new Map<string, PaneInternal>();

// Reverse map from a pane's internal record back to its public PaneObject.
// Populated by makePaneObject at define time. Lets callers that only hold a
// PaneInternal (e.g. the resolve guard, which receives MatchEntry.pane) reach
// the object's hooks (useClose/usePromote) to reuse the standard chrome.
const paneObjectByInternal = new WeakMap<PaneInternal, AnyPane>();

// The plugin that owns each registered pane. Kept BESIDE the pane record rather
// than on it: `PaneInternal` is built by `Pane.define` (a pure factory that
// cannot see who is registering it), and the owner is only knowable at
// registry-sync, where the loader-stamped `_pluginId` rides the `Pane.Register`
// *contribution*. Writing it onto the record there would mutate a value
// returned from `useContributions()` — which `react-hooks/immutability`
// correctly rejects. Ownership is a registration fact, so it lives in the
// registry layer.
//
// Why it is threaded at all: a pane boundary carries no plugin marker of its
// own, so an upward DOM walk for UI attribution (the `ui-context` composition
// lineage) climbs straight past the pane to the app shell's `Apps.App`
// contribution and mis-attributes every pick inside a pane to the shell.
const paneOwnerByInternal = new WeakMap<PaneInternal, PluginId>();

/**
 * The plugin that registered a pane, or `undefined` before the pane has been
 * through {@link useSyncPaneRegistry}. Optional rather than throwing: a missing
 * owner degrades an attribution marker to "region with no owner", which is not
 * worth taking a layout down for.
 */
export function paneOwnerFor(internal: PaneInternal): PluginId | undefined {
  return paneOwnerByInternal.get(internal);
}

/** Resolve the public PaneObject for an internal pane record. */
export function paneObjectFor(internal: PaneInternal): AnyPane {
  const obj = paneObjectByInternal.get(internal);
  if (!obj) {
    throw new Error(`No PaneObject registered for pane "${internal.id}".`);
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Path helpers.
// ---------------------------------------------------------------------------

export interface MatchEntry {
  instanceId: number;
  uuid: string;
  pane: PaneInternal;
  /** Own-only params (only `:name`s from this pane's `segment`). */
  params: Record<string, string>;
  /** All params accumulated from the route root up to and including this pane. */
  fullParams: Record<string, string>;
  /** The pane's declared option defaults, merged under the opener's partial. Total. */
  options: PaneOptions;
  /** Ephemeral optimistic hint bag. `{}` on any rebuilt route. See {@link Hint}. */
  hint: PaneHintBag;
}

export interface PaneMatch {
  panes: MatchEntry[];
}

// ---------------------------------------------------------------------------
// Route-based URL parser + builder.
// ---------------------------------------------------------------------------

/**
 * Every way `segment` can match the URL starting at `cursor`, longest first.
 *
 * Exactly one way, or none — except for a segment ending in an optional
 * `:name?`, which can match with that part or without it. Both are offered, so
 * {@link parseUrl} can take the longer one and still fall back to the shorter
 * one when the longer leaves a remainder no pane matches.
 */
function matchSegmentParts(
  segment: string,
  urlSegments: string[],
  cursor: number,
): Array<{ params: Record<string, string>; consumed: number }> {
  const keyedNames = segmentKeyedParamNames(segment);
  // A segment with no keyed params reads the URL parts as they are — a raw `;`
  // in them is just text, exactly as before keyed params existed.
  if (keyedNames.length === 0) {
    return matchPositionalParts(segment, urlSegments, cursor);
  }
  // Otherwise the positional matcher compares each part WITHOUT its keyed
  // suffix, and each way it matches then reads the suffix off the last part it
  // consumed — the only part `fillSegment` writes one on. A suffix on any
  // earlier part is not this pane's spelling, so that way does not match.
  const split = urlSegments.map(splitKeyedPart);
  return matchPositionalParts(
    segment,
    split.map((p) => p.base),
    cursor,
  ).flatMap((m) => {
    const last = cursor + m.consumed - 1;
    for (let i = cursor; i < last; i++) {
      if (split[i]!.keyed !== null) return [];
    }
    const keyed = split[last]!.keyed;
    if (keyed === null) return [m];
    return [
      {
        params: { ...m.params, ...readKeyedParams(keyed, keyedNames) },
        consumed: m.consumed,
      },
    ];
  });
}

/** {@link matchSegmentParts} over the positional (`/`-separated) parts only. */
function matchPositionalParts(
  segment: string,
  urlSegments: string[],
  cursor: number,
): Array<{ params: Record<string, string>; consumed: number }> {
  if (!segment || segment === "/" || segment === "") return [];

  const segParts = parseSegmentParts(segment);
  if (segParts.length === 0) return [];

  const params: Record<string, string> = {};
  let consumed = 0;

  for (const part of segParts) {
    const idx = cursor + consumed;

    if (part.kind === "wildcard") {
      const rest = urlSegments.slice(idx);
      if (rest.length === 0) return [];
      params[part.name] = rest.map((s) => decodeURIComponent(s)).join("/");
      return [{ params, consumed: urlSegments.length - cursor }];
    }

    if (part.kind === "optional") {
      // Always the last part (`defineRoute` enforces it), so both arms end here.
      const without = { params: { ...params }, consumed };
      if (idx >= urlSegments.length) return [without];
      return [
        {
          params: {
            ...params,
            [part.name]: decodeURIComponent(urlSegments[idx]!),
          },
          consumed: consumed + 1,
        },
        without,
      ];
    }

    if (idx >= urlSegments.length) return [];

    if (part.kind === "param") {
      params[part.name] = decodeURIComponent(urlSegments[idx]!);
    } else if (part.text !== urlSegments[idx]) {
      return [];
    }

    consumed++;
  }

  return [{ params, consumed }];
}

/**
 * The result of parsing a (base-path-stripped) URL pathname into a route. A
 * discriminated union so callers can tell a genuine match — including the empty
 * bare-root route — from a URL that matched no registered pane. Distinguishing
 * the two is the whole point of the tri-state route: `matched []` is a bare app
 * root, while `unresolved` is a load-gap (the target pane's plugin may still be
 * loading in the deferred tier) or a genuinely dead link.
 */
export type ParsedRoute =
  | { status: "matched"; slots: PaneSlot[] } // slots [] ⇒ bare app root (explicit)
  | { status: "unresolved"; rawPath: string }; // a segment matched no registered pane

export function parseUrl(pathname: string): ParsedRoute {
  const normalized = pathname === "/" ? "" : pathname.replace(/^\/+|\/+$/g, "");
  const urlSegments = normalized ? normalized.split("/") : [];

  // Longest match first, falling back to a shorter one only when the longer
  // leaves a remainder no chain of panes can match. Two segments can both claim
  // the same start of a URL — `t/:taskId` and `t/:pluginId/:tableName`, or one
  // ending in an optional `:name?` — and taking the longer blindly turned a
  // perfectly parseable URL into `unresolved`. Whether the rest of the URL
  // parses from a cursor does not depend on how we got there, so a cursor that
  // failed once is remembered and never searched again: linear in the URL, not
  // exponential in the alternatives.
  const failed = new Set<number>();
  const parseFrom = (
    cursor: number,
  ): Array<{ paneId: string; params: Record<string, string> }> | null => {
    if (cursor === urlSegments.length) return [];
    if (failed.has(cursor)) return null;
    const candidates: Array<{
      paneId: string;
      params: Record<string, string>;
      consumed: number;
    }> = [];
    for (const pane of registry.values()) {
      for (const m of matchSegmentParts(pane.segment, urlSegments, cursor)) {
        candidates.push({ paneId: pane.id, ...m });
      }
    }
    // Stable, so equal lengths keep registry order — the tie-break it always had.
    candidates.sort((a, b) => b.consumed - a.consumed);
    for (const c of candidates) {
      if (c.consumed === 0) continue;
      const rest = parseFrom(cursor + c.consumed);
      if (rest) return [{ paneId: c.paneId, params: c.params }, ...rest];
    }
    failed.add(cursor);
    return null;
  };

  const parsed = parseFrom(0);
  // No chain of registered panes matches the whole URL: it is not resolvable at
  // this moment. `rawPath` is the normalized (slash-trimmed) app-relative path so
  // a consumer can seed a pending route (deferred plugin still loading) or, once
  // loading has settled, surface a not-found. Kept distinct from `matched []`.
  if (!parsed) return { status: "unresolved", rawPath: normalized };
  const route = parsed.map((s) => createSlot(s.paneId, s.params));

  // A bare app root (basePath-stripped pathname is "/") yields an EMPTY MATCHED
  // route — explicitly a match, not an unresolved URL. The index/landing pane is
  // NOT injected here: it is a main-area-renderer concern, resolved by
  // `useIndexMatch` (see below) and rendered only by MillerColumns. Keeping it
  // out of the route store means an overlay host (e.g. Sonata's PaneOverlayHost)
  // sees "nothing opened" at a bare root and renders no overlay, instead of
  // inheriting another app's index pane.
  return { status: "matched", slots: route };
}

export function buildRouteUrl(route: PaneSlot[]): string {
  if (route.length === 0) return "/";

  const parts: string[] = [];
  for (const slot of route) {
    const pane = registry.get(slot.paneId);
    if (!pane) throw new Error(`Unknown pane: ${slot.paneId}`);
    // `fillSegment` owns the `:name`/`:name*`/encode/missing-param logic — the
    // single source of truth shared with `RouteDef.path`.
    parts.push(...fillSegment(pane.segment, slot.params));
  }

  return "/" + parts.join("/") || "/";
}

// ---------------------------------------------------------------------------
// Layout route store — the primary source of truth for what's on screen.
//
// All per-route mutable state (`currentRoute`, `routeListeners`,
// `currentBasePath`, `prevResolvedByUuid`) plus the methods that read/write it
// live inside a `PaneStore` instance built by `createPaneStore()`. The pane
// *definitions* (`registry`, `paneObjectByInternal`, `indexInstanceIds`,
// `nextInstanceId`) stay module-global — one shared set across all stores.
//
// A `live` flag gates the side-effects that mirror the route to the browser
// (`window.history`, `popstate`/`shell:navigate` dispatch, `applyBasePath`).
// A live store behaves exactly like the historical module globals; a
// background store updates its in-memory route + notifies its own listeners
// only. Phase 2 (per-tab tabs) creates one store per tab and flips `live` on
// the focused one.
// ---------------------------------------------------------------------------

/**
 * The store-internal route state. Two states — the public tri-state
 * (pending / not-found) is folded at read time from the deferred-load signal, so
 * it is never persisted here (it flips on load progress).
 *
 * - `resolved` — the route is `slots` (possibly `[]` for the bare app root).
 * - `unresolved` — the URL matched no registered pane; `rawPath` is the
 *   normalized app-relative path to seed a pending route or surface a not-found.
 */
export type RouteState =
  | { kind: "resolved"; slots: PaneSlot[] }
  | { kind: "unresolved"; rawPath: string };

// Stable module-const empties so snapshot identity never churns between
// mutations: `getRoute()` returns this exact array for any unresolved state, and
// the server / initial snapshot of `useRouteState()` is this exact object.
const EMPTY: PaneSlot[] = [];
const RESOLVED_EMPTY: RouteState = { kind: "resolved", slots: EMPTY };

export interface PaneStore {
  /** Current in-memory route slots (`[]` for a bare root OR an unresolved URL). */
  getRoute(): PaneSlot[];
  /** Snapshot for `useSyncExternalStore` (identity-stable until mutation). */
  getRouteSnapshot(): PaneSlot[];
  /** Current tri-state route state (resolved slots vs unresolved rawPath). */
  getRouteState(): RouteState;
  /** Snapshot for `useSyncExternalStore` (identity-stable until mutation). */
  getRouteStateSnapshot(): RouteState;
  /** Subscribe to route changes; returns an unsubscribe. */
  subscribeRoute(cb: () => void): () => void;
  /** Replace the route (resolved). Mirrors to the browser when `live`. */
  setRoute(route: PaneSlot[], replace?: boolean): void;
  /**
   * Seed an unresolved (pending) route from a raw app-relative path — NO
   * url/history side-effects. Used at boot and for background tabs, where the URL
   * is owned elsewhere (the address bar / the focused tab).
   */
  seedPending(rawPath: string): void;
  /**
   * Live navigation to a not-yet-resolvable URL: set unresolved AND write
   * `history.state = { pending: rawPath }` + the URL, dispatching
   * `popstate`/`shell:navigate` like `setRoute`. Pushes a new history entry by
   * default; pass `replace` to mirror the URL in place (no stray entry — used by
   * the tab activate() to assert a freshly-focused pending tab's URL). No-ops the
   * history part when the store is not `live`.
   */
  navigatePending(rawPath: string, replace?: boolean): void;
  /** Re-derive the route from a (base-path-stripped) URL pathname. */
  syncRouteFromUrl(pathname: string): void;
  /** popstate/shell:navigate handler — restore from history.state or URL. */
  handleLocationChange(): void;
  reorderRoute(fromIndex: number, toIndex: number): void;
  restoreRoute(
    slots: Array<{
      paneId: string;
      params: Record<string, string>;
      options?: PaneOptions;
      /** The pane instance's id to keep; a fresh one when absent. */
      uuid?: string;
    }>,
  ): void;
  clearRoute(): void;
  /** Resolve the current route to a `PaneMatch` (memo-friendly, per-store). */
  resolveRoute(route: PaneSlot[]): PaneMatch | null;
  setBasePath(basePath: string): void;
  getBasePath(): string;
  /**
   * The full address — base path included — this store writes for `route`:
   * what the address bar shows once `route` is on screen, and so what a new
   * browser tab must be given to boot into the same layout.
   */
  routeUrl(route: PaneSlot[]): string;
  /**
   * The {@link routeUrl} of the route `restoreRoute(slots)` would put on
   * screen — the href half of a restore that is a link (a sidebar entry that
   * brings back a conversation's saved layout).
   */
  restoredRouteUrl(slots: Parameters<PaneStore["restoreRoute"]>[0]): string;
  /** Open a pane (non-positional). Used by `promote` and the open hooks. */
  openPaneImpl(
    internal: PaneInternal,
    params: Record<string, string>,
    opts?: { root?: boolean; options?: PaneOptions; hint?: PaneHintBag },
  ): void;
  close(internal: PaneInternal, instanceId: number): void;
  unwrap(instanceId: number): void;
  promote(internal: PaneInternal, instanceId: number): void;
  /** Rewrite one instance's own params in place. See `PaneObject.useSetParams`. */
  setParams(
    internal: PaneInternal,
    instanceId: number,
    params: Record<string, string>,
  ): void;
  /** Whether route mutations mirror to the browser URL/history. */
  live: boolean;
}

function createPaneStore(opts: { live: boolean } = { live: false }): PaneStore {
  let currentState: RouteState = RESOLVED_EMPTY;
  const routeListeners = new Set<() => void>();
  let currentBasePath = "";
  let prevResolvedByUuid = new Map<string, MatchEntry>();

  // The slots the rest of the store reads/mutates. An unresolved route has no
  // slots — it presents as the stable module-const EMPTY, so the slot-reading
  // mutators (open/close/reorder/…) behave exactly as they did when an
  // unresolved URL yielded `[]`.
  function currentSlots(): PaneSlot[] {
    return currentState.kind === "resolved" ? currentState.slots : EMPTY;
  }

  function notifyRouteListeners(): void {
    for (const fn of routeListeners) fn();
  }

  function applyBasePath(rawUrl: string): string {
    if (!currentBasePath) return rawUrl;
    if (rawUrl === "/") return currentBasePath;
    return currentBasePath + rawUrl;
  }

  function routeUrl(route: PaneSlot[]): string {
    return applyBasePath(buildRouteUrl(route));
  }

  function restoredRouteUrl(
    slots: Parameters<PaneStore["restoreRoute"]>[0],
  ): string {
    return routeUrl(
      slots.map((s) =>
        createSlot(s.paneId, s.params, s.options ?? {}, {}, s.uuid),
      ),
    );
  }

  function setRoute(route: PaneSlot[], replace = false): void {
    currentState = { kind: "resolved", slots: route };
    // The address bar moves BEFORE any listener hears of the change, so every
    // listener sees one world: a route listener that reads the URL (the tab
    // set persists the address bar as the route's rawPath — the key a reload
    // matches to give panes back their instance ids) never pairs the new route
    // with the previous URL.
    commitRoute(route, replace);
    notifyRouteListeners();
  }

  function commitRoute(route: PaneSlot[], replace: boolean): void {
    // Background stores update in-memory route + notify their own listeners
    // only; they never touch the browser URL/history.
    if (!store.live) return;
    // `hint` is deliberately NOT serialized: an optimistic mirror of server-owned
    // state must not outlive the navigation that created it, or it comes back as
    // stale data on the very paths (reload, back/forward) that have no opener to
    // vouch for it. Rebuilt routes carry `hint = {}` and read canonical instead.
    const serialized: SerializedSlot[] = route.map((s) => ({
      paneId: s.paneId,
      params: s.params,
      options: s.options,
      uuid: s.uuid,
    }));
    const fullUrl = routeUrl(route);
    if (fullUrl === currentRoutePath() && replace) return;
    // Emit a push/replace INTENT through the installed history adapter — the
    // pane primitive never touches `window.history` itself. The default adapter
    // writes `{ route }` verbatim; the shell adapter stamps `{ tabId, appId }`
    // into the entry so back/forward restores the full snapshot. Either way it
    // announces `shell:navigate` (never a synthetic popstate).
    historySink.peek().commit({
      url: fullUrl,
      state: { route: serialized },
      mode: replace ? "replace" : "push",
    });
  }

  function reorderRoute(fromIndex: number, toIndex: number): void {
    if (typeof window === "undefined") return;
    const route = [...currentSlots()];
    if (fromIndex < 0 || fromIndex >= route.length) return;
    if (toIndex < 0 || toIndex >= route.length) return;
    if (fromIndex === toIndex) return;
    const [item] = route.splice(fromIndex, 1);
    route.splice(toIndex, 0, item!);
    setRoute(route);
  }

  function restoreRoute(
    slots: Array<{
      paneId: string;
      params: Record<string, string>;
      options?: PaneOptions;
      uuid?: string;
    }>,
  ): void {
    if (typeof window === "undefined") return;
    // A restored slot keeps its uuid: it is the SAME pane instance coming back
    // (a reload, a background tab rebuilt from persistence), so whatever is
    // keyed by the instance (a Miller column's collapse, a pane's own saved
    // state) comes back with it.
    const route: PaneSlot[] = slots.map((s) =>
      createSlot(s.paneId, s.params, s.options ?? {}, {}, s.uuid),
    );
    if (route.length === 0) return;
    setRoute(route);
  }

  function clearRoute(): void {
    if (typeof window === "undefined") return;
    setRoute([]);
  }

  function seedPending(rawPath: string): void {
    currentState = { kind: "unresolved", rawPath };
    notifyRouteListeners();
  }

  function navigatePending(rawPath: string, replace = false): void {
    currentState = { kind: "unresolved", rawPath };
    // URL first, listeners second — see `setRoute`.
    if (store.live) {
      historySink.peek().commit({
        url: applyBasePath("/" + rawPath),
        state: { pending: rawPath },
        mode: replace ? "replace" : "push",
      });
    }
    notifyRouteListeners();
  }

  function syncRouteFromUrl(pathname: string): void {
    const parsed = parseUrl(pathname);
    if (parsed.status === "matched") {
      // A matched parse always wins (equality-guarded, as today) — the URL now
      // resolves to concrete panes.
      if (
        currentState.kind === "resolved" &&
        routesEqual(currentState.slots, parsed.slots)
      ) {
        return;
      }
      currentState = { kind: "resolved", slots: parsed.slots };
      notifyRouteListeners();
      return;
    }

    // Unresolved: the URL matched no registered pane. THE NO-CLOBBER RULE (the
    // linchpin of the tri-state route): a pre-registry parse during cold boot
    // must NOT wipe a route that was restored from persistence / prior
    // navigation — that is exactly the historical cold-boot clobber. So adopt the
    // unresolved state ONLY when the current state is not a resolved non-empty
    // route, OR loading has settled. After settle a genuinely dead link must
    // become visible (NotFound / error) instead of leaving a stale pane on
    // screen. (Within a session this path is nearly unreachable: address-bar
    // edits are full reloads and back/forward restores from `history.state`, so
    // this is really boot protection.)
    if (currentState.kind === "unresolved") {
      if (currentState.rawPath === parsed.rawPath) return;
      currentState = { kind: "unresolved", rawPath: parsed.rawPath };
      notifyRouteListeners();
      return;
    }
    const settled = getDeferredLoadState().deferredComplete;
    if (currentState.slots.length > 0 && !settled) return;
    currentState = { kind: "unresolved", rawPath: parsed.rawPath };
    notifyRouteListeners();
  }

  function resolveRoute(route: PaneSlot[]): PaneMatch | null {
    if (route.length === 0) {
      prevResolvedByUuid = new Map();
      return null;
    }
    const entries: MatchEntry[] = [];
    const accumulated: Record<string, string> = {};
    let routeStable = true;
    for (const slot of route) {
      const pane = registry.get(slot.paneId);
      if (!pane) {
        prevResolvedByUuid = new Map();
        return null;
      }
      Object.assign(accumulated, slot.params);
      const prev = prevResolvedByUuid.get(slot.uuid);
      const options = { ...pane.optionDefaults, ...slot.options };
      // A uuid is the pane INSTANCE, not its address: `useSetParams` rewrites an
      // instance's params in place, and back/forward restores an older address
      // under the same uuid. So the cached entry is reused only while what it
      // says still holds — otherwise the pane would read the params it had.
      if (
        routeStable &&
        prev &&
        prev.pane === pane &&
        sameParams(prev.params, slot.params) &&
        sameOptions(prev.options, options)
      ) {
        entries.push(prev);
      } else {
        routeStable = false;
        entries.push({
          instanceId: slot.instanceId,
          uuid: slot.uuid,
          pane,
          params: { ...slot.params },
          fullParams: { ...accumulated },
          options,
          hint: slot.hint,
        });
      }
    }
    prevResolvedByUuid = new Map(entries.map((e) => [e.uuid, e]));
    return { panes: entries };
  }

  function setBasePath(basePath: string): void {
    currentBasePath = normalizeAppPath(basePath);
  }

  function getBasePath(): string {
    return currentBasePath;
  }

  function handleLocationChange(): void {
    if (typeof window === "undefined") return;
    // Only the live (focused) store mirrors the browser URL/history. A
    // background tab's store must NOT read window.location here: every mounted
    // background surface re-runs this via `useSyncPaneRegistry`, and without
    // this gate they would all overwrite their in-memory route with the
    // *focused* tab's URL — destroying keep-alive. Background stores receive
    // their route only from `restoreRoute` (persistence) or from being
    // navigated while focused (held in memory).
    if (!store.live) return;
    const state = window.history.state as {
      route?: Array<{
        paneId: string;
        params: Record<string, string>;
        options?: PaneOptions;
        uuid?: string;
      }>;
      pending?: string;
    } | null;
    if (state?.route) {
      // No `hint`: history.state never carries one (see `setRoute`). Extra
      // `{ tabId, appId }` keys a shell adapter stamped in are ignored — this
      // reads only `route`/`pending`. `routesEqual` compares options only, so a
      // no-op rebuild leaves an in-memory hint intact; only a genuine
      // back/forward rebuilds the slot without it.
      const newRoute = state.route.map((s) =>
        createSlot(s.paneId, s.params, s.options ?? {}, {}, s.uuid),
      );
      if (
        currentState.kind === "resolved" &&
        routesEqual(currentState.slots, newRoute)
      )
        return;
      currentState = { kind: "resolved", slots: newRoute };
      notifyRouteListeners();
    } else if (typeof state?.pending === "string") {
      // A pending (unresolved) route round-trips through back/forward via
      // `history.state.pending`. Re-parse the URL rather than blindly restoring
      // the pending state: a deferred pane may have registered since this entry
      // was committed (the cold-deep-link case — the pending entry is stamped at
      // boot, before the target's plugin loads). `syncRouteFromUrl` upgrades the
      // route to `resolved` the instant the URL matches a registered pane, and
      // otherwise keeps it `unresolved` (same rawPath ⇒ no-op) — so a genuine
      // back/forward to a still-pending entry is unaffected, but a late
      // registration is no longer permanently shut out.
      syncRouteFromUrl(stripBasePath(currentRoutePath(), currentBasePath));
    } else {
      const pathname = stripBasePath(currentRoutePath(), currentBasePath);
      syncRouteFromUrl(pathname);
    }
  }

  function openPaneImpl(
    internal: PaneInternal,
    params: Record<string, string>,
    implOpts?: { root?: boolean; options?: PaneOptions; hint?: PaneHintBag },
  ): void {
    apply(
      computeOpen(currentSlots(), undefined, internal, params, {
        mode: implOpts?.root ? "root" : "push",
        options: implOpts?.options,
        hint: implOpts?.hint,
      }),
    );
  }

  function apply(next: OpenComputation): void {
    if (next.changed) setRoute(next.route, next.replace);
  }

  function close(internal: PaneInternal, instanceId: number): void {
    if (typeof window === "undefined") return;
    const route = currentSlots();
    const idx = route.findIndex((s) => s.instanceId === instanceId);
    if (idx <= 0) return;
    const newRoute = route.slice(0, idx);
    const replace = !internal.chrome.history;
    setRoute(newRoute, replace);
  }

  function unwrap(instanceId: number): void {
    if (typeof window === "undefined") return;
    const route = currentSlots();
    const idx = route.findIndex((s) => s.instanceId === instanceId);
    if (idx < 0) return;
    const newRoute = [...route.slice(0, idx), ...route.slice(idx + 1)];
    setRoute(newRoute);
  }

  function promote(internal: PaneInternal, instanceId: number): void {
    if (typeof window === "undefined") return;
    const next = computePromote(currentSlots(), internal, instanceId);
    if (next) apply(next);
  }

  function setParams(
    internal: PaneInternal,
    instanceId: number,
    params: Record<string, string>,
  ): void {
    const route = currentSlots();
    const idx = route.findIndex((s) => s.instanceId === instanceId);
    if (idx < 0) {
      throw new Error(
        `Pane "${internal.id}": setParams on instance ${instanceId}, which is not in the route.`,
      );
    }
    const slot = route[idx]!;
    const own = extractOwnParams(internal, params);
    if (sameParams(own, slot.params)) return;
    // The SAME slot — instanceId, uuid, options, hint and every pane after it
    // kept — so the column neither remounts nor loses its collapse / maximize
    // state; only its address changes.
    const next = [...route];
    next[idx] = { ...slot, params: own };
    setRoute(next, !internal.chrome.history);
  }

  const store: PaneStore = {
    getRoute: () => currentSlots(),
    getRouteSnapshot: () => currentSlots(),
    getRouteState: () => currentState,
    getRouteStateSnapshot: () => currentState,
    subscribeRoute: (cb) => {
      routeListeners.add(cb);
      return () => routeListeners.delete(cb);
    },
    setRoute,
    seedPending,
    navigatePending,
    syncRouteFromUrl,
    handleLocationChange,
    reorderRoute,
    restoreRoute,
    restoredRouteUrl,
    clearRoute,
    resolveRoute,
    setBasePath,
    getBasePath,
    routeUrl,
    openPaneImpl,
    close,
    unwrap,
    promote,
    setParams,
    live: opts.live,
  };

  return store;
}

// The default store mirrors the historical module-global behavior exactly: it
// is live and is what the live-store sink holds until a tab manager installs a
// focused tab's store, so the imperative free functions and the (single)
// module-level window listener delegate to it. With exactly one store (Phase 1)
// everything behaves identically to before.
const defaultStore = createPaneStore({ live: true });

/**
 * The focused store the imperative (non-hook) navigation API targets, AND the
 * store the single module-level window listener forwards browser back/forward
 * to. Filled with `defaultStore`, which is the whole standalone behavior, so
 * every reader has a store to talk to before any tab manager exists; the tab
 * manager re-points it on focus switch via {@link setLiveStore}.
 */
const liveStoreSink = defineInstallSink<PaneStore>({
  name: "pane.live-store",
  fallback: defaultStore,
  what: "the focused tab's pane store (re-pointed by apps-core/tabs on focus switch)",
});

/**
 * Re-point the live store — the target of every imperative (non-hook)
 * navigation call (`openPane`, `peekRoute`, `restoreRoute`, …) and of the
 * module-level `popstate`/`shell:navigate` window listener. Phase 2's tab
 * manager calls this when the focused tab changes, after flipping the old
 * store's `live` off and the new store's `live` on; browser back/forward then
 * drives the focused tab's store.
 *
 * The install disposer is deliberately dropped. This is a RE-POINT, not a
 * scoped installation: the caller says "the focused tab is now this one", and
 * nothing about that is meant to be undone later — the next focus switch
 * overwrites it. Restoring the previously-focused tab's store on some teardown
 * would point the URL writer at a tab the user has already left.
 */
export function setLiveStore(store: PaneStore): void {
  liveStoreSink.install(store);
}

// Exactly ONE module-level window listener for the whole app, and it listens to
// REAL browser back/forward ONLY. `popstate` is the single place URL +
// `history.state` are read back — it delegates to the installed history
// adapter's `restore()` (default: rebuild the live store from `history.state`;
// shell: restore the whole tab/app/route snapshot). Programmatic navigation
// announces `shell:navigate` instead, so it never reaches here — a hard event
// contract that replaces the old synthetic-popstate / `routesEqual`-bail dance.
// The tab provider must NOT add a second `popstate` listener.
if (typeof window !== "undefined") {
  // Install the live-store accessor so the default adapter's `restore()` can
  // reach the focused store without importing this module back (see
  // history-sink). Installed at module load, never torn down, so the disposer
  // has nothing to restore to.
  liveStoreAccessorSink.install(() => liveStoreSink.peek());
  window.addEventListener("popstate", () => {
    historySink.peek().restore();
  });
}

export { createPaneStore, defaultStore };

// ---------------------------------------------------------------------------
// PaneStore React context. There is deliberately NO default store: the context
// is `null` until a `PaneSurfaceProvider` binds the surface's own store.
//
// It used to default to the module-level `defaultStore`, which read as a
// harmless "preserve pre-tabs behavior" fallback but became a silent trap the
// moment `TabsProvider` started calling `setLiveStore(focused.store)`: from
// that instant `defaultStore` is orphaned — still `live: true`, so its commits
// keep writing the URL, but no renderer ever reads it. A component rendered
// outside every surface (global chrome: the action bar at `Core.Root` or
// `Apps.TabBarActions`) therefore got a store that swallowed navigation and
// left only a URL change behind. `defaultStore.basePath` compounds it: the free
// `setBasePath()` in apps-layout runs during render while `TabsProvider` is
// still unmounted, so the FIRST app rendered freezes into it forever, and those
// dead URLs carry the boot app's prefix regardless of which app you are in.
//
// Making this `null` turns that mistake into a loud throw at first render
// instead of a click that silently does nothing.
//
// This is the REACTIVE read — "re-render me when the route changes" — and that
// genuinely needs a surface, so it stays a throw. Merely OPENING a pane does
// not: `useOpenPane` takes `useStoreOrLive()` and works in global chrome too.
// ---------------------------------------------------------------------------

export const PaneStoreContext = createContext<PaneStore | null>(null);

export function usePaneStore(): PaneStore {
  const store = useContext(PaneStoreContext);
  if (!store) {
    throw new Error(
      "usePaneStore(): no <PaneSurfaceProvider> in the tree. This component " +
        "renders outside every pane surface (global chrome such as the action " +
        "bar), so it has no route to READ. Opening a pane from here is fine — " +
        "useOpenPane() targets the focused tab. It is the reactive reads " +
        "(useRoute/pane.useToggle/pane.useClose) that need a surface; to react " +
        "to the focused tab's route from global chrome, use the cross-app " +
        "navigate()/useTabs() from @plugins/apps-core/plugins/tabs/web.",
    );
  }
  return store;
}

/**
 * Store read for the few callers that legitimately render OUTSIDE every
 * surface: the apps root, which syncs the global pane registry and the base
 * path on behalf of the focused tab. They perform a global imperative op on
 * whichever store currently owns the URL — the surface store when there is one,
 * otherwise the LIVE (focused-tab) store, mirroring the free `setBasePath()` /
 * `peekRoute()` functions they sit beside.
 *
 * Deliberately NOT the public `usePaneStore()`: this is a non-reactive
 * imperative read, so a component that needs to re-render on route changes must
 * still be inside a surface. And deliberately not `defaultStore` — that is the
 * orphan whose silent commits caused global chrome to write dead URLs.
 */
function useStoreOrLive(): PaneStore {
  // eslint-disable-next-line install-sink/no-render-phase-peek -- deliberately a sample, not a subscription (see above): the sink is re-pointed by TabsProvider's one-shot wiring DURING its own render, so subscribing here would notify an already-mounted subscriber mid-render. The callers do a global imperative op and re-render for their own reasons; anything that must re-render on route changes belongs inside a surface.
  return useContext(PaneStoreContext) ?? liveStoreSink.peek();
}

/**
 * The same resolution as {@link useStoreOrLive}, deferred to CALL time.
 *
 * For an op that fires from a handler rather than during render, "which tab is
 * focused" must be answered when the user clicks, not when the component
 * rendered — global chrome (a popover hanging off the action bar) stays mounted
 * across focus switches, so a store sampled at render would navigate the tab
 * the user has already left. Inside a surface the context store wins and this
 * is identical to reading it directly.
 */
function useStoreResolver(): () => PaneStore {
  const store = useContext(PaneStoreContext);
  return useCallback(() => store ?? liveStoreSink.peek(), [store]);
}

// ---------------------------------------------------------------------------
// Surface app context. Carries the owning `appId` of the surface (tab/window)
// so consumers can read "which app owns the surface I'm rendered in" without
// touching `window.location` — the focused-URL read is wrong the moment a
// second surface is visible. `undefined` outside any `PaneSurfaceProvider`, so
// `useActiveApp`/`useCurrentAppId` fall back to the URL-derived focused app.
// ---------------------------------------------------------------------------

export const PaneSurfaceAppContext = createContext<string | undefined>(
  undefined,
);

export function useSurfaceAppId(): string | undefined {
  return useContext(PaneSurfaceAppContext);
}

// ---------------------------------------------------------------------------
// Load-scope context. The fs plugin-path prefix (e.g. "apps/plugins/pages/") of
// the app owning this surface, so a fallback surface can ask "did a plugin under
// THIS app's subtree fail to load" (`useHasLoadErrorUnder`) and show an app-load
// error instead of a blank/not-found. Empty string ("") outside any surface that
// provides it — `hasLoadErrorUnder("")` is always false, never a global flag.
// ---------------------------------------------------------------------------

export const PaneLoadScopeContext = createContext<string>("");

/**
 * Single provider supplying BOTH the active {@link PaneStore} (via
 * {@link PaneStoreContext}) and the app base path (via the existing
 * {@link PaneBasePathContext}) to a pane surface. The layout renderers
 * (miller / full-pane / host / overlay) read the store implicitly through the
 * route hooks and the base path through `PaneBasePathContext`, so wrapping a
 * subtree in this provider rebinds its entire route to `store` with no renderer
 * changes. Phase 2 mounts one `PaneSurfaceProvider` per tab.
 *
 * It ALSO resolves the route once for the whole surface and provides
 * {@link PaneMatchContext} (see {@link SurfaceMatchProvider}). The match is a
 * property of the *surface*, not of the layout renderer that happens to paint
 * the main area: a sidebar or a toolbar is a SIBLING of the renderer's subtree,
 * so while the renderers owned the provider every route read from chrome
 * silently saw no match. Resolving here makes that class of bug
 * unrepresentable.
 */
export function PaneSurfaceProvider({
  store,
  basePath,
  appId,
  surfaceId,
  loadScopePrefix,
  children,
}: {
  store: PaneStore;
  basePath: string;
  /** Owning app of this surface; read via {@link useSurfaceAppId}. */
  appId?: string;
  /** Stable per-surface-instance id (the tab's `tabId`); read via `useSurfaceTabId`
   *  from `@plugins/primitives/plugins/scope/plugins/surface-id/web`. */
  surfaceId?: string;
  /**
   * Fs plugin-path prefix of the app owning this surface (e.g.
   * "apps/plugins/pages/"); provided via {@link PaneLoadScopeContext} so the
   * fallback surface can scope a load-error check to this app. Omit for surfaces
   * with no app subtree (defaults to "").
   */
  loadScopePrefix?: string;
  children: ReactNode;
}): ReactNode {
  return createElement(
    PaneStoreContext.Provider,
    { value: store },
    createElement(
      PaneBasePathContext.Provider,
      { value: basePath },
      createElement(
        PaneSurfaceAppContext.Provider,
        { value: appId },
        createElement(
          PaneLoadScopeContext.Provider,
          { value: loadScopePrefix ?? "" },
          createElement(
            SurfaceIdContext.Provider,
            { value: surfaceId },
            createElement(SurfaceMatchProvider, { basePath, children }),
          ),
        ),
      ),
    ),
  );
}

/**
 * Resolves this surface's route match ONCE and provides it to the whole surface
 * subtree — sidebar, toolbar and main area alike.
 *
 * It is a separate component on purpose: `PaneSurfaceProvider`'s own hooks run
 * ABOVE the `PaneStoreContext.Provider` it renders, so a `usePaneRoute()` call
 * there would read the OUTER store context (null at the top level → throw, or a
 * parent surface's store). Mounting the resolve below both the store and the
 * base-path providers is what makes it read this surface's own store.
 *
 * `usePaneRoute` is not a pure read — it also sets the store's base path and
 * syncs the pane registry (both render-phase). Doing that here means the whole
 * preamble runs before ANY of the app subtree renders, instead of after the
 * sidebar has already painted.
 */
function SurfaceMatchProvider({
  basePath,
  children,
}: {
  basePath: string;
  children: ReactNode;
}): ReactNode {
  const match = usePaneRoute(basePath);
  return createElement(PaneMatchContext.Provider, { value: match }, children);
}

// ---------------------------------------------------------------------------
// Imperative (non-hook) route API — delegates to the live store. Keeps the
// ~40 imperative call sites and external consumers (pane-restore, miller drag,
// library/story/conversation-list) untouched.
// ---------------------------------------------------------------------------

/**
 * The focused tab's route, sampled now. Named `peek…` because it is exactly
 * that — a one-shot read of the live-store slot AND of the route in it, correct
 * from an event handler or effect and wrong during render, where the answer
 * would be frozen. A render path reads `useRoute()` instead. The name is what
 * makes every call site visible to `install-sink/no-render-phase-peek`.
 */
export function peekRoute(): PaneSlot[] {
  return liveStoreSink.peek().getRoute();
}

export function reorderRoute(fromIndex: number, toIndex: number): void {
  liveStoreSink.peek().reorderRoute(fromIndex, toIndex);
}

export function restoreRoute(
  slots: Array<{
    paneId: string;
    params: Record<string, string>;
    options?: PaneOptions;
    uuid?: string;
  }>,
): void {
  liveStoreSink.peek().restoreRoute(slots);
}

/**
 * Navigate to the EMPTY route — the only public way to do so. `restoreRoute`
 * refuses an empty array and `setRoute` is store-internal, so full-pane apps
 * had no way to go "back to index" (e.g. ← Library). `setRoute([])` builds URL
 * "/" (→ the app root via applyBasePath), pushes history, and notifies; the
 * empty route then re-resolves to the index pane via `useIndexMatch`.
 */
export function clearRoute(): void {
  liveStoreSink.peek().clearRoute();
}

export function setBasePath(basePath: string): void {
  liveStoreSink.peek().setBasePath(basePath);
}

/** The live store's base path, sampled now — same one-shot contract as {@link peekRoute}. */
export function peekBasePath(): string {
  return liveStoreSink.peek().getBasePath();
}

function useRouteSlots(): PaneSlot[] {
  const store = usePaneStore();
  return useSyncExternalStore(
    store.subscribeRoute,
    store.getRouteSnapshot,
    () => [],
  );
}

/**
 * The context surface's tri-state route state (resolved slots vs unresolved
 * rawPath), reactive over the same store subscription as {@link useRoute}. The
 * server / initial snapshot is the module-const resolved-empty. Consumers fold
 * the public pending / not-found distinction from this plus the deferred-load
 * signal (see {@link usePaneRoute} and the layout's fallback surface).
 */
export function useRouteState(): RouteState {
  const store = usePaneStore();
  return useSyncExternalStore(
    store.subscribeRoute,
    store.getRouteStateSnapshot,
    () => RESOLVED_EMPTY,
  );
}

/** Shallow equality over two slots' own params. */
function sameParams(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => a[k] === b[k]);
}

/** Shallow equality over two opener-supplied option partials. */
function sameOptions(a: PaneOptions, b: PaneOptions): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => a[k] === b[k]);
}

/**
 * Slot identity for the `handleLocationChange` bail-out: `(paneId, params, options)`.
 *
 * `hint` is excluded, and that is load-bearing. `history.state` is written
 * hint-less (see `setRoute`); on a browser back/forward that lands on a route
 * equal-but-for-the-hint, counting the hint here would rebuild the slot from the
 * hint-less state and wipe the very hint the open painted with.
 */
function routesEqual(a: PaneSlot[], b: PaneSlot[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.paneId !== b[i]!.paneId) return false;
    if (!sameParams(a[i]!.params, b[i]!.params)) return false;
    if (!sameOptions(a[i]!.options, b[i]!.options)) return false;
  }
  return true;
}

function extractOwnParams(
  pane: PaneInternal,
  allParams: Record<string, string>,
): Record<string, string> {
  const names = segmentParamNames(pane.segment);
  const own: Record<string, string> = {};
  for (const name of names) {
    if (name in allParams) own[name] = allParams[name]!;
  }
  return own;
}

// ---------------------------------------------------------------------------
// The ancestor chain of an open — ONE algorithm, so `params` means one thing on
// every path.
//
// A pane's `params` are its route's CHAINED set: every ancestor's `:name` plus
// its own, because that is what a URL needs, and `tsc` makes an opener supply
// all of them. Three of the four open paths nonetheless built their target's
// slot from `extractOwnParams` alone and never looked at the ancestors, so the
// half of the argument the caller was FORCED to pass was deleted by the callee.
// `openPane(deploymentDetailPane, { serverId, deploymentId }, { mode: "push" })`
// produced `/…/dep/<id>` with no server anywhere in it; Expand on that pane then
// walked the DECLARED chain, found nothing supplying `:serverId`, fell back to
// re-rooting, and threw out of `buildRouteUrl` — after `setRoute` had already
// committed the route and notified, leaving the store holding an address whose
// URL never landed.
//
// So there is one rule, and the three functions below are that rule applied:
//
//     AN OPEN NEVER DISCARDS A PARAM THE CALLER SUPPLIED.
//
// ---------------------------------------------------------------------------

/**
 * The target's declared ancestors, root-first, each paired with the registry
 * entry that knows what it names — `undefined` when that pane is not registered.
 *
 * Unregistered is a real state, not a bug to assert away: pane registration
 * follows PLUGIN LOAD (`useSyncPaneRegistry` rebuilds the registry from the
 * `Pane.Register` contributions of whatever has loaded), and a pane's declared
 * ancestor routinely lives in a different plugin from the pane itself —
 * `task-detail` is defined in `tasks-core` while its `tasks-root` parent pane is
 * registered by `tasks/task-detail`. Throwing here would turn a deferred-tier
 * load window into a crash on the most-opened pane in the app. What the absence
 * costs instead is measured in {@link chainSlots}.
 */
function declaredAncestors(
  target: PaneInternal,
): Array<{ id: string; internal: PaneInternal | undefined }> {
  return target.parentPaneIds.map((id) => ({ id, internal: registry.get(id) }));
}

/**
 * Can `prefix` — the slots that would survive to the left of `target` — hold
 * this address?
 *
 * False when the prefix already carries a DECLARED ANCESTOR of the target with a
 * different value for one of that ancestor's own params: a run row for server B
 * listed inside server A's page is ordinary data, so the answer is "this
 * position cannot host that address", and the open rebuilds from scratch rather
 * than producing a route that says A and means B. Deliberately NOT a throw —
 * there is nothing wrong with the caller, the program, or the data.
 *
 * A param the caller did not supply cannot disagree with anything, so it is
 * skipped: the prefix's value stands and nothing is discarded.
 */
function prefixHosts(
  prefix: PaneSlot[],
  target: PaneInternal,
  params: Record<string, string>,
): boolean {
  for (const { id, internal } of declaredAncestors(target)) {
    const slot = prefix.find((s) => s.paneId === id);
    if (!slot) continue;
    // A slot's params are own-only by construction, so its own keys are the
    // honest fallback for an ancestor whose pane is not registered to be asked.
    const names = internal
      ? segmentParamNames(internal.segment)
      : Object.keys(slot.params);
    for (const name of names) {
      const wanted = params[name];
      if (wanted !== undefined && slot.params[name] !== wanted) return false;
    }
  }
  return true;
}

/**
 * The ancestor slots to materialize ahead of `target`, root-first.
 *
 * FROM SCRATCH (`mode: "root"`, or an open with no caller pane to be relative
 * to) there is no prefix, so the declared chain IS the route's ancestry and the
 * whole of it is materialized — including ancestors that name no param, which is
 * what puts the tasks tree beside a task detail opened from nowhere.
 *
 * RELATIVE (push / swap) the caller's prefix survives and already stands where
 * those ancestors would, so only the ones that CARRY SOMETHING are inserted:
 * an ancestor's slot holds exactly its own segment's names (`extractOwnParams`),
 * so one that names nothing can carry nothing, and inserting it would add a
 * Miller column nobody asked for while omitting it discards nothing. That is a
 * derivation of the rule, not an exception to it — and it is also the empirical
 * cut: of the relative-mode call sites whose target declares ancestors, all but
 * one target a PARAMLESS chain (task detail under the tasks root, trace detail,
 * report detail, prototype detail, …).
 *
 * By the same derivation, an ancestor the caller named NOTHING for carries
 * nothing either, and is skipped rather than minted empty — in both modes. That
 * is the deliberate answer to "paramful ancestor, no param supplied": minting it
 * empty is what made `buildRouteUrl` throw AFTER the store had been mutated, and
 * throwing here instead would crash Expand on any route that legitimately holds
 * a pane without its ancestor (`/agents/c/<id>/dep/<d>` parses to exactly that).
 * Skipping discards nothing and yields a shorter route that parses back to
 * itself. Supplying SOME of a multi-param ancestor's names is the one shape that
 * cannot be honoured either way, and throws.
 *
 * `prefix` is one thing: the slots that will survive to the left of the target.
 * From scratch none do, so it is passed empty and never consulted.
 */
function chainSlots(
  target: PaneInternal,
  params: Record<string, string>,
  prefix: PaneSlot[],
  opts: { fromScratch: boolean },
): PaneSlot[] {
  const slots: PaneSlot[] = [];
  let skippedUnregistered = false;

  for (const { id, internal } of declaredAncestors(target)) {
    if (!internal) {
      skippedUnregistered = true;
      continue;
    }
    // An optional `:name?` is never NEEDED — the ancestor has a URL without it
    // — so only the required names decide whether it can be minted; an
    // optional one the caller did supply still makes it carry something.
    const required = segmentRequiredParamNames(internal.segment);
    const supplied = required.filter((name) => name in params);
    if (supplied.length > 0 && supplied.length < required.length) {
      throw new Error(
        `Pane "${target.id}": ancestor "${id}" needs ${required.map((n) => `"${n}"`).join(", ")} ` +
          `but only ${supplied.map((n) => `"${n}"`).join(", ")} was supplied. ` +
          `An open takes the CHAINED param set — every ancestor's, plus the target's own.`,
      );
    }
    const carries =
      supplied.length === required.length &&
      segmentParamNames(internal.segment).some((name) => name in params);
    if (opts.fromScratch) {
      if (required.length > 0 && !carries) continue;
    } else {
      if (!carries) continue;
      if (prefix.some((s) => s.paneId === id)) continue;
    }
    slots.push(createSlot(id, extractOwnParams(internal, params)));
  }

  // An unregistered ancestor was skipped above because it cannot be
  // materialized — a route holding a slot for an unregistered pane resolves to
  // nothing (`resolveRoute`) and has no URL (`buildRouteUrl` throws). That skip
  // is allowed to cost NOTHING, and here we check that it did: in relative mode
  // `params` is exactly the target's chained set, so a key that no surviving or
  // minted slot carries is a param the open would have discarded. (From scratch
  // the same check is unavailable rather than unwanted: `promote` unions the
  // params of every slot left of the pane it re-roots, so its `params` is
  // legitimately a superset of the chain and a leftover key proves nothing. The
  // only way to close that gap is for `PaneInternal` to carry its parents'
  // SEGMENTS rather than only their ids, which is a change to pane identity, not
  // to opening.)
  if (!opts.fromScratch && skippedUnregistered) {
    const carried = new Set(segmentParamNames(target.segment));
    for (const slot of [...prefix, ...slots]) {
      for (const key of Object.keys(slot.params)) carried.add(key);
    }
    const dropped = Object.keys(params).filter((key) => !carried.has(key));
    if (dropped.length > 0) {
      throw new Error(
        `Pane "${target.id}": opening it would discard ${dropped.map((d) => `"${d}"`).join(", ")}, ` +
          `because a declared ancestor is not registered (its plugin has not loaded). ` +
          `Register the ancestor pane, or open the target from a route that already holds it.`,
      );
    }
  }

  return slots;
}

/**
 * The route up to AND INCLUDING the target, opened relative to `prefix`.
 *
 * The one shape all three relative branches share, so swap / push-left /
 * push-right cannot drift on what "relative" means. Each branch owns only which
 * prefix it hands in and what it appends after.
 */
function relativeHead(
  prefix: PaneSlot[],
  target: PaneInternal,
  params: Record<string, string>,
  ownParams: Record<string, string>,
  options: PaneOptions,
  hint: PaneHintBag,
): PaneSlot[] {
  const hosted = prefixHosts(prefix, target, params);
  const kept = hosted ? prefix : EMPTY;
  return [
    ...kept,
    ...chainSlots(target, params, kept, { fromScratch: !hosted }),
    createSlot(target.id, ownParams, options, hint),
  ];
}

/** What an open asks for — `useOpenPane`'s `opts`, erased. */
export interface OpenRequest {
  mode: PaneOpenMode;
  side?: "left" | "right";
  options?: PaneOptions;
  hint?: PaneHintBag;
}

/** Where an open lands. See {@link computeOpen}. */
export interface OpenComputation {
  /** The route after the open — the current route itself when `!changed`. */
  route: PaneSlot[];
  /** Write it as a history replace (the target opts out of history). */
  replace: boolean;
  /** False when the target is already on screen as asked: nothing to write. */
  changed: boolean;
}

/**
 * The route an open produces, computed without writing it — THE one place the
 * open semantics live (modes, sides, dedup, ancestor chain; see
 * `useOpenPane`'s doc in CLAUDE.md).
 *
 * Every path that opens goes through it — `useOpenPane`'s callback,
 * `store.openPaneImpl`, `promote` — and so does every path that only needs to
 * know where an open WOULD land: a link's ⌘/middle-click opens that route's URL
 * in a browser tab. One function is what keeps the URL a link hands the browser
 * from drifting away from what the plain click on the same link does.
 *
 * `callerInstanceId` is the pane the open is relative to; `undefined`, or an
 * instance no longer in `currentRoute`, is a non-positional open.
 */
export function computeOpen(
  currentRoute: PaneSlot[],
  callerInstanceId: number | undefined,
  target: PaneInternal,
  params: Record<string, string>,
  opts: OpenRequest,
): OpenComputation {
  const options = opts.options ?? {};
  const hint = opts.hint ?? {};
  const replace = !target.chrome.history;
  const unchanged: OpenComputation = {
    route: currentRoute,
    replace,
    changed: false,
  };
  const to = (route: PaneSlot[]): OpenComputation => ({
    route,
    replace,
    changed: true,
  });
  const ownParams = extractOwnParams(target, params);

  // append: beside whatever is on screen, wherever the open comes from — the
  // one positional open global chrome (a popover in the action bar) can make,
  // since it has no caller to be relative to. A last pane of the same kind is
  // REPLACED rather than stacked, so opening one attachment after another
  // keeps one preview column instead of growing a row of them.
  if (opts.mode === "append") {
    const last = currentRoute.at(-1);
    if (
      last?.paneId === target.id &&
      sameParams(ownParams, last.params) &&
      sameOptions(options, last.options)
    )
      return unchanged;
    const head =
      last?.paneId === target.id ? currentRoute.slice(0, -1) : currentRoute;
    return to(relativeHead(head, target, params, ownParams, options, hint));
  }

  const callerIndex =
    opts.mode === "root" || callerInstanceId === undefined
      ? -1
      : currentRoute.findIndex((s) => s.instanceId === callerInstanceId);

  if (callerIndex < 0) {
    // Non-positional. Not `root` ⇒ look for the target in the route first.
    if (opts.mode !== "root") {
      const existingIdx = currentRoute.findIndex((s) => s.paneId === target.id);
      // Replacing the slot in place is only honest where the route can host
      // this address. Without the guard, opening a deployment on a DIFFERENT
      // server rewrote the leaf and left the old `server/:serverId` standing to
      // its left — a route that says one server and means another, and (when
      // the leaf params happened to match) a click that did nothing at all.
      if (
        existingIdx >= 0 &&
        prefixHosts(currentRoute.slice(0, existingIdx), target, params)
      ) {
        const existing = currentRoute[existingIdx]!;
        // Identity is (paneId, params, options). A hint is not identity: two
        // opens that differ only by their optimistic hint must dedupe to the
        // same slot, or the pane remounts (or stacks) for a display-only value.
        if (
          sameParams(ownParams, existing.params) &&
          sameOptions(options, existing.options)
        )
          return unchanged;
        // Everything right of the slot is truncated, exactly as before — but the
        // slot is rebuilt through the same relative open as every other path, so
        // an ancestor the caller named and the route does not yet carry is
        // inserted instead of dropped.
        return to(
          relativeHead(
            currentRoute.slice(0, existingIdx),
            target,
            params,
            ownParams,
            options,
            hint,
          ),
        );
      }
    }

    // Build a fresh route from the target's declared ancestry. Nothing of the
    // old route survives, so nothing of it is consulted either: an ancestor's
    // params come from what the CALLER supplied. (They used to be read off a
    // matching slot in the outgoing route when one was there, which quietly
    // beat the caller — an open for server B landing on the page for server A.)
    return to([
      ...chainSlots(target, params, EMPTY, { fromScratch: true }),
      createSlot(target.id, ownParams, options, hint),
    ]);
  }

  const caller = currentRoute[callerIndex]!;

  // swap: the caller's slot BECOMES the target — same column, children
  // truncated. Two shapes, one meaning ("navigate the column I am in"):
  // the same pane showing a different entity (a dependency chip switching
  // the task detail to another task), and a DIFFERENT pane taking the
  // column over (the pages tree column becoming the page that was clicked).
  // The second used to fall through to the right-push below — a mode that
  // silently did something else whenever the target happened not to be the
  // caller, which is exactly the kind of quiet mismatch a caller cannot see.
  if (opts.mode === "swap") {
    // Only a same-pane swap can be a no-op: a different pane in the column
    // is a change however the params compare.
    if (
      target.id === caller.paneId &&
      sameParams(ownParams, caller.params) &&
      sameOptions(options, caller.options)
    )
      return unchanged;
    return to(
      relativeHead(
        currentRoute.slice(0, callerIndex),
        target,
        params,
        ownParams,
        options,
        hint,
      ),
    );
  }

  if (opts.side === "left") {
    const alreadyAncestor = currentRoute
      .slice(0, callerIndex)
      .some((s) => s.paneId === target.id);
    if (!alreadyAncestor) {
      // The caller and everything right of it survive: a left-push inserts
      // ahead of the caller rather than replacing anything. Only the part
      // LEFT of the caller is the target's prefix, so only that part is
      // rebuilt when it cannot host the address.
      return to([
        ...relativeHead(
          currentRoute.slice(0, callerIndex),
          target,
          params,
          ownParams,
          options,
          hint,
        ),
        ...currentRoute.slice(callerIndex),
      ]);
    }
  }

  // push right (default): truncate after caller, append target
  return to(
    relativeHead(
      currentRoute.slice(0, callerIndex + 1),
      target,
      params,
      ownParams,
      options,
      hint,
    ),
  );
}

/**
 * Where re-rooting instance `instanceId` lands: the same pane, alone at the
 * root, carrying every param its position in the route gave it. `null` when the
 * instance is not in the route — there is nothing to promote.
 */
function computePromote(
  currentRoute: PaneSlot[],
  internal: PaneInternal,
  instanceId: number,
): OpenComputation | null {
  const idx = currentRoute.findIndex((s) => s.instanceId === instanceId);
  if (idx < 0) return null;
  const fullParams: Record<string, string> = {};
  for (let i = 0; i <= idx; i++) {
    Object.assign(fullParams, currentRoute[i]!.params);
  }
  // Options carry forward (they are the pane's configuration); the hint does
  // not — promoting is a navigation, and the promoted pane re-reads canonical.
  return computeOpen(currentRoute, undefined, internal, fullParams, {
    mode: "root",
    options: currentRoute[idx]!.options,
  });
}

// ---------------------------------------------------------------------------
// Router contexts.
// ---------------------------------------------------------------------------

// Three-state on purpose, mirroring `PaneStoreContext`:
//   `PaneMatch` — the route resolved to this set of panes.
//   `null`      — resolved, but there is no match (pending URL / not-found). A
//                 LEGITIMATE in-surface answer.
//   `undefined` — no `PaneSurfaceProvider` above us at all. A wiring bug.
//
// Collapsing the last two into one `null` is what let the Pages sidebar's
// active-page highlight stay dead for months: "there is no surface" and "this
// pane is not in the route" were the same value, so the broken case looked
// exactly like the normal one. See {@link useMatchOrThrow}.
export const PaneMatchContext = createContext<PaneMatch | null | undefined>(
  undefined,
);
export const PaneInstanceContext = createContext<number | undefined>(undefined);

/**
 * The read of {@link PaneMatchContext}. Turns "rendered outside every pane
 * surface" into a loud throw and returns the honest `PaneMatch | null` for
 * everything inside one. The one exception is `pane.useOpenedHere()`, which
 * reads the context itself because "outside every surface" has a true answer
 * for it — see there.
 */
function useMatchOrThrow(): PaneMatch | null {
  const match = useContext(PaneMatchContext);
  if (match === undefined) {
    throw new Error(
      "No <PaneSurfaceProvider> in the tree: this component renders outside " +
        "every pane surface (global chrome such as the action bar), so it has " +
        "no pane route to read. Use the cross-app navigate() from " +
        "@plugins/apps-core/plugins/tabs/web instead.",
    );
  }
  return match;
}

export function usePaneMatch(): PaneMatch | null {
  return useMatchOrThrow();
}

/**
 * A pane's own `MatchEntry` — the instance this component renders in when it is
 * one of that pane's, else the pane's first entry — or `null` when the pane is
 * not in the current match. Plugin-internal (not in the barrel): `PaneChrome`
 * reads the title's params, hint and options off it.
 */
export function usePaneEntry(internal: PaneInternal): MatchEntry | null {
  const match = useMatchOrThrow();
  const instanceId = useContext(PaneInstanceContext);
  if (!match) return null;
  if (instanceId !== undefined) {
    const entry = match.panes.find((e) => e.instanceId === instanceId);
    if (entry?.pane === internal) return entry;
  }
  return match.panes.find((e) => e.pane === internal) ?? null;
}

export function useCurrentPane(): PaneInternal | null {
  const match = useMatchOrThrow();
  const instanceId = useContext(PaneInstanceContext);
  if (!match || instanceId === undefined) return null;
  return match.panes.find((e) => e.instanceId === instanceId)?.pane ?? null;
}

// ---------------------------------------------------------------------------
// App-scoped basePath. The active app's path (e.g. "/debug") is an implicit
// URL prefix: navigate() prepends it, MillerColumns strips it before matching.
// Pane segments stay app-local — no manual prefix needed.
// ---------------------------------------------------------------------------

export const PaneBasePathContext = createContext<string>("");

// `setBasePath` / `peekBasePath` are the imperative delegations to the live
// store (declared above near the other imperative free functions). The per-
// store base path now lives inside each `PaneStore`; only these helpers stay
// module-level because they are pure (no per-store state) and shared.

/** Normalize an app path to the store's base-path shape ("/" → ""). */
function normalizeAppPath(path: string): string {
  return path === "/" ? "" : path.replace(/\/+$/, "");
}

/**
 * THE sanctioned read of the browser's route path — `window.location.pathname`
 * canonicalized by {@link normalizeRoutePath} (repeated `/` runs collapsed,
 * exactly one leading `/`). Every routing consumer — app matching, base-path
 * stripping, URL→route parsing, and the URL a history entry projects — goes
 * through this, so a hand-typed `//agents/c/x` can neither throw a SecurityError
 * on `replaceState` (scheme-relative resolution) nor silently match no app.
 *
 * Enforced by `lint/no-raw-location-path`: this is the only place in the repo
 * that reads `location.pathname` directly.
 */
export function currentRoutePath(): string {
  // eslint-disable-next-line pane/no-raw-location-path -- THE sanctioned reader
  return normalizeRoutePath(window.location.pathname);
}

export function stripBasePath(pathname: string, basePath: string): string {
  const bp = basePath === "/" ? "" : basePath.replace(/\/+$/, "");
  if (!bp) return pathname;
  if (pathname === bp) return "/";
  if (pathname.startsWith(bp + "/")) return pathname.slice(bp.length);
  return pathname;
}

// The single `popstate` listener is wired once at module load (near
// `setLiveStore` above) and delegates to the installed history adapter's
// `restore()`. `usePathname` below keeps its OWN `popstate` + `shell:navigate`
// subscription — it only needs to re-read `window.location.pathname` on any
// navigation, programmatic or browser-driven, and never drives the store.

// ---------------------------------------------------------------------------
// Navigation + location hook.
// ---------------------------------------------------------------------------

export function usePathname(): string {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("popstate", cb);
      window.addEventListener("shell:navigate", cb);
      return () => {
        window.removeEventListener("popstate", cb);
        window.removeEventListener("shell:navigate", cb);
      };
    },
    currentRoutePath,
    () => "/",
  );
}

// ---------------------------------------------------------------------------
// PaneObject — the value returned by `Pane.define`.
// ---------------------------------------------------------------------------

/**
 * Typed handle returned by `Pane.define`.
 *
 * `FullParams` is the full resolved param set including ancestors — used for
 * `open()`. `OwnParams` is only the `:name`s declared in this pane's own
 * `segment` — what `useParams()` returns. Keeping them separate matches
 * design decision 6 ("params are own-only").
 */
export interface PaneToggleOpts<
  Options extends object = NoOptions,
  HintT extends object = NoHint,
> {
  action?: "close" | "unwrap";
  side?: "left" | "right";
  mode?: PaneOpenMode;
  /** Opener-supplied subset of the pane's declared `options` defaults. */
  options?: Partial<Options>;
  /** Optimistic display mirror. Ephemeral — see {@link Hint}. */
  hint?: HintT;
}

export interface PaneRouteEntry<OwnParams = Record<string, string>> {
  instanceId: number;
  uuid: string;
  params: OwnParams;
  fullParams: Record<string, string>;
  /** The pane's option defaults merged under the opener's partial. Total. */
  options: PaneOptions;
}

/**
 * What Expand will do, not just how to do it. The two destinations
 * `usePromote()` decides between (see the hook for why) are different enough
 * that the chrome around the button needs to tell them apart: a cross-app
 * hand-off can name where it is sending you ("Open in Pages"), a re-root
 * cannot. A bare callback erased that, so the destination travels with `open`.
 *
 * Both arms are a link's two halves — `open()` for a plain click, `href()` for
 * the URL a ⌘/middle-click opens in a browser tab — so the button spreads
 * `linkProps(promote)` and the two cannot name different destinations.
 */
export type PromoteAction =
  /** Hand off to another app — this pane is being hosted away from home. */
  | ({ kind: "cross-app"; app: AppRef } & LinkTarget)
  /** Re-root here: drop the ancestors, stay in the app already hosting us. */
  | ({ kind: "re-root" } & LinkTarget);

export interface PaneObject<
  FullParams = {},
  OwnParams = FullParams,
  Options extends object = NoOptions,
  HintT extends object = NoHint,
> {
  id: string;
  useParams: Hook<() => OwnParams>;
  /**
   * Read this pane's options: the opener-supplied partial merged under the
   * defaults declared in `Pane.define({ options })`. TOTAL — never `Partial`.
   * A rebuilt route (deep link, reload) simply yields the defaults, so the
   * deep-link value lives at the pane definition and no read site needs a `??`.
   */
  useOptions: Hook<() => Options>;
  /**
   * Read this pane's optimistic {@link Hint} — an opener-supplied mirror of
   * server-owned state, absent on any rebuilt route. The returned object holds
   * no data: `pick(key, canonical)` is the only accessor, and it requires the
   * canonical value, so a hint can never be observed apart from its source of
   * truth and can never become one.
   */
  useHint: Hook<() => Hint<HintT>>;
  /** Find this pane in the current route. Returns its params or null if absent. */
  useRouteEntry: Hook<() => PaneRouteEntry<OwnParams> | null>;
  /** Find all instances of this pane in the current route (for panes that can appear multiple times). */
  useRouteEntries: Hook<() => PaneRouteEntry<OwnParams>[]>;
  /**
   * The instance of this pane that the CALLING surface opened: the first entry
   * for this pane sitting AFTER the caller's own pane in the route chain, or
   * `null` when the caller has none open.
   *
   * This is the question a surface listing things it can open actually asks —
   * "which of these is the one I opened?" — and it is the one a pane that can
   * appear more than once (`conversationPane`) cannot answer from
   * {@link useRouteEntries} alone. Every consumer that tried invented a
   * heuristic instead, and each was wrong in its own direction: "the last entry,
   * but only if there are two" goes blind whenever the surface's own pane was
   * not itself opened from one, and "the last entry" walks off to a grandchild
   * the moment the column this surface opened opens another beside it.
   *
   * A caller inside a surface but outside any pane instance (a sidebar) has no
   * position, so the whole chain counts as after it and it reads the first
   * entry.
   *
   * Unlike every other route read, this one is legal OUTSIDE every surface
   * (global chrome — the action bar and its popovers), where it returns
   * `null`: it is the read half of {@link useOpenPane}, which is legal there,
   * and a caller with no route cannot have opened anything in it. Throwing
   * instead made every opener widget (a `conv-<id>` chip) crash the moment it
   * was rendered in the Improve popover.
   */
  useOpenedHere: Hook<() => PaneRouteEntry<OwnParams> | null>;
  close(instanceId: number): void;
  /** Remove this pane from the route while preserving its children. */
  unwrap(instanceId: number): void;
  /** Detach from ancestors and make this pane the root of a fresh route. */
  promote(instanceId: number): void;
  /** Hook: returns a bound close function for the current instance, or null if root/not in route. */
  useClose: Hook<() => (() => void) | null>;
  /**
   * Hook: "go up to my parent", for a layout that paints this pane alone
   * (full-pane). It is {@link useClose} while a parent slot sits to the left in
   * the route; otherwise — a deep link parses to the pane alone, since an index
   * parent's empty segment leaves nothing in the URL — it opens the pane's
   * DECLARED parent route afresh. Null when there is no parent to go to, or the
   * parent needs a param this route does not carry.
   */
  useBack: Hook<() => (() => void) | null>;
  /**
   * Hook: returns the bound {@link PromoteAction} for the current instance, or
   * null when there is nowhere to promote to (this pane is already the root of
   * its own app's route, or it is not in the route at all). Pass
   * `{ newTab: true }` to `run` to land a cross-app promote in a new tab.
   */
  usePromote: Hook<() => PromoteAction | null>;
  /**
   * Hook: rewrite THIS instance's own params in place — its URL changes, the
   * instance does not. Same column, same React instance (no remount), same
   * options and panes to its right; a history entry per `chrome.history`, like
   * any other navigation.
   *
   * For state that is a VIEW of the entity the pane already shows (which tab,
   * which stage), carried in an optional `:name?` so the bare URL stays valid.
   * Showing a different entity is a navigation — `openPane(…, { mode: "swap" })`,
   * which mints a fresh instance so nothing of the old entity leaks across.
   * Throws when called from outside a pane instance.
   */
  useSetParams: Hook<() => (params: OwnParams) => void>;
  /** Hook: toggle this pane open/closed relative to the caller's position in the route. */
  useToggle: Hook<
    (
      params: FullParams,
      opts?: PaneToggleOpts<Options, HintT>,
    ) => { isOpen: boolean; toggle: () => void }
  >;
  back(): void;
  forward(): void;
  /**
   * Build a full app-rooted link to this pane (e.g. "/agents/build/r/<id>").
   * Every pane has one: identity comes from a `RouteDef`, which is what knows
   * the app-relative path. Delegates to {@link RouteDef.link}.
   */
  link: (app: AppRef, params: FullParams) => string;
  Actions: PaneHeaderSlot;
  /** Internal. Consumers should not rely on this. */
  _internal: PaneInternal;
}

/**
 * "Some pane, whichever" — the type for positions that hold a pane without
 * caring about its params / options / hint (the `Pane.Register` slot, chrome
 * props, layout hosts). Spelled once so that adding a generic to `PaneObject`
 * never silently narrows a consumer through the strict `NoOptions`/`NoHint`
 * defaults.
 */
export type AnyPane = PaneObject<any, any, any, any>;

/**
 * The app-rooted URL for a pane's cross-app hand-off, or `null` when there is
 * none to build.
 *
 * A pane's URL needs every ancestor's params, not just its own — the same walk
 * `store.promote` does. But the route it currently sits in need not contain
 * those ancestors: a pane whose parent route is paramful can be opened from
 * anywhere, and then nothing supplies the parent's `:param`. `fillSegment`
 * fails loud on that, which is right for a URL build — except that this one
 * runs inside a `useMemo` DURING RENDER, where a throw takes the whole surface
 * to its error boundary over what is merely "this pane cannot be linked from
 * here".
 *
 * So exactly that failure, and only it, becomes the ABSENCE of a cross-app
 * destination — joining the one other thing that sends a pane down the same-app
 * branch (no installed navigator). Every other error still propagates, which is
 * why the miss is a class to narrow on rather than a message to match.
 */
function crossAppUrl(
  route: RouteDef<any, any>,
  home: AppRef,
  slots: PaneSlot[],
  idx: number,
): string | null {
  const params: Record<string, string> = {};
  for (let i = 0; i <= idx; i++) Object.assign(params, slots[i]!.params);
  try {
    return route.link(home, params);
  } catch (err) {
    if (err instanceof MissingRouteParamError) return null;
    throw err;
  }
}

function makePaneObject(
  internal: PaneInternal,
  route: RouteDef<any, any>,
): AnyPane {
  const { actionsSlot } = internal;

  function useParams(): Record<string, string> {
    const match = useMatchOrThrow();
    const instanceId = useContext(PaneInstanceContext);
    if (!match) {
      throw new Error(
        `Pane "${internal.id}".useParams() called with no resolved route in this surface.`,
      );
    }
    if (instanceId !== undefined) {
      const entry = match.panes.find((e) => e.instanceId === instanceId);
      if (entry?.pane === internal) return entry.params;
    }
    const entry = match.panes.find((e) => e.pane === internal);
    if (!entry) {
      throw new Error(
        `Pane "${internal.id}".useParams() called but pane is not in the current match route.`,
      );
    }
    return entry.params;
  }

  function useOwnEntry(): MatchEntry | null {
    return usePaneEntry(internal);
  }

  function useOptions(): PaneOptions {
    const entry = useOwnEntry();
    // Outside the match (a pane rendered off-route), the defaults ARE the answer
    // — the same total set a deep link would produce.
    return entry?.options ?? internal.optionDefaults;
  }

  function useHint(): Hint<Record<string, unknown>> {
    const bag = useOwnEntry()?.hint;
    return useMemo(() => (bag ? makeHint(bag) : EMPTY_HINT), [bag]);
  }

  function toRouteEntry(entry: MatchEntry): PaneRouteEntry {
    return {
      instanceId: entry.instanceId,
      uuid: entry.uuid,
      params: entry.params,
      fullParams: entry.fullParams,
      options: entry.options,
    };
  }

  function useRouteEntry(): PaneRouteEntry | null {
    const match = useMatchOrThrow();
    if (!match) return null;
    const entry = match.panes.find((e) => e.pane === internal);
    return entry ? toRouteEntry(entry) : null;
  }

  function useRouteEntries(): PaneRouteEntry[] {
    const match = useMatchOrThrow();
    if (!match) return [];
    return match.panes.filter((e) => e.pane === internal).map(toRouteEntry);
  }

  function useOpenedHere(): PaneRouteEntry | null {
    // Deliberately NOT `useMatchOrThrow()`: this is the read twin of
    // `useOpenPane`, which is legal outside every surface, so an opener widget
    // is one component whether it lands in a pane or in a popover off the
    // action bar. There it has no route and no position — its opens are
    // caller-less pushes into whichever tab is focused at click time — so
    // nothing it opened is "here": `null` is the true answer, not a stand-in.
    const match = useContext(PaneMatchContext);
    const selfInstanceId = useContext(PaneInstanceContext);
    if (!match) return null;
    // Where the caller sits in the chain. `-1` — no pane instance around us, or
    // one that is somehow not in the match — reads the whole chain as "after
    // me", which is the right answer for chrome rendered outside every pane.
    const selfIndex =
      selfInstanceId === undefined
        ? -1
        : match.panes.findIndex((e) => e.instanceId === selfInstanceId);
    const entry = match.panes
      .slice(selfIndex + 1)
      .find((e) => e.pane === internal);
    return entry ? toRouteEntry(entry) : null;
  }

  // Imperative methods on the PaneObject target the live store (the focused
  // tab's route), matching the historical module-global behavior for external
  // imperative callers (e.g. `conversationPane.close(instanceId)`).
  function close(instanceId: number): void {
    liveStoreSink.peek().close(internal, instanceId);
  }

  function unwrap(instanceId: number): void {
    liveStoreSink.peek().unwrap(instanceId);
  }

  function promote(instanceId: number): void {
    liveStoreSink.peek().promote(internal, instanceId);
  }

  function back(): void {
    if (typeof window !== "undefined") window.history.back();
  }

  function forward(): void {
    if (typeof window !== "undefined") window.history.forward();
  }

  // Hooks read/write the *context* store — the surface they are rendered in.
  function useClose(): (() => void) | null {
    const store = usePaneStore();
    const instanceId = useContext(PaneInstanceContext);
    const route = useRouteSlots();
    return useMemo(() => {
      if (instanceId === undefined) return null;
      const idx = route.findIndex((s) => s.instanceId === instanceId);
      if (idx <= 0) return null;
      return () => store.close(internal, instanceId);
    }, [store, instanceId, route]);
  }

  function useBack(): (() => void) | null {
    const close = useClose();
    const store = usePaneStore();
    const instanceId = useContext(PaneInstanceContext);
    const route = useRouteSlots();
    return useMemo(() => {
      if (close) return close;
      if (instanceId === undefined) return null;
      const idx = route.findIndex((s) => s.instanceId === instanceId);
      if (idx !== 0) return null;
      const parentId = internal.parentPaneIds.at(-1);
      const parent =
        parentId === undefined ? undefined : registry.get(parentId);
      if (!parent) return null;
      // At the root of the route, this slot's params are everything the URL
      // carries; a parent needing more cannot be addressed from here.
      const params = route[0]!.params;
      const required = segmentRequiredParamNames(parent.segment);
      if (required.some((name) => !(name in params))) return null;
      return () => store.openPaneImpl(parent, params, { root: true });
    }, [close, store, instanceId, route]);
  }

  /**
   * Promote = "show this pane on its own, in the app it belongs to".
   *
   * Two destinations, decided by where the pane currently IS:
   *
   *  • **Another app is hosting it** (this surface is not the pane's `app`) —
   *    hand its app-rooted URL to the tab manager. This is offered even at
   *    route position 0, because "you are in the wrong app" is itself something
   *    to fix: `/agents/page/X` is a page stranded in the agent manager, with
   *    none of Pages' own surface around it.
   *  • **Its own app is hosting it** — the original behavior: drop the
   *    ancestors and re-root the route here. Only meaningful below the root,
   *    hence the `idx === 0` bail.
   *
   * The home app is mandatory and every pane has a `RouteDef`, so only two
   * things can still send a pane down the same-app branch: a missing navigator
   * (see `app-nav-sink`), and a route whose ancestor params this route does not
   * carry (see {@link crossAppUrl}).
   *
   * Which destination it picked is part of the answer, not an implementation
   * detail: the chrome labels the button from it (see {@link PromoteAction}).
   */
  function usePromote(): PromoteAction | null {
    const store = usePaneStore();
    const instanceId = useContext(PaneInstanceContext);
    const slots = useRouteSlots();
    const surfaceAppId = useSurfaceAppId();
    // Subscribed, not sampled: the navigator is installed in an effect, so a
    // pane that mounted in the same commit as the tab provider would otherwise
    // cache "nowhere to go" for its whole life (the memo below has the sink in
    // no dependency array). `useInstalled()` is the only presence answer the
    // sink offers a render path, for exactly this reason.
    const canNavigate = appNavSink.useInstalled();
    return useMemo(() => {
      if (instanceId === undefined) return null;
      const idx = slots.findIndex((s) => s.instanceId === instanceId);
      if (idx < 0) return null;

      const home = internal.app;
      // Building the URL is part of DECIDING to hand off, not a step after the
      // decision: a pane with no linkable URL from here has no cross-app
      // destination, exactly as one with no installed navigator has none.
      const url =
        home.id !== surfaceAppId && canNavigate
          ? crossAppUrl(route, home, slots, idx)
          : null;
      if (url !== null) {
        return {
          kind: "cross-app",
          app: home,
          open: () => navigateApp(url),
          href: () => url,
        };
      }

      if (idx === 0) return null;
      return {
        kind: "re-root",
        open: () => store.promote(internal, instanceId),
        // At click time, against the route as it is then — the same read
        // `store.promote` makes.
        href: () => {
          const current = store.getRoute();
          const next = computePromote(current, internal, instanceId);
          return store.routeUrl(next ? next.route : current);
        },
      };
    }, [store, instanceId, slots, surfaceAppId, canNavigate]);
  }

  function useSetParams(): (params: Record<string, string>) => void {
    const store = usePaneStore();
    const instanceId = useContext(PaneInstanceContext);
    const set = useCallback(
      (params: Record<string, string>) => {
        if (instanceId !== undefined)
          store.setParams(internal, instanceId, params);
      },
      [store, instanceId],
    );
    if (instanceId === undefined) {
      throw new Error(
        `Pane "${internal.id}".useSetParams() called outside a pane instance — it rewrites ` +
          `the instance it is rendered in, so there must be one.`,
      );
    }
    return set;
  }

  function useToggle(
    params: Record<string, string>,
    opts?: PaneToggleOpts<PaneOptions, PaneHintBag>,
  ): { isOpen: boolean; toggle: () => void } {
    const store = usePaneStore();
    const callerInstanceId = useContext(PaneInstanceContext);
    const route = useRouteSlots();
    const openPaneFn = useOpenPane();
    const paramsRef = useLatestRef(params);

    const action = opts?.action ?? "close";
    const mode = opts?.mode ?? "push";
    const side = opts?.side;
    const optionsRef = useLatestRef(opts?.options);
    const hintRef = useLatestRef(opts?.hint);

    const callerIndex =
      callerInstanceId !== undefined
        ? route.findIndex((s) => s.instanceId === callerInstanceId)
        : -1;
    // Search for the toggle's target on the same side it would be opened.
    // `side: "left"` inserts the pane before the caller (as an ancestor), so
    // look to the left; the default right-push appends after the caller, so
    // look to the right. Mismatching the side makes the open-check miss the
    // existing pane and stack a duplicate on every click.
    const searchRegion =
      side === "left"
        ? callerIndex >= 0
          ? route.slice(0, callerIndex)
          : route
        : route.slice(callerIndex >= 0 ? callerIndex + 1 : 0);
    const targetSlot =
      searchRegion.find((s) => s.paneId === internal.id) ?? null;
    const isOpen = targetSlot !== null;

    const toggle = useCallback(() => {
      if (targetSlot) {
        if (action === "unwrap") {
          store.unwrap(targetSlot.instanceId);
        } else {
          store.close(internal, targetSlot.instanceId);
        }
      } else {
        openPaneFn(paneObject, paramsRef.current, {
          mode,
          side,
          options: optionsRef.current,
          hint: hintRef.current,
        });
      }
    }, [store, targetSlot, action, openPaneFn, mode, side]);

    return { isOpen, toggle };
  }

  const paneObject: AnyPane = {
    id: internal.id,
    useParams,
    useOptions,
    useHint,
    useRouteEntry,
    useRouteEntries,
    useOpenedHere,
    close,
    unwrap,
    promote,
    useClose,
    useBack,
    usePromote,
    useSetParams,
    useToggle,
    back,
    forward,
    link: (app, params) => route.link(app, params),
    Actions: actionsSlot,
    _internal: internal,
  };
  paneObjectByInternal.set(internal, paneObject);
  return paneObject;
}

function normalizeChrome(
  chrome: PaneChromeConfig | undefined,
): NormalizedChrome {
  return {
    history: chrome?.history ?? true,
    close: chrome?.close ?? true,
    promote: chrome?.promote ?? true,
    keepMountedWhenCollapsed: chrome?.keepMountedWhenCollapsed ?? false,
  };
}

// ---------------------------------------------------------------------------
// Pane.define — factory + registration.
// ---------------------------------------------------------------------------

/**
 * Restores the CLOSED empty param set at the `PaneObject` boundary.
 *
 * `RouteParams<"">` is a bare `{}` on purpose (see `core/route.ts`): routes
 * chain their params, and intersecting `Record<string, never>` into a child's
 * real params would collapse every property to `never`. But `{}` is
 * TypeScript's "any non-nullish value", so it accepts an object literal with
 * whatever keys, so a paramless pane would silently take
 * `openPane(p, { foo: "x" })` — a stray key nothing would ever read.
 *
 * So the chain keeps `{}` and only the type a CALLER is checked against gets
 * normalized back to the key-rejecting `Record<string, never>`.
 */
type Closed<P> = keyof P extends never ? Record<string, never> : P;

// The `useResolve` field. A paramful route requires a resolve hook (or an
// explicit `false` opt-out); a paramless route forbids it.
//
// Keyed on the route's OWN params, not its chained ones, because own-only is
// what the hook is actually handed: `PaneBox` passes `entry.params`, which
// `extractOwnParams` filtered to this pane's own segment names.
//
// Only POSITIONAL params count toward "paramful": a keyed `;name` is a view of
// the entity the positional ones address, never an entity to resolve itself —
// a paramless list pane with a keyed `;filter` addresses nothing.
type RouteResolveField<Seg extends string> =
  keyof PositionalRouteParams<Seg> extends never
    ? { useResolve?: never }
    : { useResolve: ResolveHook<OwnRouteParams<Seg>> | false };

// A route's OWN params: what its own `segment` declares, and nothing an
// ancestor contributed. Derived from the `RouteDef`'s segment LITERAL — see the
// note on `RouteDef` for why the own set is not a type parameter of its own.
type OwnRouteParams<Seg extends string> = RouteParams<Seg>;

// The `appIndex` field. An index pane is reached at its app's BARE ROOT, so it
// cannot own a URL segment — and now that the route's `Seg` literal is reliable
// (see the `const Seg` note in `core/route.ts`) that stops being a boot-time
// throw and becomes a tsc error.
//
// The runtime throws in `useSyncPaneRegistry` stay: they still guard the
// untyped `AnyPane` path, and the "one index per app" half of the invariant is
// cross-file, which no type can see.
type AppIndexField<Seg extends string> = Seg extends "" | "/"
  ? {
      /**
       * Marks this pane as its app's index/landing pane — what that app's bare
       * root resolves to. See {@link PaneInternal.appIndex}.
       */
      appIndex?: boolean;
    }
  : { appIndex?: never };

// The arguments to `Pane.define`. Identity (`id` / `segment` / the ancestor
// chain) is derived from the `RouteDef`, so the only authored fields are the
// behavior (`component`, `chrome`, `title`, `options`, `width`, `useResolve`).
//
// Both of the route's param sets flow through (see `RouteDef`): `Params` is the
// CHAINED set every ancestor contributes to, which is what a URL needs and so
// what `title.useText` / `title.fallback` are handed (`fullParams`); the OWN set,
// derived from the route's `Seg` literal, is what the pane is handed back
// (`useParams()`, `useResolve`).
type RouteDefineArgs<
  Params extends Record<string, string>,
  Seg extends string,
  Options extends object,
  HintT extends object,
> = {
  route: RouteDef<Params, Seg>;
  /** The app this pane belongs to (its official home). See {@link PaneInternal.app}. */
  app: AppRef;
  component: ComponentType;
  /**
   * BORROW another pane's header instead of minting one of this pane's own:
   * `pane.Actions` then IS that slot, so several panes wear one header from one
   * contribution list and one config directive (the website's five pages share
   * one nav). Build it with `definePaneHeaderSlot()`, declare it once in the
   * owning plugin's `slots:` record, and leave every borrowing pane out of that
   * record — one slot has exactly one name.
   */
  actions?: PaneHeaderSlot;
  /**
   * Literal DEFAULTS for this pane's opener-supplied UI options. Read via
   * `useOptions()`, which merges the opener's partial over these — so the value
   * a deep link sees is declared here, once, and never re-invented at a read
   * site. Options have no canonical owner: absence genuinely means "the default".
   *
   * If a key's default would be a LIE about server-owned state
   * (`{ title: "Untitled" }`), it is a {@link hint}, not an option.
   */
  options?: Options;
  /**
   * Declares the typed shape of this pane's optimistic {@link Hint} — a mirror
   * of server-owned state, supplied by the opener to pre-paint before the
   * canonical resource settles (runtime no-op, type-level only). Absent on any
   * rebuilt route; never a write source.
   */
  hint?: TypeMarker<HintT>;
  chrome?: PaneChromeConfig;
  /**
   * The pane's title — the ONE source for its tab label, the browser document
   * title and its header's title item. A literal (`title: "Reports"`), or a
   * {@link PaneTitleSpec}: `useText` (a literal or a context-free hook reading a
   * global resource by `params`, the `hint` while it loads), `fallback` (while
   * `useText` yields undefined) and `component` (a rich header title, mounted
   * inside the pane). There is no other way to give a pane header a title.
   */
  title?: PaneTitle<Params, HintT, Options>;
  /**
   * Declares this pane a MAIN SURFACE — the entity the page is about (a
   * conversation, a task, a page), as opposed to navigation lists or auxiliary
   * tool panes. The tab/document title resolves against the FIRST title owner
   * in the route. See {@link PaneInternal.titleOwner}. Defaults to false.
   */
  titleOwner?: boolean;
  /**
   * Declares this pane a COMPANION: at the head of a route it keeps the
   * surface's index pane beside it. See {@link PaneInternal.companion}.
   * Defaults to false.
   */
  companion?: boolean;
  /**
   * Default column width in pixels. Read by layout renderers (e.g. Miller
   * columns). The leaf column ignores this and flex-grows. Defaults to 400.
   */
  width?: number;
} & RouteResolveField<Seg> &
  AppIndexField<Seg>;

// Identity comes from the `RouteDef`, so a pane always carries a `.link`.
//
// The two param slots differ: an opener supplies the CHAINED params (that is
// what a URL is built from), while `useParams()` returns the pane's OWN — the
// same split `MatchEntry` makes between `fullParams` and `params`.
function define<
  Params extends Record<string, string>,
  Seg extends string = string,
  Options extends object = NoOptions,
  HintT extends object = NoHint,
>(
  args: RouteDefineArgs<Params, Seg, Options, HintT>,
): PaneObject<Closed<Params>, Closed<OwnRouteParams<Seg>>, Options, HintT>;
// One overload, so the signature callers see stays generic while the body works
// on the erased shapes (`useResolve` and `appIndex` are conditional fields;
// narrowing them under an unresolved `Seg` is not something the implementation
// should have to do).
//
// `Seg` erases to `""`, not to `string`: `""` is the arm on which BOTH
// conditional fields are at their most permissive (`appIndex?: boolean`,
// `useResolve?: never`), and an implementation signature has to accept every call
// the overload above admits. With `string` the two disagree — `AppIndexField`
// would forbid `appIndex` here while the overload still offers it — and TS
// rejects the pair outright (TS2394).
function define(
  args: RouteDefineArgs<Record<string, string>, "", PaneOptions, PaneHintBag>,
): AnyPane {
  const route: RouteDef<any, any> = args.route;
  const id = route.id;
  const segment = route.segment.replace(/^\/+/, "");

  if (segment && segment.startsWith(":")) {
    throw new Error(
      `Pane "${id}": segment "${segment}" starts with a bare :param. ` +
        `Add a static prefix (e.g. "x/${segment}") to avoid URL parsing ambiguity.`,
    );
  }

  // A real render slot: a pane's header is a visible list whose order the user
  // should own, exactly like any other. (It was a plain `defineSlot` while slot
  // discovery was a source-text scan that could not read a templated id; slots
  // now declare themselves at runtime, so the id no longer has to be spellable
  // in source.)
  //
  // `actions` BORROWS another pane's header instead of minting one: the slot is
  // then declared once, by the plugin that owns it, and every borrowing pane
  // shares its contributions and its one config directive. A borrowing pane is
  // simply absent from its plugin's `slots:` record — declaring it there would
  // name one slot twice, which the declaration pass rejects.
  const actionsSlot = args.actions ?? definePaneHeaderSlot();

  const useResolve = args.useResolve as PaneInternal["useResolve"];

  const internal: PaneInternal = {
    id,
    parentPaneIds: route.parentPaneIds,
    segment,
    appIndex: args.appIndex ?? false,
    app: args.app,
    component: args.component,
    chrome: normalizeChrome(args.chrome),
    width: args.width,
    actionsSlot,
    useResolve,
    title: normalizeTitle(args.title),
    optionDefaults: args.options ?? {},
    titleOwner: args.titleOwner ?? false,
    companion: args.companion ?? false,
  };

  return makePaneObject(internal, route);
}

export const Pane = { define, Register: PaneSlots.Register };

// ---------------------------------------------------------------------------
// Registry sync — populates the module-local `registry` from the
// `Pane.Register` slot. Called once from <MillerColumns/> at the start of
// every render, synchronously via useMemo so parseUrl() and the
// pane.close() event handlers always see fresh state.
// ---------------------------------------------------------------------------

export function useSyncPaneRegistry(): void {
  // Mounted BOTH at the apps root (outside every surface — the registry is a
  // global invariant, see apps-layout) and by each layout renderer inside its
  // surface, so it takes the surface store when there is one and the live store
  // at the root. See {@link useStoreOrLive}.
  const store = useStoreOrLive();
  const contributions = PaneSlots.Register.useContributions();
  useRenderSync(() => {
    registry.clear();
    const seen = new Set<string>();
    // Maps a normalized segment pattern → the paneId that first claimed it, so a
    // second pane whose segment matches the same URLs is caught immediately.
    const patternOwner = new Map<string, string>();
    // Maps an app id → the paneId that claimed its index, so a second index
    // pane for one app is caught here rather than silently losing to whichever
    // one this iteration happens to reach first.
    const indexOwner = new Map<string, string>();
    for (const contribution of contributions) {
      const internal = contribution.pane._internal;
      if (seen.has(internal.id)) {
        console.warn(`Pane "${internal.id}" registered twice.`);
        continue;
      }
      if (internal.appIndex) {
        if (internal.segment && internal.segment !== "/") {
          throw new Error(
            `Pane "${internal.id}" declares appIndex but owns the URL segment "${internal.segment}". ` +
              `An index pane is reached at its app's bare root ("${internal.app.basePath}"), so it ` +
              `cannot have a segment of its own — drop the segment, or drop appIndex and let the ` +
              `app's bare root resolve elsewhere.`,
          );
        }
        const owner = indexOwner.get(internal.app.id);
        if (owner) {
          throw new Error(
            `Pane index collision: "${owner}" and "${internal.id}" both declare appIndex for app ` +
              `"${internal.app.id}". An app has exactly one index pane — the one its bare root ` +
              `("${internal.app.basePath}") resolves to. Drop appIndex from one of them.`,
          );
        }
        indexOwner.set(internal.app.id, internal.id);
      }
      // Index/empty-segment panes resolve via `appIndex`, not URL matching, so
      // multiple empty segments are legal — only check real URL segments.
      if (
        internal.segment &&
        internal.segment !== "/" &&
        internal.segment !== ""
      ) {
        // A segment ending in `:name?` claims two shapes of URL; each is checked.
        for (const pattern of segmentMatchPatterns(internal.segment)) {
          const owner = patternOwner.get(pattern);
          if (owner) {
            throw new Error(
              `Pane segment collision: "${owner}" and "${internal.id}" both match the same URLs ` +
                `("${registry.get(owner)!.segment}" vs "${internal.segment}"). Segments must be ` +
                `globally unique across all registered panes — rename one to disambiguate.`,
            );
          }
          patternOwner.set(pattern, internal.id);
        }
      }
      seen.add(internal.id);
      // The only place the pane's owning plugin is knowable: the loader stamps
      // `_pluginId` on the CONTRIBUTION, and `Pane.define` (a pure factory) has
      // no way to see it. See {@link paneOwnerFor}. A contribution built outside
      // the loader (tests) carries no id — record nothing rather than an owner
      // the caller would have to re-check.
      if (contribution._pluginId) {
        paneOwnerByInternal.set(internal, contribution._pluginId);
      }
      registry.set(internal.id, internal);
    }
    // Re-sync the route from the current URL now that the registry is
    // populated. On initial load the store's handleLocationChange() runs
    // (via the window listener) before any panes are registered, so the
    // route stays empty until this re-sync.
    store.handleLocationChange();
  }, [contributions]);
}

// ---------------------------------------------------------------------------
// Memoized resolved-route match, consumed by every layout renderer.
// ---------------------------------------------------------------------------

export function useRoute(): PaneMatch | null {
  const store = usePaneStore();
  const route = useRouteSlots();
  // `resolveRoute` is a pure function of BOTH the route slots AND the pane
  // registry, so the memo must invalidate when either changes. Tracking only
  // `route` leaves a resolved route whose panes register in a LATER deferred
  // batch stuck as null: the registry fills, but `syncRouteFromUrl` short-circuits
  // on `routesEqual` (same slots) so the route array identity never changes and
  // the memo never re-runs. Depending on the `Pane.Register` contributions
  // identity (which tracks the registry, same as `useIndexMatch`) re-resolves the
  // instant the target pane's plugin loads — e.g. an instant-restored deep link.
  const contributions = PaneSlots.Register.useContributions();
  /* eslint-disable react-hooks/exhaustive-deps -- `contributions` identity tracks the module-level registry Map read inside resolveRoute; it is the registry-version signal, not an unused dep. Block form, not next-line: this call is long enough for the formatter to reflow, which would carry a positional directive off it. */
  return useMemo(
    () => store.resolveRoute(route),
    [store, route, contributions],
  );
  /* eslint-enable react-hooks/exhaustive-deps */
}

/**
 * Resolve a pane's human-readable title — the tab label, the browser document
 * title, and the header title of a pane with no `title.component`. Calls the
 * pane's self-contained `title.useText` hook (data-backed: a conversation tab shows
 * the conversation name, not its id); when that yields nothing, falls back to
 * `title.fallback`; else `undefined`.
 *
 * Because `title.useText` is a hook that varies per pane, callers MUST invoke this
 * from a component keyed by the pane's id, so switching panes remounts and the
 * hook order stays stable across the component's life.
 */
export function usePaneTitle(
  pane: PaneInternal,
  params: Record<string, string>,
  hint: PaneHintBag,
  options: PaneOptions,
): string | undefined {
  const hintApi = useMemo(() => makeHint(hint), [hint]);
  const dynamic = pane.title.useText(params, hintApi, options);
  if (dynamic) return dynamic;
  const fallback = pane.title.fallback;
  return typeof fallback === "function" ? fallback(params) : fallback;
}

// ---------------------------------------------------------------------------
// Index/landing pane resolution. Separate from the opened route: the route is
// purely URL-derived (empty at a bare app root), while the index pane is a
// main-area concern resolved here and rendered only by the main-area renderer
// (MillerColumns). Overlay hosts ignore it, so a bare root means "no overlay".
// ---------------------------------------------------------------------------

// Stable instanceId per index pane id, so the index pane keeps the same React
// key/identity across renders (no remount). Distinct from route slot ids.
const indexInstanceIds = new Map<string, number>();
function indexInstanceIdFor(paneId: string): number {
  let id = indexInstanceIds.get(paneId);
  if (id === undefined) {
    id = nextInstanceId++;
    indexInstanceIds.set(paneId, id);
  }
  return id;
}

/**
 * Resolve the index/landing pane for the given app basePath into a stable
 * single-entry match, or null when the app declares no index pane.
 *
 * The pane's side of the comparison is its OWN app's basePath — a pane names no
 * path, so it cannot claim an app it does not belong to. The surface's side is
 * `app.basePath` off the `AppRef` the `Apps.App` contribution takes whole,
 * restating none of it; so both sides trace back to one `defineApp`.
 *
 * Recomputes only when the basePath or the registered pane set changes, so the
 * returned match identity is stable and the index pane never remounts.
 */
export function useIndexMatch(basePath: string): PaneMatch | null {
  const contributions = PaneSlots.Register.useContributions();
  return useMemo(() => {
    const bp = normalizeAppPath(basePath);
    for (const pane of registry.values()) {
      // Segment-less and unique per app — both enforced at registry sync, so
      // there is nothing left to defend against on this hot path.
      if (!pane.appIndex) continue;
      if (normalizeAppPath(pane.app.basePath) !== bp) continue;
      const entry: MatchEntry = {
        instanceId: indexInstanceIdFor(pane.id),
        uuid: `index:${pane.id}`,
        pane,
        params: {},
        fullParams: {},
        options: { ...pane.optionDefaults },
        hint: {},
      };
      return { panes: [entry] };
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `contributions` identity tracks the registry; registry itself is a module-level mutable Map read inside.
  }, [basePath, contributions]);
}

/**
 * Shared renderer preamble. Every layout renderer (Miller columns, full-pane,
 * …) repeats the same sequence to turn the active app's basePath into a route
 * match: set the base path (synchronous side-effect), sync the registry, then
 * return the URL-derived route match or fall back to the index pane. Exposing
 * it here keeps renderers thin and stops them copy-pasting this hook order
 * (which must stay stable). Mirrors MillerColumns exactly.
 */
export function usePaneRoute(basePath: string): PaneMatch | null {
  const store = usePaneStore();
  useRenderSync(() => {
    store.setBasePath(basePath);
  }, [store, basePath]);
  useSyncPaneRegistry();
  const route = useRoute();
  const state = useRouteState();
  const index = useIndexMatch(basePath);
  // A companion at the route's head keeps the landing pane to its left (see
  // `PaneInternal.companion`). Memoized so the match identity only changes
  // when the route or the index does.
  const withIndex = useMemo(
    () =>
      route && index && route.panes[0]?.pane.companion
        ? { panes: [...index.panes, ...route.panes] }
        : route,
    [route, index],
  );

  // A resolved route whose slots all match registered panes → render it.
  if (withIndex) return withIndex;
  // The ONLY case that renders the index/landing pane is a GENUINE bare app root:
  // a resolved route with zero slots. Everything else — an unresolved (pending /
  // not-found) URL, or a resolved route whose slots don't resolve yet (a deferred
  // plugin still loading, or stale paneIds from an old bundle) — returns null so
  // the layout renders its tri-state DeferredRouteFallback (spinner while
  // loading, then NotFound / app-load-error), never the homepage at a deep link.
  if (state.kind === "resolved" && state.slots.length === 0) return index;
  return null;
}

// ---------------------------------------------------------------------------
// openPane — imperative (non-hook) open. Targets the live store, matching the
// historical module-global behavior for the ~40 imperative call sites.
// The non-positional open logic itself lives on the store (`openPaneImpl`).
// ---------------------------------------------------------------------------

/**
 * `root` starts a fresh route at the target; `push` / `swap` are relative to
 * the caller pane; `append` puts the target after the route's last pane
 * whoever the caller is (replacing a last pane of the same kind) — see
 * {@link computeOpen}.
 */
export type PaneOpenMode = "root" | "push" | "swap" | "append";

export function openPane<
  Params = Record<string, string>,
  Options extends object = NoOptions,
  HintT extends object = NoHint,
>(
  target: PaneObject<Params, any, Options, HintT>,
  params: NoInfer<Params>,
  opts: { mode: "root"; options?: Partial<Options>; hint?: HintT },
): void {
  liveStoreSink
    .peek()
    .openPaneImpl(target._internal, params as Record<string, string>, {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- overload narrows mode to "root" but the check keeps this future-proof for additional modes
      root: opts.mode === "root",
      options: opts.options as PaneOptions | undefined,
      hint: opts.hint as PaneHintBag | undefined,
    });
}

// ---------------------------------------------------------------------------
// useOpenPane — caller-aware pane navigation hook. Operates on the surface it
// is rendered in, falling back to the focused tab when there is no surface.
//
// Opening a pane is a NON-REACTIVE IMPERATIVE OP: the hook returns a callback
// and reads nothing from the route during render. That is exactly the shape
// {@link useStoreOrLive} exists for, so this hook is legal everywhere —
// including global chrome (the action bar and every popover it opens), which
// has no `PaneSurfaceProvider` of its own and targets the focused tab's store.
//
// It used to take the reactive `usePaneStore()` and therefore THROW in global
// chrome. That was a trap rather than a guard: a component is not written twice
// (once for a pane, once for a popover), so any control reusable enough to
// appear in both — a config gear, an active-data chip — crashed the moment
// someone dropped it into the Improve popover, at render, with the failure
// surfacing as whatever fallback happened to be nearest (for a Lexical editor,
// a nameless "An error was thrown." box). Two consumers had already hand-rolled
// their own `navigate()` workaround around it. Anything that must RE-RENDER on
// route changes still has to be inside a surface — that read is `usePaneStore`
// / `useRoute`, and those still throw.
// ---------------------------------------------------------------------------

/**
 * The caller-aware open function returned by {@link useOpenPane}. Generic on the
 * target pane's declared `Params`, `Options`, and `Hint`, so all three are
 * type-checked against the pane that owns them at the call site. `params` is
 * checked against the target pane's full param set (not coerced to
 * `Record<string, string>`): a paramless pane rejects stray keys and a paramful
 * pane requires its declared params. Likewise a pane declaring no `options` /
 * no `hint` rejects them outright.
 */
export interface OpenPaneFn {
  <
    Params = Record<string, string>,
    Options extends object = NoOptions,
    HintT extends object = NoHint,
  >(
    target: PaneObject<Params, any, Options, HintT>,
    params: NoInfer<Params>,
    opts: OpenPaneOpts<Options, HintT>,
  ): void;
  /**
   * The same open as a LINK: spread the result onto the control that opens it.
   * Same arguments as the call. Plain click opens exactly as the call does;
   * ⌘/Ctrl- and middle-click open the URL of the route that plain click would
   * produce in a new browser tab — computed at click time, against the route
   * on screen then — and leave this tab where it is.
   *
   * ```tsx
   * <Button {...openPane.link(traceDetailPane, { id }, { mode: "push" })}>Open trace</Button>
   * ```
   *
   * Use the call itself only where there is no control to spread onto (an
   * `onSelect` callback, an open after a mutation settles).
   */
  link<
    Params = Record<string, string>,
    Options extends object = NoOptions,
    HintT extends object = NoHint,
  >(
    target: PaneObject<Params, any, Options, HintT>,
    params: NoInfer<Params>,
    opts: OpenPaneOpts<Options, HintT>,
  ): LinkGestureProps;
  /**
   * The same open as DATA — the {@link LinkTarget} `link` spreads: `open()` is
   * the call, `href()` the URL its ⌘/middle-click opens. For a surface that
   * activates things without a mouse event as well (a DataView row's Enter, a
   * tree's activation of a row it just created), so it cannot be handed event
   * handlers:
   *
   * ```tsx
   * <DataView rowActivation={(r) => openPane.to(traceDetailPane, { id: r.id }, { mode: "push" })} />
   * ```
   */
  to<
    Params = Record<string, string>,
    Options extends object = NoOptions,
    HintT extends object = NoHint,
  >(
    target: PaneObject<Params, any, Options, HintT>,
    params: NoInfer<Params>,
    opts: OpenPaneOpts<Options, HintT>,
  ): LinkTarget;
}

/** The `opts` of an {@link OpenPaneFn} open, typed against the target pane. */
export interface OpenPaneOpts<Options extends object, HintT extends object> {
  mode: PaneOpenMode;
  side?: "left" | "right";
  options?: Partial<Options>;
  hint?: HintT;
}

export function useOpenPane(): OpenPaneFn {
  const resolveStore = useStoreResolver();
  const callerInstanceId = useContext(PaneInstanceContext);

  return useMemo(() => {
    // The store is resolved per click, never at render: global chrome outlives
    // the tab it was rendered beside (see the section comment above).
    const compute = (
      store: PaneStore,
      target: AnyPane,
      params: Record<string, string>,
      opts: OpenRequest,
    ) =>
      computeOpen(
        store.getRoute(),
        callerInstanceId,
        target._internal,
        params,
        opts,
      );
    const open = (
      target: AnyPane,
      params: Record<string, string>,
      opts: OpenRequest,
    ): void => {
      const store = resolveStore();
      const next = compute(store, target, params, opts);
      if (next.changed) store.setRoute(next.route, next.replace);
    };
    const to = (
      target: AnyPane,
      params: Record<string, string>,
      opts: OpenRequest,
    ): LinkTarget => ({
      open: () => open(target, params, opts),
      // Unchanged ⇒ the destination is already on screen, and the current
      // route's URL is exactly it.
      href: () => {
        const store = resolveStore();
        return store.routeUrl(compute(store, target, params, opts).route);
      },
    });
    const link = (
      target: AnyPane,
      params: Record<string, string>,
      opts: OpenRequest,
    ): LinkGestureProps => linkProps(to(target, params, opts));
    return Object.assign(open, { link, to }) as OpenPaneFn;
  }, [resolveStore, callerInstanceId]);
}
