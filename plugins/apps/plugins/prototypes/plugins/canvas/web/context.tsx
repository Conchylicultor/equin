import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  useOptimisticResource,
  type OptimisticSettled,
} from "@plugins/primitives/plugins/optimistic-mutation/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import {
  legacyDraftKeys,
  readDraft,
  writeDraft,
} from "@plugins/primitives/plugins/persistent-draft/web";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { isEmbeddedDocument } from "@plugins/primitives/plugins/embed/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import {
  prototypeDetailRoute,
  prototypesApp,
} from "@plugins/apps/plugins/prototypes/plugins/shell/core";
import {
  applyPicksChange,
  DEFAULT_PROTOTYPE_VIEWPORT,
  prototypesList,
  prototypePicks,
  prototypeUrl,
  prototypeVersionUrl,
  pickedColor,
  resolvePicks,
  setPrototypePicks,
  type OptionPicks,
  type PicksChange,
  type PrototypeMeta,
  type PrototypeOption,
  type PrototypeVersion,
  type PrototypeViewport,
  type StoredPicks,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import {
  canvasReducer,
  initialCanvasState,
  isTransientAction,
  picksOf,
  previewedValue,
  type CanvasAction,
  type CanvasEffect,
  type CanvasState,
  type FrameId,
  type PrototypeFrame,
} from "./internal/canvas-model";
import {
  restoreCanvas,
  SavedCanvasSchema,
  serializeCanvas,
} from "./internal/saved-canvas";
import { FrameSource, PrototypeDetailWrap } from "./slots";

/** A frame source as the header lists it. */
export interface CanvasSourceEntry {
  id: string;
  addLabel: string;
}

/**
 * Where a remembered canvas is saved: this browser TAB's sessionStorage, one
 * entry per pane instance and prototype. A reload reopens it; closing the tab
 * throws it away — a comparison is a throwaway, never carried to a new session.
 * Held for as long as the tab lives, however long that is.
 */
const savedCanvasStore = defineStore({
  owner: "prototypes.canvas",
  label: "Prototype canvases",
  area: "session",
  cap: "1 MB",
  ttl: Number.POSITIVE_INFINITY,
  whenFull: "evict-oldest",
  schema: SavedCanvasSchema,
  legacy: legacyDraftKeys("prototypes.canvas"),
});

/**
 * A canvas handed to the NEXT detail pane this browser tab opens on a
 * prototype, keyed by prototype ({@link openCanvasInApp}). Taken once: the pane
 * that takes it saves it as its own. Short-lived, so a hand-off whose
 * navigation never happened is not picked up by a later visit.
 */
const handedCanvasStore = defineStore({
  owner: "prototypes.canvas-handoff",
  label: "Prototype canvas hand-offs",
  area: "session",
  cap: "64 KB",
  ttl: 60_000,
  whenFull: "evict-oldest",
  schema: SavedCanvasSchema,
});

/**
 * Opens the prototype's canvas in the full app ON `state` — a document load
 * of `proto/<name>` in this browser tab, whose new pane opens on `state`
 * instead of frame A alone. The URL names only the prototype, so the canvas
 * goes through this tab's sessionStorage, which survives the load. For a
 * chromeless page (Present's new-tab page), which cannot navigate in-app.
 */
export function openCanvasInApp(name: string, state: CanvasState): void {
  const written = handedCanvasStore.write(name, serializeCanvas(state));
  if (!written.ok) {
    throw new Error(`Could not hand the canvas over: ${written.reason}`);
  }
  window.location.assign(prototypeDetailRoute.link(prototypesApp, { name }));
}

/**
 * The canvas handed over for `name`, taken: saved under `slot` straight away,
 * so a second read of the same open (StrictMode runs initializers twice) finds
 * it there.
 */
function takeHandedCanvas(slot: string, name: string): CanvasState | null {
  const handed = handedCanvasStore.read(name);
  if (handed.kind === "none") return null;
  handedCanvasStore.remove(name);
  const restored = restoreCanvas(handed.value);
  if (restored.kind === "rejected") {
    console.warn(`Handed canvas for ${name} not opened: ${restored.reason}`);
    return null;
  }
  writeDraft(savedCanvasStore, serializeCanvas(restored.state), {
    scope: slot,
  });
  return restored.state;
}

/**
 * The canvas saved under `slot` in this tab, else one handed over for `name`,
 * else a fresh one at `size` — the size the prototype declares.
 */
function openCanvas(
  slot: string,
  name: string,
  size: PrototypeViewport,
): CanvasState {
  const raw = readDraft(savedCanvasStore, { scope: slot });
  if (raw === null) {
    return takeHandedCanvas(slot, name) ?? initialCanvasState({ size });
  }
  const restored = restoreCanvas(raw);
  if (restored.kind === "restored") return restored.state;
  // Written by an older shape of the canvas: open fresh, and say why.
  console.warn(`Saved canvas ${slot} not reopened: ${restored.reason}`);
  return initialCanvasState({ size });
}

export interface PrototypeDetailContextValue {
  /** The directory slug of the prototype this pane is showing. */
  name: string;
  /**
   * The prototype's ONE shared picks record (`prototypes.picks`), with this
   * pane's own not-yet-confirmed changes applied. Frame A shows it. Unjudged —
   * read a frame's picks through {@link useFramePicks}. Always known: the
   * provider renders nothing of the canvas until the record has loaded.
   */
  shared: StoredPicks;
  /** The canvas: frames, selection, size, zoom, layout. */
  canvas: CanvasState;
  /** The one way the canvas changes. */
  dispatch: (action: CanvasAction) => void;
  /** Close every frame but `id`, with an Undo toast. */
  keepOnly: (id: FrameId) => void;
  /** Every contributed frame source, in registration order. */
  sources: readonly CanvasSourceEntry[];
}

/** The canvas as the provider holds it: for one prototype, in one saved slot. */
interface Held {
  name: string;
  /** Where it is saved (`<pane instance>:<prototype>`), or `null` when it is not. */
  slot: string | null;
  state: CanvasState;
}
const PrototypeDetailContext =
  createContext<PrototypeDetailContextValue | null>(null);

/**
 * The canvas state and the shared picks, for everything inside the detail pane
 * (its header actions included — the provider wraps `PaneChrome`) and for any
 * surface that mounts its own provider (Present's new-tab page).
 */
export function usePrototypeDetail(): PrototypeDetailContextValue {
  const ctx = useContext(PrototypeDetailContext);
  if (!ctx) {
    throw new Error(
      "usePrototypeDetail must be used within a PrototypeDetailProvider",
    );
  }
  return ctx;
}

interface PrototypeDetailProviderProps {
  name: string;
  /**
   * The pane instance to remember the canvas for (the pane's route-entry
   * `uuid`, which a reload restores): every change is saved under it in this
   * browser tab, and a reload reopens it. A new pane instance — another app tab,
   * another browser tab, a new visit — starts fresh at frame A. Omitted by a
   * surface that shows one given frame (Present's new-tab page), and ignored
   * inside an embedded document, so a framed copy of the app never writes.
   */
  remember?: string;
  /** The version frame A opens on — `null` (the default) for the live folder. Not with `remember`. */
  initialVersion?: PrototypeVersion | null;
  /**
   * Picks of frame A's OWN, instead of the shared record — for a surface that
   * shows one frame someone else had given local picks (Present's new-tab page).
   * Not with `remember`.
   */
  initialPicks?: StoredPicks;
  /**
   * The size the canvas opens at, instead of the one the prototype declares —
   * for a surface asked to show the frame at a given size (Present's
   * "Responsive, in a new browser tab"). Not with `remember`.
   */
  initialSize?: PrototypeViewport;
  children: ReactNode;
}

/**
 * The canvas for one prototype. A fresh canvas opens at the size the prototype
 * declares (`<meta name="prototype-viewport">`), and every frame shows the
 * user's picks, so the provider waits for both the prototype list and the
 * shared picks record before the canvas exists at all — a canvas at a stand-in
 * size, or a frame on the default variant, would be a claim that reverses
 * itself. A prototype the list does not have opens at the default size (the
 * pane then says "not found").
 */
export function PrototypeDetailProvider(
  props: PrototypeDetailProviderProps,
): ReactNode {
  // Keyed by prototype: the picks overlay below belongs to ONE prototype's
  // record, so pointing the pane at another one starts a fresh overlay rather
  // than replaying this one's unconfirmed picks onto it.
  return <DetailGate key={props.name} {...props} />;
}

function DetailGate(props: PrototypeDetailProviderProps): ReactNode {
  const { name } = props;
  // The whole list, and this prototype's declared size looked up in it once it
  // has loaded. A list change re-renders this gate and `DetailProvider`, but
  // not the canvas: `size` only SEEDS a canvas (the `useState` initializer, and
  // the re-open when the pane points at another prototype), and the context
  // value `DetailProvider` memoizes never depends on it — so a fresh `size`
  // object from a re-broadcast list moves nothing its consumers see.
  // Not-loaded is `loading` (no placeholder list), so the settle always
  // re-renders this gate.
  const list = useLive(prototypesList);

  // ONE shared record per prototype (`_picks/<id>.json` on the server), so the
  // variant frame A shows is the variant main, every worktree deploy, every
  // browser and the agents' CLI see — live. Optimistic, so a chip answers the
  // click at once; a failed write keeps the pick on screen and shows in the
  // sync-status cloud (never-revert). Pending until the record loads: a pick
  // can only be made on top of the picks the user can see.
  const stored = useOptimisticResource(
    prototypePicks,
    { name },
    {
      apply: applyPicksChange,
      mutate: (change: PicksChange) =>
        fetchEndpoint(setPrototypePicks, { name }, { body: change }),
      label: "prototype options",
      describeOp: (change: PicksChange) =>
        change.kind === "reset" ? "reset" : `${change.option}=${change.value}`,
    },
  );

  if (list.status === "loading") return <Loading variant="block" />;
  if (list.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="the prototypes"
        error={list.error}
        refetch={list.refetch}
      />
    );
  }
  if (stored.status === "loading") return <Loading variant="block" />;
  if (stored.status === "error") {
    // A record that cannot be read stays broken until someone fixes it, so it
    // renders the error naming the problem — never a spinner that never ends.
    return (
      <ResourceErrorInline
        variant="block"
        error={stored.error}
        refetch={stored.refetch}
      />
    );
  }
  const size =
    list.data.find((p) => p.name === name)?.viewport ??
    DEFAULT_PROTOTYPE_VIEWPORT;
  return <DetailProvider {...props} size={size} stored={stored} />;
}

