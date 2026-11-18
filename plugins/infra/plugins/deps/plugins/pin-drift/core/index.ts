// Web-safe: the pinned-dependency drift value and its vocabulary. The check
// that fills it is `machine/`; the health row is `web/`.
export {
  pinDrift,
  PinDriftSchema,
  PinnedDepRowSchema,
  pinStayCommand,
  pinSwitchCommand,
} from "./internal/pin-drift";
export type {
  PinDrift,
  PinnedDepRow,
  PinnedInstallView,
  PinReviewView,
} from "./internal/pin-drift";
