"""`st` — argument parsing and the one place failures become one-line errors."""

import argparse
import sys

from .errors import StError


def _fetch(a: argparse.Namespace) -> None:
    from .fetch import fetch

    fetch(a.url, a.out, a.cookies_from_browser)


def _frames(a: argparse.Namespace) -> None:
    from .frames import frames

    frames(a.video, a.out, a.region, a.threshold, a.fps)


def _pages(a: argparse.Namespace) -> None:
    from .pages import pages

    pages(a.pdf, a.out, a.scale)


def _render(a: argparse.Namespace) -> None:
    from .render import render

    render(a.score, a.out, a.scale)


def _side_by_side(a: argparse.Namespace) -> None:
    from .compare import side_by_side

    side_by_side(a.top, a.bottom, a.out)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="st", description="Sonata transcription tools.")
    sub = p.add_subparsers(dest="command", required=True)

    f = sub.add_parser("fetch", help="download a video + caption (yt-dlp)")
    f.add_argument("url")
    f.add_argument("--out", required=True)
    f.add_argument(
        "--cookies-from-browser",
        metavar="BROWSER",
        help="read login cookies from a browser (chrome, firefox, safari, ...)",
    )
    f.set_defaults(run=_fetch)

    fr = sub.add_parser("frames", help="extract the sheet-music crops from a video")
    fr.add_argument("video")
    fr.add_argument("--out", required=True)
    fr.add_argument("--region", help="x,y,w,h in pixels; skips detection")
    fr.add_argument(
        "--threshold",
        type=int,
        default=14,
        help="min differing bits (of 256) from every kept crop to keep a new one",
    )
    fr.add_argument("--fps", type=float, default=4.0, help="sampling rate")
    fr.set_defaults(run=_frames)

    pg = sub.add_parser("pages", help="render PDF pages to PNG")
    pg.add_argument("pdf")
    pg.add_argument("--out", required=True)
    pg.add_argument("--scale", type=float, default=2.0)
    pg.set_defaults(run=_pages)

    r = sub.add_parser("render", help="engrave MusicXML to PNG pages (verovio)")
    r.add_argument("score")
    r.add_argument("--out", required=True)
    r.add_argument("--scale", type=float, default=1.0, help="raster zoom")
    r.set_defaults(run=_render)

    s = sub.add_parser("side-by-side", help="stack one image over another")
    s.add_argument("top")
    s.add_argument("bottom")
    s.add_argument("--out", required=True)
    s.set_defaults(run=_side_by_side)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        args.run(args)
    except StError as err:
        print(f"st: {err}", file=sys.stderr)
        return 1
    return 0
