// Web-safe: the pinned-dependency drift value and its vocabulary. The check
// that fills it is `machine/`; the health row is `web/`.
export {
  pinDrift,
  PinDriftSchema,
  PinnedDepRowSchema,
  pinSwitchCommand,
} from "./internal/pin-drift";
export type {
  PinDrift,
  PinnedDepRow,
  PinnedInstallView,
} from "./internal/pin-drift";
