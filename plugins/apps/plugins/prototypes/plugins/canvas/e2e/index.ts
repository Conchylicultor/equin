/**
 * e2e barrel for the prototype canvas: the shared flows its own scripts use
 * (pick a prototype, open its canvas, find a frame by the published DOM
 * contract, read back what a frame's document shows), importable by another
 * plugin's e2e script as `@plugins/apps/plugins/prototypes/plugins/canvas/e2e`.
 */
export {
  pickPrototype,
  spreadableOption,
  openCanvas,
  addFrame,
  addSource,
  listFrames,
  letters,
  screen,
  card,
  canvasLayout,
  setLayout,
  frameDoc,
  frameValue,
  frameColor,
  hoverCard,
  frameAction,
  openOptions,
  optionRow,
  pickValue,
  dismiss,
  sizeChip,
  openSizeMenu,
  pickSize,
} from "./driver";
export type { FrameInfo, FrameDoc } from "./driver";