function DetailProvider({
  name,
  size,
  stored,
  remember,
  initialVersion = null,
  initialPicks,
  initialSize,
  children,
}: PrototypeDetailProviderProps & {
  size: PrototypeViewport;
  stored: OptimisticSettled<StoredPicks, PicksChange>;
}) {
  const contributed = FrameSource.useContributions();
  const sources = useMemo<CanvasSourceEntry[]>(
    () =>
      contributed.flatMap((c) =>
        typeof c.match === "string"
          ? [{ id: c.match, addLabel: c.addLabel }]
          : [],
      ),
    [contributed],
  );

  const shared = stored.data;

  // The canvas belongs to ONE prototype in ONE pane instance: held with both,
  // so opening another opens its own canvas without an effect resetting
  // anything. The prototype is part of the slot because a pane instance can be
  // pointed at another prototype in place. A saved canvas is read synchronously
  // here, so the first paint is already it rather than the defaults swapped out
  // a moment later.
  const slot =
    remember !== undefined && !isEmbeddedDocument()
      ? `${remember}:${name}`
      : null;
  const open = (): Held => ({
    name,
    slot,
    state:
      slot !== null
        ? openCanvas(slot, name, size)
        : initialCanvasState({
            size: initialSize ?? size,
            version: initialVersion,
            picks: initialPicks ?? "shared",
          }),
  });
  const [held, setHeld] = useState<Held>(open);
  let current = held;
  if (held.name !== name || held.slot !== slot) {
    // Another prototype or pane instance: its canvas, set during render
    // (React's "adjust state on a prop change" pattern) rather than by an
    // effect after paint.
    current = open();
    setHeld(current);
  }
  const canvas = current.state;
  // The latest state a dispatch produced, and the rendered state it chained
  // from — two dispatches in one event must chain, not both start from the
  // render's snapshot. Once the next render lands, `from` no longer matches
  // and the rendered state is the truth again.
  const latest = useRef<{ from: object; state: CanvasState } | null>(null);

  const writeShared = stored.dispatch;
  const runEffect = useCallback(
    (effect: CanvasEffect) => {
      switch (effect.kind) {
        case "setShared":
          writeShared({
            kind: "set",
            option: effect.option,
            value: effect.value,
          });
          return;
        case "resetShared":
          writeShared({ kind: "reset" });
          return;
        case "replaceShared":
          writeShared({ kind: "reset" });
          for (const [option, value] of Object.entries(effect.picks)) {
            writeShared({ kind: "set", option, value });
          }
          return;
      }
    },
    [writeShared],
  );

  const currentState = (): CanvasState =>
    latest.current?.from === current ? latest.current.state : canvas;
  const sharedSnapshot = (): StoredPicks => shared;

  const dispatch = useEventCallback((action: CanvasAction) => {
    const before = currentState();
    const { state, effects } = canvasReducer(before, action, sharedSnapshot());
    if (state === before && effects.length === 0) return;
    latest.current = { from: current, state };
    setHeld({ name, slot, state });
    // A drag's preview changes every move and is never saved.
    if (slot !== null && !isTransientAction(action)) {
      writeDraft(savedCanvasStore, serializeCanvas(state), { scope: slot });
    }
    for (const effect of effects) runEffect(effect);
  });

  const keepOnly = useEventCallback((id: FrameId) => {
    const before = currentState();
    const snapshot = sharedSnapshot();
    const closed = before.frames.length - 1;
    if (closed < 1) return;
    dispatch({ type: "keepOnly", id });
    showToast({
      description: `Closed ${String(closed)} other frame${closed === 1 ? "" : "s"}`,
      action: {
        label: "Undo",
        onClick: () =>
          dispatch({ type: "restore", state: before, shared: snapshot }),
      },
    });
  });

  const value = useMemo<PrototypeDetailContextValue>(
    () => ({ name, shared, canvas, dispatch, keepOnly, sources }),
    [name, shared, canvas, dispatch, keepOnly, sources],
  );
  return (
    <PrototypeDetailContext.Provider value={value}>
      <PrototypeDetailWrap.Wrap>{children}</PrototypeDetailWrap.Wrap>
    </PrototypeDetailContext.Provider>
  );
}

