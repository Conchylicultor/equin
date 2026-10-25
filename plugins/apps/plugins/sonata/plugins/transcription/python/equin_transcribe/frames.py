"""st frames: the sheet-music crops of a video, one per distinct content.

Sheet videos (an Instagram reel's top band, a screen-recorded score) hold a
stable, mostly-white, high-contrast region. Find it, then keep a crop whenever
its content differs from every crop kept so far (difference hash).
"""

import json
from collections.abc import Iterator
from dataclasses import dataclass

import av
import numpy as np
from PIL import Image

from .errors import StError, out_dir, require_file

HASH_SIDE = 16  # 16x16 difference hash = 256 bits


@dataclass(frozen=True)
class Region:
    x: int
    y: int
    w: int
    h: int

    def crop(self, img: np.ndarray) -> np.ndarray:
        return img[self.y : self.y + self.h, self.x : self.x + self.w]


def _samples(path: str, fps: float) -> Iterator[tuple[float, np.ndarray]]:
    """Decoded RGB frames at about `fps`, with their timestamps in seconds."""
    try:
        container = av.open(path)
    except av.error.FFmpegError as err:
        raise StError(f"cannot open video {path}: {err}") from err
    with container:
        stream = container.streams.video[0]
        next_t = 0.0
        for frame in container.decode(stream):
            t = float(frame.time) if frame.time is not None else 0.0
            if t + 1e-6 < next_t:
                continue
            next_t = t + 1.0 / fps
            yield t, frame.to_ndarray(format="rgb24")


def detect_region(samples: list[np.ndarray]) -> Region:
    """The tallest band of rows that are bright and stable across the video.

    A row belongs to the sheet when, in EVERY sampled frame, most of its pixels
    are near-white (the music itself changes between pages, the paper does
    not). The band is trimmed to the rows holding dark ink in any frame, plus a
    margin.
    """
    gray = np.stack([s.mean(axis=2) for s in samples])  # (n, H, W)
    height, width = gray.shape[1:]
    bright_frac = (gray > 200).mean(axis=2)  # (n, H)
    sheetish = bright_frac.min(axis=0) > 0.5
    best: tuple[int, int] | None = None
    start: int | None = None
    gap = 0
    for y in range(height + 1):
        on = y < height and bool(sheetish[y])
        if on:
            if start is None:
                start = y
            gap = 0
        elif start is not None:
            gap += 1
            if gap > max(2, height // 100) or y == height:
                end = y - gap + 1
                if best is None or end - start > best[1] - best[0]:
                    best = (start, end)
                start, gap = None, 0
    if best is None or best[1] - best[0] < height * 0.08:
        raise StError(
            "no stable white band found (sheet region); pass --region x,y,w,h"
        )
    y0, y1 = best
    ink = ((gray[:, y0:y1] < 110).mean(axis=2) > 0.003).any(axis=0)
    ink_rows = np.where(ink)[0]
    if len(ink_rows) == 0:
        raise StError("white band has no dark ink; pass --region x,y,w,h")
    margin = max(4, height // 100)
    y0, y1 = max(0, y0 + ink_rows[0] - margin), min(height, y0 + ink_rows[-1] + margin)
    return Region(0, int(y0), int(width), int(y1 - y0))


def parse_region(text: str, width: int, height: int) -> Region:
    try:
        x, y, w, h = (int(v) for v in text.split(","))
    except ValueError as err:
        raise StError(f"--region must be x,y,w,h integers, got {text!r}") from err
    if w <= 0 or h <= 0 or x < 0 or y < 0 or x + w > width or y + h > height:
        raise StError(f"--region {text} is outside the {width}x{height} frame")
    return Region(x, y, w, h)


def dhash(crop: np.ndarray) -> np.ndarray:
    img = Image.fromarray(crop).convert("L").resize((HASH_SIDE + 1, HASH_SIDE), Image.BILINEAR)
    a = np.asarray(img, dtype=np.int16)
    return (a[:, 1:] > a[:, :-1]).flatten()


def frames(
    video: str, out: str, region_arg: str | None, threshold: int, fps: float
) -> None:
    src = require_file(video, "video")
    d = out_dir(out)
    sampled = list(_samples(str(src), fps))
    if not sampled:
        raise StError(f"no video frames decoded from {video}")
    height, width = sampled[0][1].shape[:2]
    if region_arg is not None:
        region = parse_region(region_arg, width, height)
    else:
        step = max(1, len(sampled) // 24)
        region = detect_region([s for _, s in sampled[::step]])

    kept: list[tuple[float, np.ndarray]] = []
    entries: list[dict] = []
    for t, img in sampled:
        crop = region.crop(img)
        h = dhash(crop)
        if any(int((h != k).sum()) < threshold for _, k in kept):
            continue
        kept.append((t, h))
        name = f"{len(kept):02d}.png"
        Image.fromarray(crop).save(d / name)
        entries.append({"file": name, "t": round(t, 3)})
        if len(kept) == 1:
            Image.fromarray(img).save(d / "thumbnail.png")
    (d / "frames.json").write_text(
        json.dumps(
            {
                "video": {"width": width, "height": height},
                "region": {"x": region.x, "y": region.y, "w": region.w, "h": region.h},
                "threshold": threshold,
                "frames": entries,
            },
            indent=2,
        )
    )
    print(
        f"region x={region.x} y={region.y} w={region.w} h={region.h} "
        f"({'given' if region_arg else 'detected'}) of {width}x{height}"
    )
    print(f"wrote {len(entries)} crop(s) to {d} (01.png ..., thumbnail.png, frames.json)")
