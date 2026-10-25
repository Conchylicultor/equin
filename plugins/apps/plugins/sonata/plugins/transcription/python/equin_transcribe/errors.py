"""One expected-failure type: the CLI prints its message as one line, exit 1."""

from pathlib import Path


class StError(Exception):
    """A failure the caller can act on (bad input, login required, ...)."""


def require_file(path: str, what: str) -> Path:
    p = Path(path)
    if not p.is_file():
        raise StError(f"{what} not found: {path}")
    return p


def out_dir(path: str) -> Path:
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    return p