/** The options `version` declares — the live page's (`meta`) for `null`. */
export function documentOptions(
  meta: PrototypeMeta,
  version: PrototypeVersion | null,
): readonly PrototypeOption[] {
  return version?.options ?? meta.options;
}

/**
 * The picks a prototype frame shows, as STORED: frame A's are the shared
 * record, every other frame's its own.
 */
export function useFrameStoredPicks(frame: PrototypeFrame): StoredPicks {
  const { shared } = usePrototypeDetail();
  return picksOf(frame, shared);
}

/**
 * The picks that apply to a frame's document: its stored picks still valid
 * against THAT document's declaration (a recorded version's own options, or
 * the live page's), defaults left out.
 */
export function useFramePicks(
  frame: PrototypeFrame,
  meta: PrototypeMeta,
): OptionPicks {
  const stored = useFrameStoredPicks(frame);
  const options = documentOptions(meta, frame.version);
  return useMemo(() => resolvePicks(options, stored), [options, stored]);
}

/** Every prototype frame's stored picks, `"shared"` read from the record. */
export function useStoredPicksOf(): (frame: PrototypeFrame) => StoredPicks {
  const { shared } = usePrototypeDetail();
  return useCallback((frame) => picksOf(frame, shared), [shared]);
}

/**
 * THE url of a prototype frame's document: its version under its picks.
 *
 * A color pick alone never changes it: colors are painted into the loaded
 * document live (`useFrameColorVars`), so a drag never reloads the frame. The
 * url carries the color picks as of its last change for another reason — a
 * choice pick, a version step or an edit — so the document it loads comes
 * back server-stamped with them, with no flash of the default colors.
 */
