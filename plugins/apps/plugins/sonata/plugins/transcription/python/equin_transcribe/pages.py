"""st pages: PDF pages to PNG."""

import pypdfium2 as pdfium

from .errors import StError, out_dir, require_file


def pages(pdf: str, out: str, scale: float) -> None:
    src = require_file(pdf, "PDF")
    d = out_dir(out)
    try:
        doc = pdfium.PdfDocument(str(src))
    except pdfium.PdfiumError as err:
        raise StError(f"cannot open PDF {pdf}: {err}") from err
    n = len(doc)
    for i in range(n):
        doc[i].render(scale=scale).to_pil().convert("RGB").save(d / f"{i + 1:02d}.png")
    print(f"wrote {n} page(s) to {d} ({d / '01.png'} ...)")
