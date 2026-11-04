/**
 * The night palette, as the drawings write it: every colour a frame's markup
 * names is one of these custom-property references. The values are declared
 * ONCE, on `.vision-ladder` (`components/vision-ladder.css`) — the scene's own
 * fixed palette, the same in light and dark mode (see the plugin CLAUDE.md).
 * The keys are the hues' roles in the drawings; two apps of one hue share a key.
 */
const v = (name: string) => `var(--vz-${name})`;

export const C = {
  /** The quiet blue of every secondary line and outline. */
  dim: v("dim"),
  /** Lighter dim: a conversation's second line, an outline seen from far. */
  haze: v("haze"),
  /** Darker dim: an empty tile's outline. */
  deep: v("deep"),
  /** The dotted rings of an orbit and the globe's grid. */
  ring: v("ring"),
  /** Your app; the page. */
  sky: v("sky"),
  /** The spark, the improve button: the accent. */
  azure: v("azure"),
  /** The file explorer, the side pane. */
  ice: v("ice"),
  teal: v("teal"),
  cyan: v("cyan"),
  aqua: v("aqua"),
  violet: v("violet"),
  indigo: v("indigo"),
  periwinkle: v("periwinkle"),
  blue: v("blue"),
  /** A heading's stroke: almost white. */
  pale: v("pale"),
  /** The idea's rays. */
  ray: v("ray"),
  /** City lights and a person's halo. */
  glow: v("glow"),
  /** A packet of light. */
  frost: v("frost"),
  white: v("white"),
  /** The ground a window's content sits on. */
  pop: v("pop"),
  /** A disc's radial gradient, centre to rim. */
  discCore: v("disc-core"),
  discMid: v("disc-mid"),
  discEdge: v("disc-edge"),
} as const;

export type Colour = (typeof C)[keyof typeof C];

/** The four primitive kinds a bead shows, by hue. */
export const HUE = {
  list: C.cyan,
  diff: C.blue,
  keys: C.sky,
  chip: C.teal,
} as const;
export type Kind = keyof typeof HUE;

/** Chapter 2's apps, each told by its colour. */
export const AC = {
  page: C.sky,
  map: C.teal,
  chat: C.violet,
  proto: C.indigo,
  file: C.ice,
  sonata: C.cyan,
  video: C.aqua,
} as const;

/** The OS's window colours, in the order windows take them. */
export const OS_COL = [
  C.sky,
  C.ice,
  C.teal,
  C.periwinkle,
  C.aqua,
  C.azure,
] as const;