export function useFrameSrc(
  frame: PrototypeFrame,
  meta: PrototypeMeta,
): string {
  const stored = useFrameStoredPicks(frame);
  const options = documentOptions(meta, frame.version);
  // What the url depends on: everything but the color picks.
  const key = prototypeDocumentSrc(
    meta,
    frame.version,
    withoutColorPicks(options, stored),
  );
  const src = prototypeDocumentSrc(meta, frame.version, stored);
  const [held, setHeld] = useState({ key, src });
  if (held.key === key) return held.src;
  // Set during render (React's "adjust state on a prop change" pattern), so
  // the new document starts loading in this very commit.
  setHeld({ key, src });
  return src;
}

/** `stored` without the picks of `options`' color options. */
function withoutColorPicks(
  options: readonly PrototypeOption[],
  stored: StoredPicks,
): StoredPicks {
  const colors = new Set(
    options.filter((o) => o.kind === "color").map((o) => o.name),
  );
  if (colors.size === 0) return stored;
  return Object.fromEntries(
    Object.entries(stored).filter(([name]) => !colors.has(name)),
  );
}

/**
 * The color every color option paints in a frame's document right now, as
 * `#rrggbb` keyed by option name: the drag's preview, else the pick, else the
 * page's default. What `PrototypeFrame` sets on the document's `<html>` as
 * `--<name>`, so a color repaints without a reload.
 */
