import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  useYouTubePlayer,
  type YouTubePlayerController,
} from "@plugins/integrations/plugins/youtube/web";
import { RecordingPlayer } from "../components/recording-player";

/**
 * The session's recording player, shared by the player that owns it
 * (`RecordingPlayer`, rendered by the provider for the session's life) and the viewport that shows it
 * (`RecordingVideo`, mounted only while its section is open).
 */
export interface RecordingStore {
  /** The video whoever shows the song's recording declared (the latest claim), or `null`. */
  videoId: string | null;
  /** Declare the song's recording; the returned function withdraws the claim. */
  claim: (videoId: string) => () => void;
  /** The one player's controller, for the life of the session. */
  controller: YouTubePlayerController;
  /**
   * The element holding the player's iframe. Never re-created: it is MOVED —
   * state-preserving, so the video never reloads — between the parking spot
   * and the viewport on screen.
   */
  stage: HTMLDivElement;
  /**
   * Where the stage waits while no viewport shows it: a small box fixed off
   * screen on `<body>` — not hidden, so a parked video keeps playing and
   * posting its time.
   */
  parking: HTMLDivElement;
  /** Bumped by `reload`: the player is created afresh (after a player fault). */
  generation: number;
  reload: () => void;
}

const RecordingContext = createContext<RecordingStore | null>(null);

/** The session's recording store. Throws outside a Sonata playback session. */
export function useRecordingStore(): RecordingStore {
  const store = useContext(RecordingContext);
  if (store === null) {
    throw new Error(
      "useRecordingStore must be used inside a Sonata playback session (the recording's SonataSession.Provider)",
    );
  }
  return store;
}

interface Claim {
  token: symbol;
  videoId: string;
}

/**
 * Per-session recording store (`SonataSession.Provider`): the player's
 * controller, its stage and parking spot, and the claimed video — and the
 * player itself (`RecordingPlayer`). Lives with the session, so the video
 * outlives whatever shows it — a collapsed section, a pane remount, a display
 * switch.
 */
export function RecordingProvider({ children }: { children: ReactNode }) {
  const controller = useYouTubePlayer();
  const [stage] = useState(() => {
    const el = document.createElement("div");
    el.className = "size-full";
    return el;
  });
  const [parking] = useState(createParking);
  // Runs after any viewport's own layout effect (a parent's runs last), so a
  // viewport mounted in the same commit already holds the stage.
  useLayoutEffect(() => {
    document.body.appendChild(parking);
    if (!stage.isConnected) placeStage(stage, parking);
    return () => parking.remove();
  }, [parking, stage]);
  const [claims, setClaims] = useState<readonly Claim[]>([]);
  const [generation, setGeneration] = useState(0);

  const claim = useCallback((videoId: string) => {
    const token = Symbol(videoId);
    setClaims((cs) => [...cs, { token, videoId }]);
    return () => setClaims((cs) => cs.filter((c) => c.token !== token));
  }, []);
  const reload = useCallback(() => setGeneration((g) => g + 1), []);

  const videoId = claims.at(-1)?.videoId ?? null;
  const store = useMemo<RecordingStore>(
    () => ({
      videoId,
      claim,
      controller,
      stage,
      parking,
      generation,
      reload,
    }),
    [videoId, claim, controller, stage, parking, generation, reload],
  );
  return (
    <RecordingContext.Provider value={store}>
      {children}
      <RecordingPlayer />
    </RecordingContext.Provider>
  );
}

/** The off-screen parking spot: player-sized, so YouTube serves it as one. */
function createParking(): HTMLDivElement {
  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  el.inert = true;
  Object.assign(el.style, {
    position: "fixed",
    top: "0",
    left: "-200vw",
    width: "320px",
    height: "180px",
    pointerEvents: "none",
  });
  return el;
}

/**
 * Declare the open song's recording — `null` for none — from a component that
 * stays mounted while the song is open (a headless effect, not a section body,
 * which unmounts when collapsed). The video plays, and is synced when the
 * score is timed on it, whether or not anything shows it.
 */
export function useShowRecording(videoId: string | null): void {
  const { claim } = useRecordingStore();
  useEffect(
    () => (videoId === null ? undefined : claim(videoId)),
    [videoId, claim],
  );
}

/**
 * Move the stage into `parent`, keeping the iframe's state (`moveBefore`: the
 * video neither reloads nor pauses). A node not in the document has no state
 * to keep, so it is simply appended.
 */
export function placeStage(stage: HTMLDivElement, parent: HTMLElement): void {
  if (stage.parentNode === parent) return;
  if (stage.isConnected && parent.isConnected) parent.moveBefore(stage, null);
  else parent.appendChild(stage);
}

/**
 * Whether this browser can move a playing iframe without reloading it
 * (`Element.moveBefore`). Without it the stage never leaves its parking spot:
 * the video keeps playing (and syncing) unseen rather than reloading.
 */
export const canMoveStage: boolean =
  typeof Element !== "undefined" && "moveBefore" in Element.prototype;
