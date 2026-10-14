import {
  memo,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type Ref,
} from "react";
import { findScrollParent } from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { useSurfaceShortcuts } from "@plugins/primitives/plugins/shortcuts/web";
import { CARDS } from "../internal/cards";
import { LAYERS, type IcebergPiece } from "../internal/iceberg/data";
import { openWidth, PIECE_FONT } from "../internal/iceberg/geometry";
import {
  mountIcebergScene,
  type HeaderOver,
  type IcebergScene,
} from "../internal/iceberg/scene";
import { createCardRuntime } from "../internal/kit/runtime";
import "../internal/kit/kit.css";
import "./iceberg.css";

/**
 * The foundations page: what equin brings on top of Claude, as an iceberg —
 * ten layers from the apps at sea level down to the loop that built everything
 * above it. Every piece is a pill that opens in place into a card; most cards
 * carry a live drawing of what the piece does.
 *
 * React renders the scene's markup once and never re-renders it: the scene
 * (`internal/iceberg/scene.ts`) and the card runtime (`internal/kit`) own the
 * DOM from mount on — classes, measured geometry, the berg's strips, the cards
 * mounted into open pieces — exactly as the prototype's script owned its page.
 * That is what lets a piece glide from a pill into a card without React ever
 * reconciling a half-animated node.
 */
export function IcebergSection({
  onHeaderOver,
}: {
  /** What lies under the pinned header (sky or sea), for the page to dress it to match. Must be stable. */
  onHeaderOver: (over: HeaderOver) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<IcebergScene | null>(null);
  // a scene-unique prefix for the berg's SVG gradient ids
  const idPrefix = useId().replace(/[^\w-]/g, "");

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const runtime = createCardRuntime(root, CARDS);
    const scene = mountIcebergScene({
      root,
      runtime,
      locs: LAYERS.map((L) => L.loc),
      idPrefix,
      onHeaderOver,
    });
    sceneRef.current = scene;
    return () => {
      sceneRef.current = null;
      scene.dispose();
      runtime.dispose();
    };
  }, [idPrefix, onHeaderOver]);

  // the pane's viewport is the scene's "screen": refit when it changes size
  useResizeObserver(
    () => (rootRef.current ? findScrollParent(rootRef.current) : null),
    () => sceneRef.current?.onResize(),
  );

  const shortcuts = useMemo(
    () => [
      {
        id: "website.foundations.expand-all",
        keys: "e",
        label: "Expand or collapse every piece",
        group: "Foundations",
        handler: () => sceneRef.current?.toggleAll(),
      },
    ],
    [],
  );
  useSurfaceShortcuts(shortcuts);

  return <IcebergMarkup ref={rootRef} />;
}

/** The scene's static markup. Memoised with no props, so React never touches it after mount. */
const IcebergMarkup = memo(function IcebergMarkup({
  ref,
}: {
  ref: Ref<HTMLDivElement>;
}) {
  return (
    <div ref={ref} className="iceberg">
      <div className="iceberg-scene">
        <div className="iceberg-berg" aria-hidden="true" />
        <header className="iceberg-hero">
          <h1>
            What equin brings <em>on top of</em> Claude.
          </h1>
          <p>
            Server, database updates, auto-deploys, live previews, crash
            reporting and a hundred more come built in. Production-grade
            components your apps reuse and customize, and a harness that makes
            developing the app itself a seamless experience.
          </p>
          <div className="iceberg-split-key" role="group" aria-label="Show">
            <button type="button" data-f="component" aria-pressed="false">
              <i className="iceberg-key-component" />
              Components
            </button>
            <button type="button" data-f="harness" aria-pressed="false">
              <i className="iceberg-key-harness">
                <HarnessMark />
              </i>
              Harness
            </button>
          </div>
          <div className="iceberg-dive">Descend ↓</div>
        </header>
        {LAYERS.map((L, i) => (
          <section
            key={L.name}
            className={`iceberg-layer ${i >= 3 ? "k-deep" : "k-sun"}`}
            data-i={i}
            data-deep={i >= 3 ? "" : undefined}
          >
            <div className="iceberg-layer-head">
              <h2>{L.name}</h2>
              <p>{L.tag}</p>
            </div>
            <div className="iceberg-pieces">
              {L.pieces.map((p) => (
                <Piece key={p.name} piece={p} layer={i} />
              ))}
            </div>
          </section>
        ))}
        <footer className="iceberg-foot">
          At the bottom of the iceberg is the loop that built everything above
          it.
        </footer>
      </div>
      <nav className="iceberg-gauge" aria-label="Depth">
        <div className="iceberg-readout" />
        {LAYERS.map((L, i) => (
          <a key={L.name} href={`#iceberg-layer-${i}`} data-i={i}>
            <span>{L.name}</span>
          </a>
        ))}
      </nav>
      <button type="button" className="iceberg-expander" aria-pressed="false">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M4 6l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span>Expand all</span>
        <kbd aria-hidden="true">E</kbd>
      </button>
    </div>
  );
});

function Piece({ piece, layer }: { piece: IcebergPiece; layer: number }) {
  const style = {
    "--i": layer,
    "--fs": `${PIECE_FONT[piece.weight]}px`,
    "--ow": `${openWidth(piece.desc, piece.weight)}px`,
  } as CSSProperties;
  return (
    <button
      type="button"
      className={`iceberg-item${piece.card ? " has-viz" : ""}`}
      data-w={piece.weight}
      data-kind={piece.kind}
      aria-expanded="false"
      style={style}
    >
      <span className="iceberg-name">
        {piece.kind === "harness" && <HarnessMark />}
        {piece.name}
      </span>
      <span className="iceberg-desc">{piece.desc}</span>
      {piece.card && <span className="vz" data-card={piece.card} />}
    </button>
  );
}

/** The Harness mark: a wrench, in front of every Harness piece's name and on the Harness key. */
function HarnessMark() {
  return (
    <svg
      className="iceberg-mark"
      viewBox="0 0 24 24"
      width="12"
      height="12"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}