export function useFrameColorVars(
  frame: PrototypeFrame,
  meta: PrototypeMeta,
): Readonly<Record<string, string>> {
  const { canvas } = usePrototypeDetail();
  const picks = useFramePicks(frame, meta);
  const options = documentOptions(meta, frame.version);
  const vars: Record<string, string> = {};
  for (const option of options) {
    if (option.kind !== "color") continue;
    const preview = previewedValue(canvas, frame.id, option.name);
    vars[option.name] = pickedColor(
      option,
      preview === null ? picks : { ...picks, [option.name]: preview },
    );
  }
  return vars;
}

/**
 * The url of one document of the prototype — `version`, or the live folder for
 * `null` — under `stored` picks, judged against the options THAT version
 * declares.
 *
 * - live: its `index.html`, cache-busted by `meta.rev` (a hash of this
 *   prototype's own files), so an agent's edit reloads the frame — and an edit
 *   to another prototype, or a backend restart, does not.
 * - a recorded version: its frozen document. No cache-bust, since a sha
 *   addresses content that never changes.
 */
export function prototypeDocumentSrc(
  meta: PrototypeMeta,
  version: PrototypeVersion | null,
  stored: StoredPicks,
): string {
  const resolved = resolvePicks(documentOptions(meta, version), stored);
  return version === null
    ? prototypeUrl(meta.name, { v: meta.rev, picks: resolved })
    : prototypeVersionUrl(meta.name, version.sha, { picks: resolved });
}
