"""st fetch: video.mp4 + meta.json via yt-dlp."""

import json
import re

import av
from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError

from .errors import StError, out_dir

_LOGIN = re.compile(
    r"login|log in|sign in|cookies|empty media response|rate-limit|private|authentication",
    re.IGNORECASE,
)
_UNSUPPORTED = re.compile(r"unsupported url|no video formats|unable to extract", re.IGNORECASE)


def _clean(msg: str) -> str:
    msg = re.sub(r"\x1b\[[0-9;]*m", "", msg)
    return msg.replace("ERROR: ", "").strip().splitlines()[0]


class _Silent:
    """yt-dlp's logger: say nothing; failures surface as one `st:` line."""

    def debug(self, msg: str) -> None: ...
    def info(self, msg: str) -> None: ...
    def warning(self, msg: str) -> None: ...
    def error(self, msg: str) -> None: ...


def fetch(url: str, out: str, cookies_browser: str | None) -> None:
    d = out_dir(out)
    opts: dict = {
        "outtmpl": str(d / "video.%(ext)s"),
        # mp4 container that PyAV reads without ffmpeg's merger: prefer a single
        # progressive mp4, else the best pair merged only if ffmpeg exists.
        "format": "best[ext=mp4]/best",
        "merge_output_format": "mp4",
        "logger": _Silent(),
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
    }
    if cookies_browser:
        opts["cookiesfrombrowser"] = (cookies_browser,)
    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            path = ydl.prepare_filename(info)
    except DownloadError as err:
        msg = _clean(str(err))
        if _LOGIN.search(msg) and not cookies_browser:
            raise StError(
                f"login required ({msg}); retry with --cookies-from-browser chrome"
            ) from err
        if _UNSUPPORTED.search(msg):
            raise StError(f"unsupported or unextractable URL: {msg}") from err
        raise StError(msg) from err
    if not path.endswith(".mp4"):
        raise StError(f"downloaded {path}, not an mp4; no ffmpeg to remux")
    with av.open(path) as probe:
        video = probe.streams.video[0]
        width, height = video.codec_context.width, video.codec_context.height
        duration = float(probe.duration / av.time_base) if probe.duration else None
    meta = {
        "url": url,
        "title": info.get("title"),
        "caption": info.get("description"),
        "uploader": info.get("uploader") or info.get("channel"),
        "duration": info.get("duration") or duration,
        "width": width,
        "height": height,
    }
    (d / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))
    print(f"wrote {path} ({meta['width']}x{meta['height']}, {meta['duration']}s)")
    print(f"wrote {d / 'meta.json'} (title: {meta['title']!r})")
