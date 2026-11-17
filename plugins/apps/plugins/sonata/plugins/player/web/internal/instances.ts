import {
  createRelayLink,
  type RelayLink,
} from "@plugins/primitives/plugins/scope/plugins/context-relay/web";

/**
 * The page's Sonata playback instances: a player's playback (its cursor,
 * document, session, audio) hosted away from its view — raised at the view's
 * render origin, the page's normally — so it outlives the view. The view
 * attaches to its instance by key (the tab it renders in) and reads it
 * through a relay link; going away, it detaches:
 *
 *  - while the song plays, the instance is offered to the background music
 *    service (`MusicHand.adopt`): kept (the user keeps music across apps) it
 *    plays on as the page's ONE background instance — a previous one pauses
 *    and goes;
 *  - otherwise it goes, and with it the song (its kept playhead gives the
 *    position back, paused, next time).
 *
 * The decision waits a microtask, so a view that re-attaches at once (a
 * remount, React's StrictMode) finds its instance untouched. A view coming
 * back to the background instance takes it out of the service (`release`):
 * it plays in front again. A background instance with no view goes when the
 * service stops holding it (stopped, another source played).
 */

/** The background music service, as the registry drives it for Sonata. */
export interface MusicHand {
  /** The song outlives its view: answers whether the service kept it. */
  adopt(): boolean;
  /** The song plays in front again: it leaves the service. */
  release(): void;
}

/** What an instance's music link registers: its session's transport. */
export interface PlaybackControls {
  isPlaying(): boolean;
  setPlaying(playing: boolean): void;
}

/** Raises an instance's playback at the view's origin (`render-origin`). */
export type RaiseInstance = (
  link: RelayLink,
  onGone: () => void,
) => { remove(): void };

interface Instance {
  readonly key: string;
  readonly link: RelayLink;
  raised: { remove(): void } | null;
  views: number;
  controls: PlaybackControls | null;
  /** Bumped by each attach: a detach's deferred decision is stale once it moved. */
  epoch: number;
}

export interface InstancesSnapshot {
  /** The instance playing on with no view, held by the music service. */
  readonly background: string | null;
  /** Per instance, the title of its song, as its app published it. */
  readonly titles: ReadonlyMap<string, string>;
}

// Page-global on purpose: an instance OUTLIVES every view and scope that could
// hold it (that is its point), so the page holds them, keyed by place.
const instances = new Map<string, Instance>();
let snap: InstancesSnapshot = { background: null, titles: new Map() };
const listeners = new Set<() => void>();

function setSnap(next: InstancesSnapshot): void {
  if (next === snap) return;
  snap = next;
  for (const l of [...listeners]) l();
}

export function subscribeInstances(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function instancesSnapshot(): InstancesSnapshot {
  return snap;
}

function instanceOf(key: string): Instance {
  let inst = instances.get(key);
  if (!inst) {
    inst = {
      key,
      link: createRelayLink(),
      raised: null,
      views: 0,
      controls: null,
      epoch: 0,
    };
    instances.set(key, inst);
  }
  return inst;
}

/** The relay link a view reads instance `key` through (made on first ask). */
export function instanceLink(key: string): RelayLink {
  return instanceOf(key).link;
}

function dispose(inst: Instance): void {
  if (instances.get(inst.key) !== inst) return;
  instances.delete(inst.key);
  inst.raised?.remove();
  inst.raised = null;
  const titles = new Map(snap.titles);
  titles.delete(inst.key);
  setSnap({
    background: snap.background === inst.key ? null : snap.background,
    titles,
  });
}

/**
 * A view of instance `key` attaches: raises it the first time. Answers the
 * link to read it through (a view rendered just before its previous instance
 * went reads the new one's).
 */
export function attachInstance(
  key: string,
  raise: RaiseInstance,
  music: MusicHand,
): RelayLink {
  const inst = instanceOf(key);
  inst.views++;
  inst.epoch++;
  if (inst.raised === null) {
    inst.raised = raise(inst.link, () => {
      // Its origin went away (an embed closed): so did the playback.
      inst.raised = null;
      dispose(inst);
    });
  }
  if (snap.background === key) {
    setSnap({ ...snap, background: null });
    music.release();
  }
  return inst.link;
}

/** A view of instance `key` detaches; the last one decides its fate (a microtask later). */
export function detachInstance(key: string, music: MusicHand): void {
  const inst = instances.get(key);
  if (!inst) return;
  inst.views--;
  if (inst.views > 0) return;
  const epoch = inst.epoch;
  queueMicrotask(() => {
    if (inst.epoch !== epoch || inst.views > 0) return;
    if (instances.get(key) !== inst) return;
    const playing = inst.controls?.isPlaying() ?? false;
    if (playing && music.adopt()) {
      const previous = snap.background;
      setSnap({ ...snap, background: key });
      if (previous !== null && previous !== key) {
        const prev = instances.get(previous);
        if (prev) {
          prev.controls?.setPlaying(false);
          if (prev.views === 0) dispose(prev);
        }
      }
      return;
    }
    dispose(inst);
  });
}

/**
 * The music service no longer holds instance `key` (stopped, another source
 * played): it pauses, and goes unless a view shows it.
 */
export function dropBackground(key: string): void {
  if (snap.background !== key) return;
  setSnap({ ...snap, background: null });
  const inst = instances.get(key);
  if (!inst) return;
  inst.controls?.setPlaying(false);
  if (inst.views === 0) dispose(inst);
}

/** Drives the background instance from the music service (play / pause). */
export function setBackgroundPlaying(playing: boolean): void {
  const key = snap.background;
  if (key === null) return;
  instances.get(key)?.controls?.setPlaying(playing);
}

/** Instance `key`'s music link registers its transport. */
export function registerControls(
  key: string,
  controls: PlaybackControls,
): () => void {
  const inst = instances.get(key);
  if (!inst) {
    throw new Error(`sonata player: no playback instance "${key}"`);
  }
  inst.controls = controls;
  return () => {
    if (inst.controls === controls) inst.controls = null;
  };
}

/** Instance `key`'s app publishes the title of its song. */
export function publishTitle(key: string, title: string): void {
  if (!instances.has(key) || snap.titles.get(key) === title) return;
  setSnap({ ...snap, titles: new Map(snap.titles).set(key, title) });
}
