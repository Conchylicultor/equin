import { useEffect, useRef, useState } from "react";
import { createPreviewSeeker } from "../internal/preview-seeker";

/**
 * The frame at `time`, YouTube's scrub preview without a sprite sheet: a
 * second, muted `<video>` on the same file, seeked to the time under the
 * pointer one seek at a time (`createPreviewSeeker`), so the browser decodes
 * only the latest frame a scrub asks for. Mounted by the seek bar on the first
 * hover only, so a video nobody scrubs is never opened twice. A file the
 * preview cannot open draws no frame; the time bubble stays.
 */
export function SeekPreview({
  src,
  time,
  width,
  height,
}: {
  src: string;
  time: number;
  width: number;
  height: number;
}) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [failed, setFailed] = useState(false);
  const seeker = useRef<ReturnType<typeof createPreviewSeeker> | null>(null);
  const latest = useRef(time);

  useEffect(() => {
    latest.current = time;
    seeker.current?.seek(time);
  }, [time]);

  useEffect(() => {
    if (!video) return;
    const s = createPreviewSeeker(video);
    seeker.current = s;
    s.seek(latest.current);
    return () => {
      s.dispose();
      seeker.current = null;
    };
  }, [video]);

  if (failed) return null;
  return (
    <video
      ref={setVideo}
      className="mp-preview shadow-float"
      src={src}
      muted
      playsInline
      preload="metadata"
      aria-hidden
      tabIndex={-1}
      style={{ width, height }}
      onError={() => setFailed(true)}
    />
  );
}
