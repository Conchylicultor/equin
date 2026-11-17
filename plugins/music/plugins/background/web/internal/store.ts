import { useSyncExternalStore } from "react";
import { z } from "zod";
import {
  INITIAL_MUSIC_STATE,
  startedPlaying,
  step,
  type MusicEvent,
  type MusicState,
  type NowPlaying,
} from "../../shared/protocol";

/**
 * The page's background music: one store for the whole page (every tab set and
 * window of it), and its link to the browser's other pages.
 *
 * Other pages are reached over a BroadcastChannel: a `claim` when music starts
 * here (they pause theirs), this page's `state` whenever what it plays
 * changes (their music button mirrors it), `hello` to ask for everyone's state,
 * and `cmd` to drive the page playing from another one's button. A page that
 * dies says nothing, so each page holds an exclusive Web Lock under its own id
 * for its whole life; a page mirroring another queues for that lock, and is
 * granted it exactly when the other is gone.
 */

const CHANNEL = "equin.background-music";
const LOCK_PREFIX = "equin.background-music.page:";

/** This page's id — not the tab id, which a duplicated tab shares. */
const pageId = crypto.randomUUID();

const nowSchema = z
  .object({
    sourceId: z.string(),
    title: z.string(),
    href: z.string(),
    playing: z.boolean(),
  })
  .nullable();

const commandSchema = z.enum(["pause", "resume", "stop"]);
export type MusicCommand = z.infer<typeof commandSchema>;

const messageSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("claim"), from: z.string() }),
  z.object({ t: z.literal("hello"), from: z.string() }),
  z.object({ t: z.literal("state"), from: z.string(), now: nowSchema }),
  z.object({
    t: z.literal("cmd"),
    from: z.string(),
    to: z.string(),
    cmd: commandSchema,
  }),
]);
type Message = z.infer<typeof messageSchema>;

export interface MusicSnapshot {
  readonly state: MusicState;
  /** The panel is open: every source's player mounts, idle, to be ready. */
  readonly warm: boolean;
  /** Per source, what plays now (its title, its page), as its probe last read it. */
  readonly labels: ReadonlyMap<string, SourceLabel>;
}

/** What a source plays now: its title in words, and the route of its page. */
export interface SourceLabel {
  readonly title: string;
  readonly href: string;
}

// eslint-disable-next-line scoped-store/no-module-mutable-store -- intentionally page-global: ONE background music per page, shared by every surface and window of it (the service's whole point), as one immutable snapshot
let snap: MusicSnapshot = {
  state: INITIAL_MUSIC_STATE,
  warm: false,
  labels: new Map(),
};
let acrossApps = false;
let channel: BroadcastChannel | null = null;
let lastSent: string | null = null;
const watched = new Set<string>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function post(message: Message) {
  channel?.postMessage(message);
}

function announceState() {
  const { current } = snap.state;
  const now = current
    ? {
        sourceId: current.sourceId,
        title: snap.labels.get(current.sourceId)?.title ?? "",
        href: snap.labels.get(current.sourceId)?.href ?? "",
        playing: current.playing,
      }
    : null;
  const json = JSON.stringify(now);
  if (json === lastSent) return;
  lastSent = json;
  post({ t: "state", from: pageId, now });
}

/** Learns when page `other` is gone: its lock is released with it. */
function watchPage(other: string) {
  if (watched.has(other)) return;
  watched.add(other);
  void navigator.locks.request(LOCK_PREFIX + other, { mode: "shared" }, () => {
    watched.delete(other);
    dispatch({ kind: "remote-gone", pageId: other });
  });
}

function onMessage(raw: unknown) {
  const message = messageSchema.parse(raw);
  if (message.from === pageId) return;
  switch (message.t) {
    case "claim":
      dispatch({ kind: "remote-claim" });
      return;
    case "hello":
      lastSent = null;
      announceState();
      return;
    case "state":
      if (message.now !== null) watchPage(message.from);
      dispatch({
        kind: "remote-state",
        pageId: message.from,
        now: message.now,
      });
      return;
    case "cmd":
      if (message.to === pageId) dispatch({ kind: message.cmd });
      return;
  }
}

/** Joins the browser's other pages. Once per page, from the service's root. */
export function connectPages(): () => void {
  if (channel) throw new Error("background music: connected twice");
  // Held for the page's life: released only by the page going away.
  void navigator.locks.request(
    LOCK_PREFIX + pageId,
    () => new Promise<never>(() => {}),
  );
  const ch = new BroadcastChannel(CHANNEL);
  channel = ch;
  ch.onmessage = (e: MessageEvent<unknown>) => onMessage(e.data);
  post({ t: "hello", from: pageId });
  announceState();
  return () => {
    ch.close();
    channel = null;
  };
}

/**
 * An event as the service's callers spell it: the across-apps setting is the
 * store's. A view leaving says whether that closes its app (`closesApp`: a
 * desktop window, apps side by side) — then its music never carries across.
 */
export type DispatchedEvent =
  | Exclude<MusicEvent, { kind: "shown" | "adopt" }>
  | { kind: "shown"; sourceId: string; delta: 1 | -1; closesApp: boolean }
  | { kind: "adopt"; sourceId: string; closesApp: boolean };

export function dispatch(event: DispatchedEvent) {
  let e: MusicEvent;
  if (event.kind === "shown") {
    const { closesApp, ...rest } = event;
    e = { ...rest, acrossApps: acrossApps && !closesApp };
  } else if (event.kind === "adopt") {
    const { closesApp, ...rest } = event;
    e = { ...rest, acrossApps: acrossApps && !closesApp };
  } else {
    e = event;
  }
  const prev = snap.state;
  const next = step(prev, e);
  if (next !== prev) snap = { ...snap, state: next };
  if (startedPlaying(prev, next) || e.kind === "foreground") {
    post({ t: "claim", from: pageId });
  }
  if (next !== prev) {
    announceState();
    emit();
  }
}

/** Drives the page that plays `pageId`'s music — another page's, from this one's button. */
export function command(to: string, cmd: MusicCommand) {
  post({ t: "cmd", from: pageId, to, cmd });
}

export function setAcrossApps(next: boolean) {
  acrossApps = next;
}

export function setLabel(sourceId: string, label: SourceLabel) {
  const prev = snap.labels.get(sourceId);
  if (prev?.title === label.title && prev.href === label.href) return;
  snap = { ...snap, labels: new Map(snap.labels).set(sourceId, label) };
  announceState();
  emit();
}

export function setWarm(warm: boolean) {
  if (snap.warm === warm) return;
  snap = { ...snap, warm };
  emit();
}

function getSnapshot(): MusicSnapshot {
  return snap;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMusicSnapshot(): MusicSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * What `now` plays, as its probe read it: another page's as it said, this
 * page's from its probe (undefined until the probe first read it).
 */
export function labelOf(
  now: NowPlaying,
  labels: ReadonlyMap<string, SourceLabel>,
): SourceLabel | undefined {
  return now.where === "remote"
    ? { title: now.title, href: now.href }
    : labels.get(now.sourceId);
}

export function peekState(): MusicState {
  return snap.state;
}
