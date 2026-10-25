"""st side-by-side: one image stacked over another."""

from pathlib import Path

from PIL import Image

from .errors import require_file


def side_by_side(top: str, bottom: str, out: str) -> None:
    a = Image.open(require_file(top, "image")).convert("RGB")
    b = Image.open(require_file(bottom, "image")).convert("RGB")
    width = max(a.width, b.width)
    gap = 12
    sheet = Image.new("RGB", (width, a.height + gap + b.height), (200, 60, 60))
    sheet.paste(a, (0, 0))
    sheet.paste(b, (0, a.height + gap))
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)
    print(f"wrote {out} ({sheet.width}x{sheet.height}: {top} over {bottom})")
