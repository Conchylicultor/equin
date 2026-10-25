"""st render: MusicXML -> verovio SVG -> PNG (resvg, no system cairo)."""

import re

import resvg_py
import verovio

from .errors import StError, out_dir, require_file


def render(score: str, out: str, scale: float) -> None:
    src = require_file(score, "MusicXML file")
    d = out_dir(out)
    tk = verovio.toolkit()
    # A4 landscape-ish page, fit to width, so one PNG is a few systems.
    tk.setOptions(
        {
            "pageWidth": 2100,
            "pageHeight": 2970,
            "scale": 40,
            "adjustPageHeight": True,
            "footer": "none",
            "breaks": "auto",
        }
    )
    if not tk.loadFile(str(src)):
        raise StError(f"verovio could not parse {score} as MusicXML")
    n = tk.getPageCount()
    if n == 0:
        raise StError(f"{score} engraves to no pages (no music?)")
    for i in range(1, n + 1):
        svg = tk.renderToSVG(i)
        (d / f"{i:02d}.svg").write_text(svg)
        # verovio SVG may carry no background; resvg draws transparent -> white.
        png = resvg_py.svg_to_bytes(
            svg_string=svg, background="white", zoom=max(1, round(scale))
        )
        (d / f"{i:02d}.png").write_bytes(bytes(png))
    print(f"wrote {n} page(s) to {d} ({d / '01.png'} ...)")
