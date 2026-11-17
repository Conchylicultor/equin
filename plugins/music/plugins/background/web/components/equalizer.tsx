import "./equalizer.css";

/** Four bars, moving while `on`: music is playing. Decorative. */
export function Equalizer({ on }: { on: boolean }) {
  return (
    <span aria-hidden className="music-eq" data-on={on ? "" : undefined}>
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
