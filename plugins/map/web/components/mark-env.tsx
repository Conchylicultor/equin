import {
  createContext,
  useContext,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useIconMarkup } from "@plugins/ui/plugins/icons/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { markSvgProblem, type MapMark, type MapTileScheme } from "../../core";
import type { MapMarkEnv } from "../slots";
import { MapLabel } from "./map-label";

/**
 * How the map draws text on its own surface (a spot's count, an always-on
 * label): the CSS `font` the DOM's `MapLabel` computes to here, so canvas text
 * and DOM labels are one typeface at one size.
 */
export interface MapTextStyle {
  /** `MapLabel`'s computed `font` shorthand: text beside a mark. */
  font: string;
  /** `<Text variant="count">`'s: a count in the middle of a mark. */
  countFont: string;
}

interface MarkHost {
  /** Resolves a CSS colour to its computed value in the map's theme scope. */
  color: (css: string) => string;
  text: MapTextStyle;
}

const MarkHostContext = createContext<MarkHost | null>(null);

/**
 * Resolves CSS colours on a swatch element in the map's subtree: whatever the
 * browser computes `color: <css>` to there. Cached per string.
 */
class ColorResolver {
  private readonly resolved = new Map<string, string>();
  constructor(private readonly swatch: HTMLElement) {}

  resolve(css: string): string {
    const hit = this.resolved.get(css);
    if (hit !== undefined) return hit;
    const { style } = this.swatch;
    style.color = "";
    style.color = css;
    if (style.color === "") {
      throw new Error(`map mark: "${css}" is not a CSS colour`);
    }
    const value = getComputedStyle(this.swatch).color;
    this.resolved.set(css, value);
    return value;
  }
}

/** The computed font of the innermost element under `selector` in the probe — the text itself. */
function probeFont(probe: HTMLElement, selector: string): string {
  let el = probe.querySelector(selector);
  while (el?.firstElementChild) el = el.firstElementChild;
  if (el === null) {
    throw new Error(`map mark host: no ${selector} probe`);
  }
  // Built from the longhands: the computed `font` shorthand serializes to ""
  // whenever a sub-property it cannot spell is set (tabular numbers).
  const cs = getComputedStyle(el);
  const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  if (cs.fontSize === "" || cs.fontFamily === "") {
    throw new Error(`map mark host: the ${selector} probe computed no font`);
  }
  return font;
}

/**
 * The map's mark host: a hidden probe in the map's own subtree (so a token
 * resolves in the map's theme scope) that resolves colours and measures the
 * label font. Its readers are `null` until the probe has mounted — marks are
 * pending for that one render, never painted with a guessed colour.
 */
export function MarkHostProvider({ children }: { children: ReactNode }) {
  const [probe, setProbe] = useState<HTMLSpanElement | null>(null);
  const host = useMemo<MarkHost | null>(() => {
    if (probe === null) return null;
    const swatch = probe.firstElementChild;
    if (!(swatch instanceof HTMLElement)) {
      throw new Error("map mark host: the colour swatch is missing");
    }
    const font = probeFont(probe, "[data-map-label-text]");
    const countFont = probeFont(probe, "[data-map-count-text]");
    const resolver = new ColorResolver(swatch);
    return { color: (css) => resolver.resolve(css), text: { font, countFont } };
  }, [probe]);
  return (
    <MarkHostContext.Provider value={host}>
      <span
        ref={setProbe}
        aria-hidden
        className="pointer-events-none invisible sr-only"
      >
        <span />
        <span data-map-label-text="">
          <MapLabel tiles="light">0</MapLabel>
        </span>
        <span data-map-count-text="">
          <Text variant="count">0</Text>
        </span>
      </span>
      {children}
    </MarkHostContext.Provider>
  );
}

/**
 * The readers a mark function needs, in this map's scope — `null` until the
 * map's probe has mounted (draw nothing that render). For a pin component that
 * draws its own mark (`MapMarkImage`), and for the host computing marks.
 */
export function useMapMarkEnv(tiles: MapTileScheme): MapMarkEnv | null {
  const host = useContext(MarkHostContext);
  const icon = useIconMarkup();
  return useMemo(
    () => (host === null ? null : { icon, color: host.color, tiles }),
    [host, icon, tiles],
  );
}

/** The label font canvas text is drawn in, `null` until the probe has mounted. */
export function useMapTextStyle(): MapTextStyle | null {
  return useContext(MarkHostContext)?.text ?? null;
}

/**
 * A mark drawn in the DOM: its SVG inline, at its box. The pin component of a
 * lifted (hovered, active) pin draws this, so the pin looks exactly like the
 * sprite the map draws it from at rest.
 */
export function MapMarkImage({
  mark,
  className,
  style,
}: {
  mark: MapMark;
  className?: string;
  style?: CSSProperties;
}) {
  const problem = markSvgProblem(mark.svg);
  if (problem !== null) {
    throw new Error(`map mark ${mark.key}: its SVG holds ${problem}`);
  }
  return (
    <span
      aria-hidden
      className={className}
      style={{
        display: "block",
        width: mark.width,
        height: mark.height,
        ...style,
      }}
      // A mark is built by the pin type's own pure function from concrete
      // colours and the icon sprites' own markup — never user markup, and
      // `markSvgProblem` refuses script above.
      dangerouslySetInnerHTML={{ __html: mark.svg }}
    />
  );
}
